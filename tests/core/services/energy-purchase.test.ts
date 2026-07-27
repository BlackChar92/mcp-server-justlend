import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/core/services/wallet.js", () => ({
  getWalletAddress: vi.fn(),
  getSigningClient: vi.fn(),
  signTransactionWithWallet: vi.fn(),
}));

vi.mock("../../../src/core/services/clients.js", () => ({
  getTronWeb: vi.fn(),
}));

import {
  EnergyPurchaseApi,
  EnergyPurchaseError,
  type EnergyPaymentRisk,
  type EnergyPaymentRiskStore,
} from "../../../src/core/services/energy-purchase.js";
import { getSigningClient, getWalletAddress, signTransactionWithWallet } from "../../../src/core/services/wallet.js";
import { getTronWeb } from "../../../src/core/services/clients.js";

const PAYER = "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8";
const RECEIVER = "TVjsyZ7fYF3qLF6BQgPmTEZy1xrNNyVAAA";
const PAY_ADDRESS = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ code: "0", msg: "ok", data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function config() {
  return {
    min_energy: 65000,
    max_energy: 5000000,
    max_receivers: 50,
    durations: ["1h"],
    presets: [65000],
    resource_pool_addresses: [],
  };
}

class MemoryRiskStore implements EnergyPaymentRiskStore {
  risks: EnergyPaymentRisk[] = [];
  list(payerAddress: string) { return this.risks.filter(risk => risk.payerAddress === payerAddress); }
  save(risk: EnergyPaymentRisk) {
    this.risks = this.risks.filter(item => !(item.payerAddress === risk.payerAddress && item.signedTxId === risk.signedTxId));
    this.risks.push({ ...risk });
  }
  remove(payerAddress: string, signedTxId?: string) {
    this.risks = this.risks.filter(risk =>
      risk.payerAddress !== payerAddress || (signedTxId !== undefined && risk.signedTxId !== signedTxId),
    );
  }
}

function tronWebHarness() {
  const unsigned = { txID: "unsigned", raw_data: { expiration: 1000, contract: [] }, raw_data_hex: "00", visible: false };
  const extended = { ...unsigned, txID: "signed-id", raw_data: { ...unsigned.raw_data, expiration: 300001 } };
  return {
    transactionBuilder: {
      sendTrx: vi.fn(async () => unsigned),
      extendExpiration: vi.fn(async () => extended),
    },
    trx: {
      getBalance: vi.fn(async () => 10_000_000),
      getTransaction: vi.fn(async () => null),
    },
  };
}

describe("energy direct-purchase service", () => {
  const previousEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JUSTLEND_ALLOW_UNTRUSTED_HOSTS = "1";
    delete process.env.JUSTLEND_ENERGY_API_URL;
  });

  afterEach(() => {
    process.env = { ...previousEnv };
  });

  it("has no implicit production endpoint", () => {
    expect(() => new EnergyPurchaseApi()).toThrowError(EnergyPurchaseError);
  });

  it("validates a read-only quote against live config", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/v1/config")) return envelope(config());
      throw new Error(`unexpected ${input}`);
    });
    const api = new EnergyPurchaseApi({ baseUrl: "https://energy.example", fetch });

    await expect(api.quote([RECEIVER], 1)).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("signs without local broadcast and retries only the same signed transaction", async () => {
    const tronWeb = tronWebHarness();
    vi.mocked(getWalletAddress).mockResolvedValue(PAYER);
    vi.mocked(getSigningClient).mockResolvedValue(tronWeb as any);
    vi.mocked(getTronWeb).mockReturnValue(tronWeb as any);
    vi.mocked(signTransactionWithWallet).mockImplementation(async transaction => ({ ...transaction, signature: ["aa"] }));
    const store = new MemoryRiskStore();
    const submitted: string[] = [];
    let buyCalls = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/config")) return envelope(config());
      if (url.endsWith("/v1/price")) {
        return envelope({ amount_sun: 2405000, pay_address: PAY_ADDRESS, can_fulfill: true });
      }
      if (url.endsWith("/v1/consumer/energy/buy")) {
        submitted.push(JSON.parse(String(init?.body)).signed_transaction.txID);
        buyCalls += 1;
        if (buyCalls === 1) throw new Error("connection reset");
        return envelope({ id: 7, tx_id: "signed-id", access_token: "token", state: "paid" });
      }
      if (url.endsWith("/v1/consumer/energy/orders/7")) return envelope({ id: 7, state: "delivered" });
      throw new Error(`unexpected ${url}`);
    });
    const api = new EnergyPurchaseApi({
      baseUrl: "https://energy.example",
      fetch,
      riskStore: store,
      sleep: async () => {},
      now: () => 1,
    });

    const result = await api.purchase({
      receivers: [RECEIVER],
      energyPerReceiver: 65000,
      duration: "1h",
      expectedAmountSun: 2405000,
      network: "mainnet",
    });

    expect(submitted).toEqual(["signed-id", "signed-id"]);
    expect(signTransactionWithWallet).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, orderId: 7, txHash: "signed-id", state: "delivered" });
    expect(store.risks).toEqual([]);
    expect("sendRawTransaction" in tronWeb.trx).toBe(false);
  });

  it("retains an expired risk when the chain lookup is unavailable", async () => {
    const tronWeb = tronWebHarness();
    tronWeb.trx.getTransaction.mockRejectedValue(new Error("network unavailable"));
    vi.mocked(getTronWeb).mockReturnValue(tronWeb as any);
    const store = new MemoryRiskStore();
    store.risks.push({
      payerAddress: PAYER,
      signedTxId: "unknown-id",
      createdAt: 1,
      expiresAt: 2,
      paymentConfirmed: false,
    });
    const api = new EnergyPurchaseApi({
      baseUrl: "https://energy.example",
      fetch: vi.fn(),
      riskStore: store,
      now: () => 3,
    });

    await expect(api.reconcilePaymentRisks(PAYER)).resolves.toHaveLength(1);
  });
});
