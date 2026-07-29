import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { TronWeb } from "tronweb";
import { fetchWithTimeout } from "./http.js";
import { getSigningClient, getWalletAddress, signTransactionWithWallet } from "./wallet.js";
import { getTronWeb } from "./clients.js";

export const ENERGY_PURCHASE_PATHS = {
  config: "/v1/config",
  currentPrice: "/v1/price/current",
  poolHealth: "/v1/pool/health",
  quote: "/v1/price",
  buy: "/v1/consumer/energy/buy",
  order: (id: string | number) => `/v1/consumer/energy/orders/${encodeURIComponent(String(id))}`,
  history: "/v1/consumer/energy/orders/history",
} as const;

export const ENERGY_PURCHASE_TERMINAL_STATES = ["delivered", "partial", "failed", "expired", "cancelled"];

const ORDER_TTL_MS = 5 * 60 * 1000;
const PAYMENT_RETRY_TIMEOUT_MS = 2 * 60 * 1000;
const PAYMENT_INTENT_TTL_MS = 30 * 60 * 1000;
const RISK_FILE = path.join(os.homedir(), ".mcp-server-justlend", "energy-payment-risks.json");
const activePayers = new Set<string>();

export class EnergyPurchaseError extends Error {
  code: string;
  status?: number;
  isBusinessError: boolean;
  retryable: boolean;
  details?: unknown;
  paymentRisk?: EnergyPaymentRisk;

  constructor(code: string, message?: string, options: {
    status?: number;
    isBusinessError?: boolean;
    retryable?: boolean;
    details?: unknown;
    cause?: unknown;
  } = {}) {
    super(message ? `${code}: ${message}` : code, { cause: options.cause });
    this.name = "EnergyPurchaseError";
    this.code = code;
    this.status = options.status;
    this.isBusinessError = options.isBusinessError === true;
    this.retryable = options.retryable === true;
    this.details = options.details;
  }
}

export interface EnergyPurchaseConfig {
  min_energy: number;
  max_energy: number;
  max_receivers: number;
  presets?: number[];
  activation_fee_sun?: number;
  usage_window_minutes?: number;
  durations: string[];
  resource_pool_addresses?: string[];
  [key: string]: unknown;
}

export interface EnergyPurchaseQuote {
  amount_sun: number;
  pay_address: string;
  can_fulfill: boolean;
  max_single_order_energy?: number;
  items?: unknown[];
  [key: string]: unknown;
}

export interface EnergyPaymentRisk {
  payerAddress: string;
  signedTxId: string;
  createdAt: number;
  expiresAt: number;
  paymentConfirmed: boolean;
}

export interface EnergyPaymentRiskStore {
  list(payerAddress: string): EnergyPaymentRisk[];
  save(risk: EnergyPaymentRisk): void;
  remove(payerAddress: string, signedTxId?: string): void;
  /** Acquire an atomic payer-scoped intent before any transaction is signed. */
  acquireIntent(payerAddress: string, expiresAt: number): string;
  /** Release only the intent owned by token. */
  releaseIntent(payerAddress: string, token: string): void;
}

export class FileEnergyPaymentRiskStore implements EnergyPaymentRiskStore {
  constructor(private readonly filePath = RISK_FILE) {}

  private readAll(): EnergyPaymentRisk[] {
    let source: string;
    try {
      source = fs.readFileSync(this.filePath, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new EnergyPurchaseError(
        "PAYMENT_RISK_STORE_UNAVAILABLE",
        "Unable to read the payment-risk store. New payments are blocked until it is repaired.",
        { cause },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (cause) {
      throw new EnergyPurchaseError(
        "PAYMENT_RISK_STORE_INVALID",
        "The payment-risk store contains invalid JSON. New payments are blocked until it is repaired.",
        { cause },
      );
    }
    if (!Array.isArray(parsed) || !parsed.every(isEnergyPaymentRisk)) {
      throw new EnergyPurchaseError(
        "PAYMENT_RISK_STORE_INVALID",
        "The payment-risk store has an invalid schema. New payments are blocked until it is repaired.",
      );
    }
    return parsed;
  }

  private writeAll(risks: EnergyPaymentRisk[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(risks, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.filePath);
  }

  list(payerAddress: string): EnergyPaymentRisk[] {
    return this.readAll().filter(risk => risk.payerAddress === payerAddress);
  }

  save(risk: EnergyPaymentRisk): void {
    const remaining = this.readAll().filter(item =>
      !(item.payerAddress === risk.payerAddress && item.signedTxId === risk.signedTxId),
    );
    remaining.push(risk);
    this.writeAll(remaining);
  }

  remove(payerAddress: string, signedTxId?: string): void {
    const remaining = this.readAll().filter(risk =>
      risk.payerAddress !== payerAddress || (signedTxId !== undefined && risk.signedTxId !== signedTxId),
    );
    this.writeAll(remaining);
  }

  private intentPath(payerAddress: string): string {
    return `${this.filePath}.${payerAddress}.intent`;
  }

  acquireIntent(payerAddress: string, expiresAt: number): string {
    validateAddress(payerAddress, "payerAddress");
    const intentPath = this.intentPath(payerAddress);
    fs.mkdirSync(path.dirname(intentPath), { recursive: true, mode: 0o700 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = randomUUID();
      let descriptor: number;
      try {
        descriptor = fs.openSync(intentPath, "wx", 0o600);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new EnergyPurchaseError(
            "PAYMENT_INTENT_LOCK_UNAVAILABLE",
            "Unable to create the payment-intent lock. New payments are blocked.",
            { cause },
          );
        }
        const existing = this.readIntent(intentPath);
        if (existing.expiresAt > Date.now()) {
          throw new EnergyPurchaseError(
            "PAYMENT_IN_PROGRESS",
            "Another energy payment is already in progress for this payer.",
            { retryable: true },
          );
        }
        try {
          fs.unlinkSync(intentPath);
        } catch (unlinkCause) {
          if ((unlinkCause as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new EnergyPurchaseError(
              "PAYMENT_INTENT_LOCK_UNAVAILABLE",
              "Unable to clear an expired payment-intent lock. New payments are blocked.",
              { cause: unlinkCause },
            );
          }
        }
        continue;
      }

      try {
        fs.writeFileSync(descriptor, JSON.stringify({ payerAddress, token, createdAt: Date.now(), expiresAt }));
        fs.fsyncSync(descriptor);
      } catch (cause) {
        try { fs.closeSync(descriptor); } catch { /* Preserve the original persistence error. */ }
        try { fs.unlinkSync(intentPath); } catch { /* Best effort after a failed exclusive create. */ }
        throw new EnergyPurchaseError(
          "PAYMENT_INTENT_LOCK_UNAVAILABLE",
          "Unable to persist the payment-intent lock. New payments are blocked.",
          { cause },
        );
      }
      try {
        fs.closeSync(descriptor);
      } catch (cause) {
        try { fs.unlinkSync(intentPath); } catch { /* Best effort after a failed exclusive create. */ }
        throw new EnergyPurchaseError(
          "PAYMENT_INTENT_LOCK_UNAVAILABLE",
          "Unable to finalize the payment-intent lock. New payments are blocked.",
          { cause },
        );
      }
      return token;
    }

    throw new EnergyPurchaseError(
      "PAYMENT_INTENT_LOCK_UNAVAILABLE",
      "Unable to acquire the payment-intent lock after clearing an expired lock.",
    );
  }

  releaseIntent(payerAddress: string, token: string): void {
    const intentPath = this.intentPath(payerAddress);
    let existing: EnergyPaymentIntent;
    try {
      existing = this.readIntent(intentPath);
    } catch (cause) {
      if ((cause as EnergyPurchaseError).code === "PAYMENT_INTENT_LOCK_MISSING") return;
      throw cause;
    }
    if (existing.token !== token) {
      throw new EnergyPurchaseError(
        "PAYMENT_INTENT_LOCK_LOST",
        "The payment-intent lock owner changed unexpectedly. The current lock was preserved.",
      );
    }
    try {
      fs.unlinkSync(intentPath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new EnergyPurchaseError(
        "PAYMENT_INTENT_LOCK_UNAVAILABLE",
        "Unable to release the payment-intent lock. New payments remain blocked.",
        { cause },
      );
    }
  }

  private readIntent(intentPath: string): EnergyPaymentIntent {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(intentPath, "utf8"));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        throw new EnergyPurchaseError("PAYMENT_INTENT_LOCK_MISSING", "The payment-intent lock does not exist.");
      }
      throw new EnergyPurchaseError(
        "PAYMENT_INTENT_LOCK_INVALID",
        "The payment-intent lock cannot be read safely. New payments are blocked.",
        { cause },
      );
    }
    if (!isEnergyPaymentIntent(parsed)) {
      throw new EnergyPurchaseError(
        "PAYMENT_INTENT_LOCK_INVALID",
        "The payment-intent lock has an invalid schema. New payments are blocked.",
      );
    }
    return parsed;
  }
}

interface EnergyPaymentIntent {
  payerAddress: string;
  token: string;
  createdAt: number;
  expiresAt: number;
}

function isEnergyPaymentRisk(value: unknown): value is EnergyPaymentRisk {
  const risk = value as Partial<EnergyPaymentRisk> | null;
  return Boolean(
    risk && typeof risk.payerAddress === "string" && isValidTronAddress(risk.payerAddress) &&
    typeof risk.signedTxId === "string" && risk.signedTxId.length > 0 &&
    Number.isSafeInteger(risk.createdAt) && Number(risk.createdAt) >= 0 &&
    Number.isSafeInteger(risk.expiresAt) && Number(risk.expiresAt) > 0 &&
    typeof risk.paymentConfirmed === "boolean",
  );
}

function isEnergyPaymentIntent(value: unknown): value is EnergyPaymentIntent {
  const intent = value as Partial<EnergyPaymentIntent> | null;
  return Boolean(
    intent && typeof intent.payerAddress === "string" && isValidTronAddress(intent.payerAddress) &&
    typeof intent.token === "string" && intent.token.length > 0 &&
    Number.isSafeInteger(intent.createdAt) && Number(intent.createdAt) >= 0 &&
    Number.isSafeInteger(intent.expiresAt) && Number(intent.expiresAt) > 0,
  );
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface EnergyPurchaseApiOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  riskStore?: EnergyPaymentRiskStore;
  requestTimeoutMs?: number;
  paymentRetryIntervalMs?: number;
  paymentRetryTimeoutMs?: number;
  orderPollIntervalMs?: number;
  orderPollTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function envFlag(name: string): boolean {
  const value = process.env[name]?.toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function resolveBaseUrl(explicit?: string): string {
  const value = explicit || process.env.JUSTLEND_ENERGY_API_URL;
  if (!value) {
    throw new EnergyPurchaseError(
      "CONFIG_MISSING",
      "Set JUSTLEND_ENERGY_API_URL. No production or protocol API fallback is configured.",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new EnergyPurchaseError("CONFIG_INVALID", "JUSTLEND_ENERGY_API_URL must be a valid URL.", { cause });
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  const insecureLocalAllowed = local && url.protocol === "http:" && envFlag("JUSTLEND_ALLOW_INSECURE_HOSTS");
  if (url.protocol !== "https:" && !insecureLocalAllowed) {
    throw new EnergyPurchaseError("CONFIG_INVALID", "Energy purchase API must use HTTPS.");
  }
  // Until the official production hostname is supplied, every host is custom and requires explicit trust.
  if (!envFlag("JUSTLEND_ALLOW_UNTRUSTED_HOSTS")) {
    throw new EnergyPurchaseError(
      "UNTRUSTED_HOST",
      "The configured energy purchase API is not yet in the official allowlist; set JUSTLEND_ALLOW_UNTRUSTED_HOSTS=1 only after verifying it.",
    );
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

function validateAddress(address: string, label: string): void {
  if (!isValidTronAddress(address)) {
    throw new EnergyPurchaseError("INVALID_ADDRESS", `${label} must be a Base58Check TRON address.`);
  }
}

function isValidTronAddress(address: string): boolean {
  return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address) && TronWeb.isAddress(address);
}

function positiveInteger(value: unknown, label: string): number {
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue <= 0) {
    throw new EnergyPurchaseError("INVALID_AMOUNT", `${label} must be a positive safe integer.`);
  }
  return numberValue;
}

function validateQuoteInput(receivers: string[], energyPerReceiver: number, config: EnergyPurchaseConfig): void {
  if (!Array.isArray(receivers) || receivers.length === 0) {
    throw new EnergyPurchaseError("EMPTY_RECEIVERS", "At least one receiver is required.");
  }
  receivers.forEach((receiver, index) => validateAddress(receiver, `receivers[${index}]`));
  const energy = positiveInteger(energyPerReceiver, "energyPerReceiver");
  const min = positiveInteger(config?.min_energy, "config.min_energy");
  const max = positiveInteger(config?.max_energy, "config.max_energy");
  const maxReceivers = positiveInteger(config?.max_receivers, "config.max_receivers");
  if (max < min) throw new EnergyPurchaseError("INVALID_RESPONSE", "API returned max_energy below min_energy.");
  if (energy < min || energy > max) {
    throw new EnergyPurchaseError("INVALID_AMOUNT", `Energy per receiver must be between ${min} and ${max}.`);
  }
  if (receivers.length > maxReceivers) {
    throw new EnergyPurchaseError("ADDR_OVERFLOW", `A maximum of ${maxReceivers} receivers is allowed.`);
  }
  const resourcePools = new Set(config.resource_pool_addresses || []);
  if (receivers.some(receiver => resourcePools.has(receiver))) {
    throw new EnergyPurchaseError("INVALID_RECEIVERS", "Resource-pool addresses cannot receive purchased energy.");
  }
}

function normalizeSignedTransaction(value: unknown): Record<string, any> {
  const signed = (value as Record<string, any>)?.signedTransaction || value as Record<string, any>;
  if (
    !signed || typeof signed.txID !== "string" || !signed.raw_data ||
    !Array.isArray(signed.signature) || signed.signature.length !== 1
  ) {
    throw new EnergyPurchaseError(
      "INVALID_SIGNED_TX",
      "Signer must return one signed TRX transfer with txID, raw_data, and exactly one signature.",
    );
  }
  return signed;
}

export class EnergyPurchaseApi {
  readonly baseUrl: string;
  private readonly fetchImpl?: FetchLike;
  private readonly riskStore: EnergyPaymentRiskStore;
  private readonly requestTimeoutMs: number;
  private readonly paymentRetryIntervalMs: number;
  private readonly paymentRetryTimeoutMs: number;
  private readonly orderPollIntervalMs: number;
  private readonly orderPollTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: EnergyPurchaseApiOptions = {}) {
    this.baseUrl = resolveBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch;
    this.riskStore = options.riskStore || new FileEnergyPaymentRiskStore();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 8000;
    this.paymentRetryIntervalMs = options.paymentRetryIntervalMs ?? 5000;
    this.paymentRetryTimeoutMs = options.paymentRetryTimeoutMs ?? PAYMENT_RETRY_TIMEOUT_MS;
    this.orderPollIntervalMs = options.orderPollIntervalMs ?? 3000;
    this.orderPollTimeoutMs = options.orderPollTimeoutMs ?? 150000;
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.now = options.now || Date.now;
  }

  private async request<T>(method: string, apiPath: string, options: {
    body?: unknown;
    token?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {}): Promise<T> {
    let response: Response;
    try {
      const init: RequestInit = {
        method,
        headers: {
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(options.token ? { "X-Consumer-Order-Token": options.token } : {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
      };
      response = this.fetchImpl
        ? await this.fetchImpl(`${this.baseUrl}${apiPath}`, init)
        : await fetchWithTimeout(`${this.baseUrl}${apiPath}`, init, options.timeoutMs ?? this.requestTimeoutMs);
    } catch (cause) {
      throw new EnergyPurchaseError("NETWORK_ERROR", "Energy purchase API request returned no response.", {
        retryable: true,
        cause,
      });
    }
    let envelope: { code?: string; msg?: string; data?: T };
    try {
      envelope = await response.json() as typeof envelope;
    } catch (cause) {
      throw new EnergyPurchaseError("INVALID_RESPONSE", "Energy purchase API returned non-JSON data.", {
        status: response.status,
        retryable: response.status >= 500,
        cause,
      });
    }
    if (envelope.code !== "0") {
      const business = typeof envelope.code === "string" && envelope.code.length > 0;
      throw new EnergyPurchaseError(business ? String(envelope.code).toUpperCase() : "INVALID_RESPONSE", envelope.msg, {
        status: response.status,
        isBusinessError: business,
        retryable: !business && response.status >= 500,
      });
    }
    if (!response.ok) {
      throw new EnergyPurchaseError("HTTP_ERROR", `Energy purchase API returned HTTP ${response.status}.`, {
        status: response.status,
        retryable: response.status >= 500,
      });
    }
    return envelope.data as T;
  }

  getConfig(): Promise<EnergyPurchaseConfig> {
    return this.request("GET", ENERGY_PURCHASE_PATHS.config);
  }

  getCurrentPrice(): Promise<Record<string, unknown>> {
    return this.request("GET", ENERGY_PURCHASE_PATHS.currentPrice);
  }

  getPoolHealth(): Promise<Record<string, unknown>> {
    return this.request("GET", ENERGY_PURCHASE_PATHS.poolHealth);
  }

  async quote(receivers: string[], energyPerReceiver: number, config?: EnergyPurchaseConfig): Promise<EnergyPurchaseQuote> {
    const liveConfig = config || await this.getConfig();
    validateQuoteInput(receivers, energyPerReceiver, liveConfig);
    const quote = await this.request<EnergyPurchaseQuote>("POST", ENERGY_PURCHASE_PATHS.quote, {
      body: { receivers, energy_per_receiver: energyPerReceiver },
    });
    if (
      typeof quote?.can_fulfill !== "boolean" || !Number.isSafeInteger(Number(quote?.amount_sun)) ||
      Number(quote.amount_sun) <= 0 || typeof quote.pay_address !== "string"
    ) {
      throw new EnergyPurchaseError("INVALID_RESPONSE", "Energy purchase quote is missing required fields.");
    }
    validateAddress(quote.pay_address, "quote pay_address");
    if (!quote.can_fulfill) {
      throw new EnergyPurchaseError("POOL_INSUFFICIENT", "No single resource pool can fulfill the quote.", {
        isBusinessError: true,
        details: {
          requiredEnergy: receivers.length * energyPerReceiver,
          maxSingleOrderEnergy: quote.max_single_order_energy ?? null,
        },
      });
    }
    return quote;
  }

  getOrder(orderId: string | number, token?: string): Promise<Record<string, any>> {
    if (String(orderId).length === 0) throw new EnergyPurchaseError("INVALID_ORDER_ID", "orderId is required.");
    return this.request("GET", ENERGY_PURCHASE_PATHS.order(orderId), { token });
  }

  getHistory(address: string, options: { page?: number; size?: number } = {}): Promise<Record<string, any>> {
    validateAddress(address, "history address");
    const query = new URLSearchParams({ address });
    if (options.size !== undefined) {
      query.set("page", String(positiveInteger(options.page ?? 1, "page")));
      query.set("size", String(positiveInteger(options.size, "size")));
    }
    return this.request("GET", `${ENERGY_PURCHASE_PATHS.history}?${query}`);
  }

  getPaymentRisks(payerAddress: string): EnergyPaymentRisk[] {
    validateAddress(payerAddress, "payerAddress");
    return this.riskStore.list(payerAddress);
  }

  private async lookupTransaction(
    tronWeb: TronWeb,
    txId: string,
  ): Promise<"found" | "not_found" | "unavailable"> {
    try {
      const transaction = await tronWeb.trx.getTransaction(txId) as { txID?: string } | undefined;
      return transaction?.txID === txId ? "found" : "not_found";
    } catch (error) {
      return String((error as Error)?.message || error).toLowerCase().includes("transaction not found")
        ? "not_found"
        : "unavailable";
    }
  }

  async reconcilePaymentRisks(payerAddress: string, network = "mainnet"): Promise<EnergyPaymentRisk[]> {
    const tronWeb = getTronWeb(network);
    const risks = this.getPaymentRisks(payerAddress);
    let history: Record<string, any> | null = null;
    for (const risk of risks) {
      const lookup = await this.lookupTransaction(tronWeb, risk.signedTxId);
      if (lookup === "found") {
        risk.paymentConfirmed = true;
        this.riskStore.save(risk);
        history ||= await this.getHistory(payerAddress).catch(() => null);
        const rows = Array.isArray(history?.rows) ? history.rows : [];
        if (rows.some(row => row.payment_tx_id === risk.signedTxId)) {
          this.riskStore.remove(payerAddress, risk.signedTxId);
        }
      } else if (lookup === "not_found" && this.now() >= risk.expiresAt) {
        this.riskStore.remove(payerAddress, risk.signedTxId);
      }
    }
    return this.riskStore.list(payerAddress);
  }

  private async buildAndSignPayment(
    tronWeb: TronWeb,
    payerAddress: string,
    payAddress: string,
    amountSun: number,
    network: string,
  ): Promise<Record<string, any>> {
    validateAddress(payerAddress, "payerAddress");
    validateAddress(payAddress, "payAddress");
    const safeAmount = positiveInteger(amountSun, "amountSun");
    let unsigned = await tronWeb.transactionBuilder.sendTrx(payAddress, safeAmount, payerAddress) as Record<string, any>;
    if (unsigned?.raw_data?.expiration && tronWeb.transactionBuilder.extendExpiration) {
      const seconds = Math.ceil((this.now() + ORDER_TTL_MS - Number(unsigned.raw_data.expiration)) / 1000);
      if (seconds > 0) {
        try {
          const candidate = { ...unsigned, raw_data: { ...unsigned.raw_data } };
          unsigned = await tronWeb.transactionBuilder.extendExpiration(candidate as any, seconds, { txLocal: true }) as Record<string, any>;
        } catch {
          // The shorter node-provided expiration remains a safe fallback.
        }
      }
    }
    const description = `Pay ${safeAmount / 1e6} TRX for JustLend energy. Sign only; the configured backend broadcasts.`;
    return normalizeSignedTransaction(await signTransactionWithWallet(unsigned, description, network));
  }

  private async pollOrder(orderId: string | number, token?: string): Promise<Record<string, any> | null> {
    const deadline = this.now() + this.orderPollTimeoutMs;
    let detail: Record<string, any> | null = null;
    while (this.now() < deadline) {
      try {
        detail = await this.getOrder(orderId, token);
        if (ENERGY_PURCHASE_TERMINAL_STATES.includes(detail.state)) return detail;
      } catch {
        // Payment is already accepted; tolerate transient order-query failures until the deadline.
      }
      await this.sleep(this.orderPollIntervalMs);
    }
    return detail;
  }

  async purchase(input: {
    receivers: string[];
    energyPerReceiver: number;
    duration: string;
    expectedAmountSun: number;
    network?: string;
  }): Promise<Record<string, unknown>> {
    const payerAddress = await getWalletAddress();
    validateAddress(payerAddress, "payerAddress");
    if (activePayers.has(payerAddress)) {
      throw new EnergyPurchaseError(
        "PAYMENT_IN_PROGRESS",
        "Another energy payment is already in progress for this payer.",
        { retryable: true },
      );
    }

    activePayers.add(payerAddress);
    let intentToken: string | undefined;
    try {
      intentToken = this.riskStore.acquireIntent(payerAddress, Date.now() + PAYMENT_INTENT_TTL_MS);
      return await this.purchaseWithIntent(input, payerAddress);
    } finally {
      try {
        if (intentToken !== undefined) this.riskStore.releaseIntent(payerAddress, intentToken);
      } finally {
        activePayers.delete(payerAddress);
      }
    }
  }

  private async purchaseWithIntent(input: {
    receivers: string[];
    energyPerReceiver: number;
    duration: string;
    expectedAmountSun: number;
    network?: string;
  }, payerAddress: string): Promise<Record<string, unknown>> {
    const network = input.network || "mainnet";
    const tronWeb = await getSigningClient(network);
    const existing = await this.reconcilePaymentRisks(payerAddress, network);
    if (existing.length) {
      const error = new EnergyPurchaseError(
        "PAYMENT_RISK_UNRESOLVED",
        "A previous payment has an unknown result. Inspect history/chain state before signing another payment.",
      );
      error.paymentRisk = existing[0];
      throw error;
    }

    const config = await this.getConfig();
    const durations = Array.isArray(config.durations) ? config.durations.filter(item => typeof item === "string" && item.trim()) : [];
    if (!durations.includes(input.duration)) {
      throw new EnergyPurchaseError("INVALID_DURATION", "duration must come from the live /v1/config durations list.");
    }
    const quote = await this.quote(input.receivers, input.energyPerReceiver, config);
    const confirmedAmount = positiveInteger(input.expectedAmountSun, "expectedAmountSun");
    if (quote.amount_sun !== confirmedAmount) {
      throw new EnergyPurchaseError("AMOUNT_CHANGED", "The authoritative quote differs from the user-confirmed amount.", {
        details: { expectedAmountSun: confirmedAmount, amountSun: quote.amount_sun },
      });
    }
    const balanceSun = BigInt(await tronWeb.trx.getBalance(payerAddress));
    if (balanceSun < BigInt(quote.amount_sun)) {
      throw new EnergyPurchaseError(
        "INSUFFICIENT_BALANCE",
        `Payment requires ${quote.amount_sun / 1e6} TRX before bandwidth cost.`,
      );
    }

    const signed = await this.buildAndSignPayment(tronWeb, payerAddress, quote.pay_address, quote.amount_sun, network);
    const signedDeadline = Number.isFinite(Number(signed.raw_data?.expiration))
      ? Number(signed.raw_data.expiration)
      : this.now() + ORDER_TTL_MS;
    const retryDeadline = Math.min(signedDeadline, this.now() + this.paymentRetryTimeoutMs);
    const risk: EnergyPaymentRisk = {
      payerAddress,
      signedTxId: signed.txID,
      createdAt: this.now(),
      expiresAt: signedDeadline,
      paymentConfirmed: false,
    };

    let order: Record<string, any> | null = null;
    while (!order) {
      this.riskStore.save(risk);
      try {
        order = await this.request("POST", ENERGY_PURCHASE_PATHS.buy, {
          body: {
            receivers: input.receivers,
            energy_per_receiver: input.energyPerReceiver,
            duration: input.duration,
            payer_address: payerAddress,
            signed_transaction: signed,
          },
        });
      } catch (error) {
        const typed = error as EnergyPurchaseError;
        if (typed.isBusinessError) {
          if (typed.code === "TX_ALREADY_CLAIMED") {
            risk.paymentConfirmed = true;
            this.riskStore.save(risk);
            typed.paymentRisk = risk;
          } else {
            this.riskStore.remove(payerAddress, signed.txID);
          }
          throw typed;
        }
        if (this.now() >= retryDeadline) {
          if (await this.lookupTransaction(tronWeb, signed.txID) === "found") {
            risk.paymentConfirmed = true;
            this.riskStore.save(risk);
            return { ok: true, orderId: null, txHash: signed.txID, state: "pending", confirmedOnChain: true };
          }
          const unknown = new EnergyPurchaseError(
            "PAYMENT_RESULT_UNKNOWN",
            "Payment result is unknown. Do not create another signed payment until this risk is reconciled.",
            { cause: typed },
          );
          unknown.paymentRisk = risk;
          throw unknown;
        }
        await this.sleep(this.paymentRetryIntervalMs);
      }
    }

    this.riskStore.remove(payerAddress, signed.txID);
    const orderId = order.id;
    const txHash = order.tx_id || signed.txID;
    const detail = await this.pollOrder(orderId, order.access_token);
    const state = detail?.state || order.state || "pending";
    if (state === "failed" || state === "expired") {
      throw new EnergyPurchaseError("DELIVERY_FAILED", "Payment was accepted but energy delivery failed.", {
        details: { orderId, txHash, state, detail },
      });
    }
    return { ok: true, orderId, txHash, state, detail };
  }
}

let defaultApi: EnergyPurchaseApi | null = null;
function api(): EnergyPurchaseApi {
  defaultApi ||= new EnergyPurchaseApi();
  return defaultApi;
}

export async function getEnergyPurchaseConfig() {
  const [config, price, pool] = await Promise.all([api().getConfig(), api().getCurrentPrice(), api().getPoolHealth()]);
  return { config, price, pool };
}

export const quoteEnergyPurchase = (receivers: string[], energyPerReceiver: number) =>
  api().quote(receivers, energyPerReceiver);

export const getEnergyPurchaseOrder = (orderId: string | number, token?: string) => api().getOrder(orderId, token);

export const getEnergyPurchaseHistory = (address: string, page = 1, size = 20) =>
  api().getHistory(address, { page, size });

export const getEnergyPaymentRisks = (address: string, network = "mainnet") =>
  api().reconcilePaymentRisks(address, network);

export const buyEnergyDirect = (input: {
  receivers: string[];
  energyPerReceiver: number;
  duration: string;
  expectedAmountSun: number;
  network?: string;
}) => api().purchase(input);

export function resetEnergyPurchaseApiForTests(): void {
  defaultApi = null;
}
