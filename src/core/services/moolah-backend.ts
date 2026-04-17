/**
 * JustLend V2 (Moolah) — REST backend API client.
 * Wraps https://zenvora.ablesdxd.link endpoints used by the frontend (V2backend.js).
 * All functions are read-only; no wallet or signing required.
 */
import { fetchWithTimeout } from "./http.js";
import { getMoolahApiHost } from "../chains.js";

// ── Response types ────────────────────────────────────────────────────────────

export interface MoolahUserPosition {
  totalSupplyUSD: string;
  totalBorrowUSD: string;
  netWorthUSD:    string;
  healthFactor?:  string;   // "∞" when no borrows
  risk?:          string;   // debt / (collateral × lltv), numeric string
  vaultList?:     MoolahUserVaultPosition[];
  marketList?:    MoolahUserMarketPosition[];
}

export interface MoolahUserVaultPosition {
  vaultAddress:    string;
  underlyingSymbol: string;
  sharesBalance:   string;
  assetsBalance:   string;
  assetsUSD:       string;
  supplyAPY:       string;
}

export interface MoolahUserMarketPosition {
  marketId:        string;
  loanToken:       string;
  collateralToken: string;
  borrowAmount:    string;
  borrowAmountUSD: string;
  collateralAmount:    string;
  collateralAmountUSD: string;
  safePercent:     string;   // 0-100+, percentage of LLTV used
  healthFactor:    string;
}

export interface MoolahPositionHistory {
  timestamp: number;
  supplyUSD: string;
  borrowUSD: string;
  netWorthUSD: string;
}

// ── Vault types ───────────────────────────────────────────────────────────────

export interface MoolahVaultListParams {
  sort?:      string;
  order?:     "asc" | "desc";
  deposit?:   string;   // filter by deposit token symbol
  collateral?: string;  // filter by collateral token symbol
  keyword?:   string;
  page?:      number;
  pageSize?:  number;
}

export interface MoolahVaultInfo {
  vaultAddress:    string;
  underlyingSymbol: string;
  underlyingAddress: string;
  totalAssets:     string;   // human-readable underlying amount
  totalAssetsUSD:  string;
  supplyAPY:       string;   // e.g. "8.42"
  totalSupplyShares: string;
  curatorAddress?: string;
}

export interface MoolahVaultApyHistory {
  timestamp: number;
  apy:       string;
}

export interface MoolahVaultAllocationItem {
  marketId:        string;
  loanToken:       string;
  collateralToken: string;
  allocatedAssets: string;
  allocatedUSD:    string;
  cap?:            string;
}

export interface MoolahUserVaultBalance {
  vaultAddress:   string;
  sharesBalance:  string;
  assetsBalance:  string;   // converted using current exchange rate
  assetsUSD:      string;
  maxWithdraw:    string;
}

export interface MoolahVaultListResponse {
  total:  number;
  list:   MoolahVaultInfo[];
}

export interface MoolahVaultAllocationResponse {
  total: number;
  list:  MoolahVaultAllocationItem[];
}

// ── Market types ──────────────────────────────────────────────────────────────

export interface MoolahMarketListParams {
  sort?:      string;
  order?:     "asc" | "desc";
  deposit?:   string;
  collateral?: string;
  keyword?:   string;
  page?:      number;
  pageSize?:  number;
}

export interface MoolahMarketInfo {
  marketId:        string;
  loanToken:       string;
  loanTokenSymbol: string;
  collateralToken:        string;
  collateralTokenSymbol:  string;
  oracle:          string;
  irm:             string;
  lltv:            string;   // percentage, e.g. "75"
  borrowAPY:       string;
  supplyAPY:       string;
  totalSupplyAssets:  string;
  totalBorrowAssets:  string;
  utilization:     string;   // percentage
  liquidityUSD:    string;
}

export interface MoolahMarketApyHistory {
  timestamp: number;
  borrowAPY: string;
  supplyAPY: string;
  utilization: string;
}

export interface MoolahUserMarketPositionDetail {
  marketId:            string;
  loanToken:           string;
  collateralToken:     string;
  supplyShares:        string;
  supplyAssets:        string;
  supplyUSD:           string;
  borrowShares:        string;
  borrowAssets:        string;
  borrowUSD:           string;
  collateralAssets:    string;
  collateralUSD:       string;
  safePercent:         string;
  healthFactor:        string;
  maxBorrowUSD:        string;
  maxRedeemCollateral: string;
}

export interface MoolahMarketListResponse {
  total: number;
  list:  MoolahMarketInfo[];
}

// ── Liquidation types ─────────────────────────────────────────────────────────

export interface MoolahLiquidationListParams {
  sort?:         string;
  order?:        "asc" | "desc";
  page?:         number;
  pageSize?:     number;
  minRiskLevel?: number;  // 0.0–∞; >1.0 means liquidatable
  maxRiskLevel?: number;
  debt?:         string;  // filter by loan token symbol
  collateral?:   string;  // filter by collateral token symbol
}

export interface MoolahPendingLiquidation {
  borrower:           string;
  marketId:           string;
  loanToken:          string;
  loanTokenSymbol:    string;
  collateralToken:    string;
  collateralTokenSymbol: string;
  borrowAssets:       string;
  borrowUSD:          string;
  collateralAssets:   string;
  collateralUSD:      string;
  riskLevel:          string;   // numeric string; >1 = liquidatable
  maxSeizableAssets?: string;
}

export interface MoolahLiquidationRecord {
  txHash:          string;
  blockTime:       number;
  borrower:        string;
  liquidator:      string;
  marketId:        string;
  loanToken:       string;
  collateralToken: string;
  repaidAssets:    string;
  seizedAssets:    string;
  type:            "bot" | "public";
}

export interface MoolahPendingLiquidationResponse {
  total: number;
  list:  MoolahPendingLiquidation[];
}

export interface MoolahLiquidationRecordResponse {
  total: number;
  list:  MoolahLiquidationRecord[];
}

// ── Transaction records ───────────────────────────────────────────────────────

export interface MoolahTransactionRecord {
  txHash:     string;
  blockTime:  number;
  action:     string;   // "supply" | "withdraw" | "borrow" | "repay" | "supplyCollateral" | etc.
  token:      string;
  amount:     string;
  amountUSD:  string;
  marketId?:  string;
  vaultAddress?: string;
}

export interface MoolahRecordResponse {
  total: number;
  list:  MoolahTransactionRecord[];
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiGet<T>(
  path: string,
  params: Record<string, any> = {},
  network = "mainnet",
): Promise<T> {
  const base = getMoolahApiHost(network);
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  const url = qs ? `${base}${path}?${qs}` : `${base}${path}`;

  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    throw new Error(`Moolah API ${res.status} ${res.statusText} — ${path}`);
  }

  const json = await res.json();

  // Common envelope patterns: { data: ... } or { retCode, data: ... } or raw
  if (json !== null && typeof json === "object") {
    if (json.data !== undefined)   return json.data as T;
    if (json.result !== undefined) return json.result as T;
  }
  return json as T;
}

// ── User: overview ────────────────────────────────────────────────────────────

/** Aggregated V2 position for a user (vaults + markets combined). */
export async function fetchMoolahUserPosition(
  userAddress: string,
  network = "mainnet",
): Promise<MoolahUserPosition> {
  return apiGet<MoolahUserPosition>("/index/position", { address: userAddress }, network);
}

/** Historical net-worth / supply / borrow curve for a user. */
export async function fetchMoolahUserPositionHistory(
  userAddress: string,
  timeFilter: "ONE_DAY" | "ONE_WEEK" | "ONE_MONTH" = "ONE_DAY",
  network = "mainnet",
): Promise<MoolahPositionHistory[]> {
  return apiGet<MoolahPositionHistory[]>(
    "/index/history-records",
    { userAddress, timeFilter },
    network,
  );
}

// ── Vault endpoints ───────────────────────────────────────────────────────────

/** Paginated list of all Moolah vaults with APY and TVL. */
export async function fetchMoolahVaultList(
  params: MoolahVaultListParams = {},
  network = "mainnet",
): Promise<MoolahVaultListResponse> {
  return apiGet<MoolahVaultListResponse>("/index/vault/list", { pageSize: 20, page: 0, ...params }, network);
}

/** Detailed metadata for a single vault. */
export async function fetchMoolahVaultInfo(
  vaultAddress: string,
  network = "mainnet",
): Promise<MoolahVaultInfo> {
  return apiGet<MoolahVaultInfo>("/vault/info", { address: vaultAddress }, network);
}

/** Historical APY time series for a vault. */
export async function fetchMoolahVaultApyHistory(
  vaultAddress: string,
  network = "mainnet",
): Promise<MoolahVaultApyHistory[]> {
  return apiGet<MoolahVaultApyHistory[]>("/vault/history-data", { vaultAddress }, network);
}

/** Markets the vault allocates funds to, with caps and amounts. */
export async function fetchMoolahVaultAllocation(
  vaultAddress: string,
  params: { sort?: string; order?: "asc" | "desc"; page?: number; pageSize?: number } = {},
  network = "mainnet",
): Promise<MoolahVaultAllocationResponse> {
  return apiGet<MoolahVaultAllocationResponse>(
    "/vault/allocation",
    { address: vaultAddress, pageSize: 20, page: 0, ...params },
    network,
  );
}

/** A specific user's share balance and current asset value in a vault. */
export async function fetchMoolahUserVaultPosition(
  vaultAddress: string,
  userAddress: string,
  network = "mainnet",
): Promise<MoolahUserVaultBalance> {
  return apiGet<MoolahUserVaultBalance>("/vault/position", { vaultAddress, address: userAddress }, network);
}

// ── Market endpoints ──────────────────────────────────────────────────────────

/** Paginated list of all Moolah markets with rates and liquidity. */
export async function fetchMoolahMarketList(
  params: MoolahMarketListParams = {},
  network = "mainnet",
): Promise<MoolahMarketListResponse> {
  return apiGet<MoolahMarketListResponse>("/index/market/list", { pageSize: 20, page: 0, ...params }, network);
}

/** Full metadata for a single market by marketId (bytes32 hex). */
export async function fetchMoolahMarketInfo(
  marketId: string,
  network = "mainnet",
): Promise<MoolahMarketInfo> {
  return apiGet<MoolahMarketInfo>("/market/marketInfo", { marketId }, network);
}

/** Historical borrow/supply APY and utilization curve for a market. */
export async function fetchMoolahMarketApyHistory(
  marketId: string,
  network = "mainnet",
): Promise<MoolahMarketApyHistory[]> {
  return apiGet<MoolahMarketApyHistory[]>("/market/history-data", { marketId }, network);
}

/** Vaults that supply liquidity to a given market. */
export async function fetchMoolahMarketVaultList(
  marketId: string,
  network = "mainnet",
): Promise<MoolahVaultInfo[]> {
  return apiGet<MoolahVaultInfo[]>("/market/vault-list", { marketId }, network);
}

/** A specific user's position in a market (includes risk metrics). */
export async function fetchMoolahUserMarketPosition(
  marketId: string,
  userAddress: string,
  network = "mainnet",
): Promise<MoolahUserMarketPositionDetail> {
  return apiGet<MoolahUserMarketPositionDetail>(
    "/market/position",
    { market: marketId, address: userAddress },
    network,
  );
}

// ── Liquidation endpoints ─────────────────────────────────────────────────────

/** Paginated list of positions eligible for liquidation. */
export async function fetchMoolahPendingLiquidations(
  params: MoolahLiquidationListParams = {},
  network = "mainnet",
): Promise<MoolahPendingLiquidationResponse> {
  return apiGet<MoolahPendingLiquidationResponse>(
    "/liquidate/pendingLiquidations",
    { pageSize: 20, page: 0, ...params },
    network,
  );
}

/** Historical liquidation events (bot and public liquidators). */
export async function fetchMoolahLiquidationRecords(
  params: {
    type?: "bot" | "public";
    debt?: string;
    collateral?: string;
    page?: number;
    pageSize?: number;
  } = {},
  network = "mainnet",
): Promise<MoolahLiquidationRecordResponse> {
  return apiGet<MoolahLiquidationRecordResponse>(
    "/liquidate/records",
    { pageSize: 20, page: 0, ...params },
    network,
  );
}

// ── Transaction record endpoint ───────────────────────────────────────────────

/** A user's V2 transaction history (supply, borrow, repay, etc.). */
export async function fetchMoolahUserRecords(
  userAddress: string,
  params: { pageNo?: number; pageSize?: number } = {},
  network = "mainnet",
): Promise<MoolahRecordResponse> {
  return apiGet<MoolahRecordResponse>(
    "/record/lend",
    { address: userAddress, pageNo: 0, pageSize: 20, ...params },
    network,
  );
}
