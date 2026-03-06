/**
 * JustLend V1 Lending Operations
 *
 * VERSION: JustLend V1
 * All lending methods (supply, withdraw, borrow, repay, collateral management) are for JustLend V1.
 * Based on Compound V2 protocol architecture with jToken (cToken) mechanism.
 *
 * Core operations:
 * - Supply/Mint: Deposit assets to receive jTokens
 * - Withdraw/Redeem: Burn jTokens to receive underlying assets
 * - Borrow: Take loans against supplied collateral
 * - Repay: Return borrowed assets
 * - Enter/Exit Market: Enable/disable assets as collateral
 */

import { getTronWeb, getWallet } from "./clients.js";
import { getJustLendAddresses, getJTokenInfo, getAllJTokens, type JTokenInfo } from "../chains.js";
import { JTOKEN_ABI, JTRX_MINT_ABI, JTRX_REPAY_ABI, COMPTROLLER_ABI, TRC20_ABI, PRICE_ORACLE_ABI } from "../abis.js";

const MAX_UINT256 = "115792089237316195423570985008687907853269984665640564039457584007913129639935";

/**
 * Wait for a transaction to be confirmed. Returns transaction info.
 */
async function waitForTx(txID: string, network: string, maxRetries = 20, intervalMs = 3000): Promise<any> {
  const { getTronWeb } = await import("./clients.js");
  const tronWeb = getTronWeb(network);

  for (let i = 0; i < maxRetries; i++) {
    try {
      const info = await tronWeb.trx.getTransactionInfo(txID);
      if (info && info.id) return info;
    } catch { /* not found yet */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Transaction ${txID} not confirmed after ${maxRetries * intervalMs / 1000}s`);
}

function resolveJToken(symbolOrAddress: string, network: string): JTokenInfo {
  const info = getJTokenInfo(symbolOrAddress, network);
  if (!info) throw new Error(`Unknown jToken market: ${symbolOrAddress}. Use get_supported_markets to list available markets.`);
  return info;
}

// ============================================================================
// SUPPLY (Mint jTokens)
// ============================================================================

/**
 * Supply (deposit) assets into a JustLend V1 market.
 *
 * VERSION: V1 - Uses JustLend V1 mint() function (Compound V2-style)
 *
 * For TRC20 tokens: requires prior approve() of underlying to jToken contract.
 * For TRX: sends TRX as callValue.
 *
 * @param privateKey - Wallet private key
 * @param jTokenSymbol - e.g. "jUSDT", "jTRX"
 * @param amount - Amount in underlying token units (human-readable, e.g. "100.5")
 * @param network - Network name
 * @returns Transaction ID
 */
export async function supply(
  privateKey: string,
  jTokenSymbol: string,
  amount: string,
  network = "mainnet",
): Promise<{ txID: string; jTokenSymbol: string; amount: string; message: string }> {
  const info = resolveJToken(jTokenSymbol, network);
  const tronWeb = getWallet(privateKey, network);
  const amountRaw = BigInt(Math.floor(parseFloat(amount) * 10 ** info.underlyingDecimals));

  if (info.underlyingSymbol === "TRX" || !info.underlying) {
    // jTRX: mint() is payable, amount via callValue (in Sun)
    const contract = tronWeb.contract(JTRX_MINT_ABI, info.address);
    const txID = await contract.methods.mint().send({ callValue: amountRaw.toString() });
    return { txID, jTokenSymbol, amount, message: `Supplied ${amount} TRX to ${jTokenSymbol}` };
  } else {
    // TRC20: first check/do approval, then mint(amount)
    const contract = tronWeb.contract(JTOKEN_ABI, info.address);
    const txID = await contract.methods.mint(amountRaw.toString()).send();
    return { txID, jTokenSymbol, amount, message: `Supplied ${amount} ${info.underlyingSymbol} to ${jTokenSymbol}` };
  }
}

// ============================================================================
// WITHDRAW (Redeem jTokens)
// ============================================================================

/**
 * Withdraw assets from a JustLend V1 market.
 *
 * VERSION: V1 - Uses JustLend V1 redeemUnderlying() function (Compound V2-style)
 *
 * @param privateKey - Wallet private key
 * @param jTokenSymbol - e.g. "jUSDT"
 * @param amount - Amount in underlying units to withdraw (human-readable)
 * @param network - Network name
 */
export async function withdraw(
  privateKey: string,
  jTokenSymbol: string,
  amount: string,
  network = "mainnet",
): Promise<{ txID: string; jTokenSymbol: string; amount: string; message: string }> {
  const info = resolveJToken(jTokenSymbol, network);
  const tronWeb = getWallet(privateKey, network);
  const amountRaw = BigInt(Math.floor(parseFloat(amount) * 10 ** info.underlyingDecimals));

  const contract = tronWeb.contract(JTOKEN_ABI, info.address);
  const txID = await contract.methods.redeemUnderlying(amountRaw.toString()).send();
  return { txID, jTokenSymbol, amount, message: `Withdrew ${amount} ${info.underlyingSymbol} from ${jTokenSymbol}` };
}

/**
 * Withdraw ALL supply from a V1 market by redeeming all jTokens.
 *
 * VERSION: V1 - Uses JustLend V1 redeem() function
 */
export async function withdrawAll(
  privateKey: string,
  jTokenSymbol: string,
  network = "mainnet",
): Promise<{ txID: string; jTokenSymbol: string; message: string }> {
  const info = resolveJToken(jTokenSymbol, network);
  const tronWeb = getWallet(privateKey, network);

  const contract = tronWeb.contract(JTOKEN_ABI, info.address);
  const walletAddress = tronWeb.defaultAddress.base58;
  const jTokenBalance = await contract.methods.balanceOf(walletAddress).call();

  if (BigInt(jTokenBalance) === 0n) {
    throw new Error(`No ${jTokenSymbol} balance to withdraw`);
  }

  const txID = await contract.methods.redeem(jTokenBalance.toString()).send();
  return { txID, jTokenSymbol, message: `Withdrew all supply from ${jTokenSymbol}` };
}

// ============================================================================
// BORROW
// ============================================================================

/**
 * Borrow assets from a JustLend V1 market.
 *
 * VERSION: V1 - Uses JustLend V1 borrow() function (Compound V2-style)
 * Requires the user to have collateral enabled (enterMarkets) and sufficient liquidity.
 */
export async function borrow(
  privateKey: string,
  jTokenSymbol: string,
  amount: string,
  network = "mainnet",
): Promise<{ txID: string; jTokenSymbol: string; amount: string; message: string }> {
  const info = resolveJToken(jTokenSymbol, network);
  const tronWeb = getWallet(privateKey, network);
  const amountRaw = BigInt(Math.floor(parseFloat(amount) * 10 ** info.underlyingDecimals));
  const walletAddress = tronWeb.defaultAddress.base58;

  // Check borrowing capacity by manually computing collateral breakdown.
  // For each collateral market: adjustedCollateral = supplyBalance * exchangeRate * price * collateralFactor
  // totalBorrowable (USD) = sum(adjustedCollateral) - sum(existingBorrows in USD)
  // Then convert to target token units via oracle price.
  const addresses = getJustLendAddresses(network);
  const comptroller = tronWeb.contract(COMPTROLLER_ABI, addresses.comptroller);
  const oracle = tronWeb.contract(PRICE_ORACLE_ABI, addresses.priceOracle);

  // Get collateral markets the user has entered
  const assetsIn: string[] = await comptroller.methods.getAssetsIn(walletAddress).call();

  if (assetsIn.length === 0) {
    throw new Error(
      `No borrowing capacity. You need to supply assets and enable them as collateral (enter_market) before borrowing.`
    );
  }

  // Compute collateral breakdown for each entered market
  interface CollateralDetail {
    symbol: string;
    supplyBalance: number;    // human-readable underlying units
    supplyValueUSD: number;
    collateralFactor: number; // e.g. 0.75
    adjustedValueUSD: number; // supplyValueUSD * collateralFactor
    borrowBalanceUSD: number; // existing borrow in this market
  }

  const MANTISSA_18 = BigInt(1e18);
  const collateralDetails: CollateralDetail[] = [];
  let totalAdjustedCollateralUSD = 0;
  let totalBorrowUSD = 0;

  for (const asset of assetsIn) {
    try {
      const assetInfo = getJTokenInfo(asset, network);
      const jToken = tronWeb.contract(JTOKEN_ABI, asset);
      const snapshot = await jToken.methods.getAccountSnapshot(walletAddress).call();

      const jTokenBalance = BigInt(snapshot[1] ?? snapshot.jTokenBalance ?? 0);
      const borrowBalance = BigInt(snapshot[2] ?? snapshot.borrowBalance ?? 0);
      const exchangeRateMantissa = BigInt(snapshot[3] ?? snapshot.exchangeRateMantissa ?? 0);

      // supplyBalance in underlying raw units = jTokenBalance * exchangeRate / 1e18
      const supplyBalanceRaw = jTokenBalance * exchangeRateMantissa / MANTISSA_18;

      // Get oracle price (scaled to 36 - underlyingDecimals)
      const assetPriceRaw = BigInt(await oracle.methods.getUnderlyingPrice(asset).call());
      const assetDecimals = assetInfo ? assetInfo.underlyingDecimals : 18;
      const assetPriceScale = 10 ** (36 - assetDecimals);
      const assetPriceUSD = Number(assetPriceRaw) / assetPriceScale;

      // Get collateral factor
      const marketInfo = await comptroller.methods.markets(asset).call();
      const cf = Number(BigInt(marketInfo.collateralFactorMantissa || marketInfo[1])) / 1e18;

      const supplyBalance = Number(supplyBalanceRaw) / 10 ** assetDecimals;
      const supplyValueUSD = supplyBalance * assetPriceUSD;
      const adjustedValueUSD = supplyValueUSD * cf;
      const borrowBalanceUSD = Number(borrowBalance) / 10 ** assetDecimals * assetPriceUSD;

      totalAdjustedCollateralUSD += adjustedValueUSD;
      totalBorrowUSD += borrowBalanceUSD;

      const label = assetInfo ? assetInfo.underlyingSymbol : asset;
      collateralDetails.push({
        symbol: label,
        supplyBalance,
        supplyValueUSD,
        collateralFactor: cf,
        adjustedValueUSD,
        borrowBalanceUSD,
      });
    } catch { /* skip unavailable markets */ }
  }

  const availableLiquidityUSD = totalAdjustedCollateralUSD - totalBorrowUSD;

  if (availableLiquidityUSD <= 0) {
    const breakdown = collateralDetails.map(d =>
      `${d.symbol}: supply=$${d.supplyValueUSD.toFixed(2)} × CF ${(d.collateralFactor * 100).toFixed(0)}% = $${d.adjustedValueUSD.toFixed(2)}` +
      (d.borrowBalanceUSD > 0 ? `, borrow=$${d.borrowBalanceUSD.toFixed(2)}` : "")
    ).join("; ");

    throw new Error(
      `No borrowing capacity. Total adjusted collateral: $${totalAdjustedCollateralUSD.toFixed(2)}, ` +
      `total borrows: $${totalBorrowUSD.toFixed(2)}, available: $${availableLiquidityUSD.toFixed(2)}. ` +
      `Breakdown: [${breakdown}]. ` +
      `Supply more collateral or repay existing borrows first.`
    );
  }

  // Get target token price to convert USD liquidity to token amount
  const priceRaw = BigInt(await oracle.methods.getUnderlyingPrice(info.address).call());

  if (priceRaw === 0n) {
    throw new Error(`Cannot fetch price for ${info.underlyingSymbol}. Unable to verify borrowing capacity.`);
  }

  const priceScale = BigInt(10) ** BigInt(36 - info.underlyingDecimals);
  const targetPriceUSD = Number(priceRaw) / Number(priceScale);
  const maxBorrowable = availableLiquidityUSD / targetPriceUSD;
  const maxBorrowableRaw = BigInt(Math.floor(maxBorrowable * 10 ** info.underlyingDecimals));

  if (amountRaw > maxBorrowableRaw) {
    const breakdown = collateralDetails.map(d =>
      `${d.symbol}: supply=$${d.supplyValueUSD.toFixed(2)} × CF ${(d.collateralFactor * 100).toFixed(0)}% = $${d.adjustedValueUSD.toFixed(2)}` +
      (d.borrowBalanceUSD > 0 ? `, borrow=$${d.borrowBalanceUSD.toFixed(2)}` : "")
    ).join("; ");

    throw new Error(
      `Insufficient borrowing capacity. Requested: ${amount} ${info.underlyingSymbol} (~$${(parseFloat(amount) * targetPriceUSD).toFixed(2)}), ` +
      `max borrowable: ~${maxBorrowable.toFixed(info.underlyingDecimals > 6 ? 6 : info.underlyingDecimals)} ${info.underlyingSymbol} ` +
      `(~$${availableLiquidityUSD.toFixed(2)}). ` +
      `${info.underlyingSymbol} price: $${targetPriceUSD.toFixed(6)}. ` +
      `Collateral breakdown: [${breakdown}]. ` +
      `Supply more collateral or reduce borrow amount.`
    );
  }

  const contract = tronWeb.contract(JTOKEN_ABI, info.address);
  const txID = await contract.methods.borrow(amountRaw.toString()).send();
  return { txID, jTokenSymbol, amount, message: `Borrowed ${amount} ${info.underlyingSymbol} from ${jTokenSymbol}` };
}

// ============================================================================
// REPAY
// ============================================================================

/**
 * Repay borrowed assets to a JustLend V1 market.
 *
 * VERSION: V1 - Uses JustLend V1 repayBorrow() function (Compound V2-style)
 *
 * For TRC20: requires approval of underlying to jToken.
 * For TRX: sends callValue.
 * Use amount = "-1" or "max" to repay full borrow balance.
 */
export async function repay(
  privateKey: string,
  jTokenSymbol: string,
  amount: string,
  network = "mainnet",
): Promise<{ txID: string; jTokenSymbol: string; amount: string; message: string }> {
  const info = resolveJToken(jTokenSymbol, network);
  const tronWeb = getWallet(privateKey, network);

  const isMax = amount === "-1" || amount.toLowerCase() === "max";

  // Check borrow balance first — avoid wasting energy if there's nothing to repay
  const contract = tronWeb.contract(JTOKEN_ABI, info.address);
  const walletAddress = tronWeb.defaultAddress.base58;
  const borrowBal = BigInt(await contract.methods.borrowBalanceStored(walletAddress).call());

  if (borrowBal === 0n) {
    throw new Error(`No outstanding ${info.underlyingSymbol} borrow on ${jTokenSymbol}. Nothing to repay.`);
  }

  if (info.underlyingSymbol === "TRX" || !info.underlying) {
    // Add a small buffer (0.1%) for accrued interest
    const repayAmount = isMax
      ? borrowBal + borrowBal / 1000n
      : BigInt(Math.floor(parseFloat(amount) * 10 ** info.underlyingDecimals));

    // jTRX repayBorrow() is payable with no args — need separate ABI (like jTRX mint)
    const trxContract = tronWeb.contract(JTRX_REPAY_ABI, info.address);
    const txID = await trxContract.methods.repayBorrow().send({ callValue: repayAmount.toString() });
    return { txID, jTokenSymbol, amount: isMax ? "max" : amount, message: `Repaid ${isMax ? "all" : amount} TRX to ${jTokenSymbol}` };
  } else {
    const repayAmount = isMax ? MAX_UINT256 : BigInt(Math.floor(parseFloat(amount) * 10 ** info.underlyingDecimals)).toString();
    const txID = await contract.methods.repayBorrow(repayAmount).send();
    return { txID, jTokenSymbol, amount: isMax ? "max" : amount, message: `Repaid ${isMax ? "all" : amount} ${info.underlyingSymbol} to ${jTokenSymbol}` };
  }
}

// ============================================================================
// COLLATERAL MANAGEMENT (Enter/Exit Markets)
// ============================================================================

/**
 * Enable a jToken market as collateral in V1 Comptroller.
 *
 * VERSION: V1 - Uses JustLend V1 enterMarkets() function
 */
export async function enterMarket(
  privateKey: string,
  jTokenSymbol: string,
  network = "mainnet",
): Promise<{ txID: string; message: string }> {
  const info = resolveJToken(jTokenSymbol, network);
  const tronWeb = getWallet(privateKey, network);
  const addresses = getJustLendAddresses(network);

  const comptroller = tronWeb.contract(COMPTROLLER_ABI, addresses.comptroller);
  const txID = await comptroller.methods.enterMarkets([info.address]).send();
  return { txID, message: `Enabled ${jTokenSymbol} as collateral` };
}

/**
 * Disable a jToken market as collateral in V1 Comptroller.
 *
 * VERSION: V1 - Uses JustLend V1 exitMarket() function
 * Will fail if it would make the account undercollateralized.
 */
export async function exitMarket(
  privateKey: string,
  jTokenSymbol: string,
  network = "mainnet",
): Promise<{ txID: string; message: string }> {
  const info = resolveJToken(jTokenSymbol, network);
  const tronWeb = getWallet(privateKey, network);
  const addresses = getJustLendAddresses(network);

  const comptroller = tronWeb.contract(COMPTROLLER_ABI, addresses.comptroller);
  const txID = await comptroller.methods.exitMarket(info.address).send();
  return { txID, message: `Disabled ${jTokenSymbol} as collateral` };
}

// ============================================================================
// APPROVE (TRC20 underlying for jToken)
// ============================================================================

/**
 * Approve a V1 jToken contract to spend underlying TRC20 tokens.
 *
 * VERSION: V1 - Approves underlying token for JustLend V1 jToken contracts
 * Required before supply() or repay() for TRC20-backed markets.
 *
 * @param amount - Amount to approve (human-readable), or "max" for unlimited
 */
export async function approveUnderlying(
  privateKey: string,
  jTokenSymbol: string,
  amount: string = "max",
  network = "mainnet",
): Promise<{ txID: string; message: string }> {
  const info = resolveJToken(jTokenSymbol, network);
  if (!info.underlying) throw new Error(`${jTokenSymbol} is native TRX — no approval needed`);

  const tronWeb = getWallet(privateKey, network);
  const token = tronWeb.contract(TRC20_ABI, info.underlying);

  const approveAmount = amount.toLowerCase() === "max"
    ? MAX_UINT256
    : BigInt(Math.floor(parseFloat(amount) * 10 ** info.underlyingDecimals)).toString();

  const txID = await token.methods.approve(info.address, approveAmount).send();
  return { txID, message: `Approved ${amount === "max" ? "unlimited" : amount} ${info.underlyingSymbol} for ${jTokenSymbol}` };
}

// ============================================================================
// CLAIM REWARDS
// ============================================================================

/**
 * Claim accrued JustLend rewards for the connected wallet.
 */
export async function claimRewards(
  privateKey: string,
  network = "mainnet",
): Promise<{ txID: string; message: string }> {
  const tronWeb = getWallet(privateKey, network);
  const addresses = getJustLendAddresses(network);
  const walletAddress = tronWeb.defaultAddress.base58;

  const comptroller = tronWeb.contract(COMPTROLLER_ABI, addresses.comptroller);
  const txID = await comptroller.methods.claimReward(walletAddress).send();
  return { txID, message: `Claimed JustLend rewards for ${walletAddress}` };
}

// ============================================================================
// RESOURCE ESTIMATION (Energy + Bandwidth + TRX Cost)
// ============================================================================

/**
 * Typical resource costs for JustLend operations (based on historical on-chain data).
 * Energy: computational cost. Bandwidth: transaction size cost.
 * Used as fallback when triggerConstantContract simulation reverts.
 */
const TYPICAL_RESOURCES: Record<string, { energy: number; bandwidth: number }> = {
  approve:        { energy: 23000,  bandwidth: 265 },
  supply_trx:     { energy: 80000,  bandwidth: 280 },
  supply_trc20:   { energy: 100000, bandwidth: 310 },
  withdraw:       { energy: 90000,  bandwidth: 300 },
  withdraw_all:   { energy: 90000,  bandwidth: 300 },
  borrow:         { energy: 100000, bandwidth: 313 },
  repay_trx:      { energy: 80000,  bandwidth: 280 },
  repay_trc20:    { energy: 90000,  bandwidth: 320 },
  enter_market:   { energy: 80000,  bandwidth: 300 },
  exit_market:    { energy: 50000,  bandwidth: 280 },
  claim_rewards:  { energy: 60000,  bandwidth: 330 },
};

/** Current TRON mainnet resource prices (SUN per unit). May change via governance votes. */
const RESOURCE_PRICES = {
  energyPriceSun: 100,     // 100 SUN per energy unit
  bandwidthPriceSun: 1000, // 1000 SUN per bandwidth point
  freeBandwidthPerDay: 600, // free bandwidth for activated accounts
  sunPerTRX: 1_000_000,
};

interface StepEstimate {
  step: string;
  description: string;
  energyEstimate: number;
  /** Base energy (energyEstimate - energyPenalty). Only meaningful when energyPenalty > 0. */
  energyBase: number;
  /** Dynamic energy penalty for high-traffic contracts. Included in energyEstimate. */
  energyPenalty: number;
  bandwidthEstimate: number;
  energySource: "simulation" | "typical";
  simulationError?: string;
}

export interface ResourceEstimation {
  operation: string;
  market: string;
  steps: StepEstimate[];
  totalEnergy: number;
  totalBandwidth: number;
  /** Estimated TRX cost if all energy is paid by burning TRX (no staked energy). */
  estimatedTRXCost: string;
  /** Breakdown of TRX cost */
  costBreakdown: {
    energyCostTRX: string;
    bandwidthCostTRX: string;
    note: string;
  };
  note: string;
}

/** Bandwidth overhead constants (matching TronLink implementation) */
const DATA_HEX_PROTOBUF_EXTRA = 3;
const SIGNATURE_PER_BANDWIDTH = 67;
const MAX_RESULT_SIZE_IN_TX = 64;

/**
 * Encode ABI parameters to hex string for direct API calls.
 */
function encodeParams(
  tronWeb: any,
  params: Array<{ type: string; value: any }>,
): string {
  if (!params || params.length === 0) return "";
  try {
    const types = params.map(p => p.type);
    const values = params.map(p => p.value);
    const hex = tronWeb.utils.abi.encodeParams(types, values);
    return typeof hex === "string" && hex.startsWith("0x") ? hex.slice(2) : hex;
  } catch {
    return "";
  }
}

/**
 * Helper: estimate energy and bandwidth for a contract call.
 *
 * Follows TronLink's approach:
 * 1. Try estimateEnergy API (most accurate, includes dynamic energy penalty).
 * 2. Call triggerconstantcontract via fullNode.request (like TronLink does) to get
 *    energy_used (already includes energy_penalty) and bandwidth from raw_data_hex.
 * 3. If both fail, return null to trigger typical-value fallback.
 *
 * IMPORTANT: energy_used from triggerconstantcontract already includes energy_penalty.
 * energy_penalty is a breakdown field, NOT an additional cost. (Ref: TronLink TransferCost)
 */
async function trySimulateEnergy(
  tronWeb: any,
  ownerAddress: string,
  contractAddress: string,
  functionSelector: string,
  params: Array<{ type: string; value: any }>,
  options: any = {},
  _network = "mainnet",
): Promise<{ energy: number | null; energyPenalty: number; bandwidth: number | null; error?: string }> {
  const parameter = encodeParams(tronWeb, params);
  const callValue = options.callValue ? parseInt(options.callValue.toString(), 10) : 0;

  // Build request body for direct API call (like TronLink)
  const requestBody: Record<string, any> = {
    owner_address: tronWeb.address.toHex(ownerAddress),
    contract_address: tronWeb.address.toHex(contractAddress),
    function_selector: functionSelector,
    parameter,
    call_value: callValue,
    visible: false,
  };

  // Run both estimation methods in parallel
  const [estimateResult, simResult] = await Promise.allSettled([
    tronWeb.transactionBuilder.estimateEnergy(
      contractAddress,
      functionSelector,
      options,
      params,
      ownerAddress,
    ),
    tronWeb.fullNode.request('wallet/triggerconstantcontract', requestBody, 'post'),
  ]);

  const estimateData = estimateResult.status === "fulfilled" ? estimateResult.value : null;
  const simData = simResult.status === "fulfilled" ? simResult.value : null;

  // estimateEnergy returns energy_required (includes dynamic penalty)
  const estimatedEnergy = (estimateData?.energy_required > 0) ? estimateData.energy_required : null;

  let energy: number | null = null;
  let energyPenalty = 0;
  let bandwidth: number | null = null;
  let error: string | undefined;

  if (simData?.result?.result) {
    // energy_used already includes energy_penalty (TronLink confirmed)
    const simEnergy = simData.energy_used || 0;
    energyPenalty = simData.energy_penalty || 0;

    // Prefer estimateEnergy result (more accurate when available), fallback to triggerconstantcontract
    energy = estimatedEnergy ?? simEnergy;

    // Bandwidth: match TronLink's calculation
    try {
      const rawDataHex = simData.transaction?.raw_data_hex;
      if (rawDataHex) {
        const rawDataBytes = Buffer.byteLength(rawDataHex, 'hex');
        bandwidth = rawDataBytes + DATA_HEX_PROTOBUF_EXTRA + SIGNATURE_PER_BANDWIDTH + MAX_RESULT_SIZE_IN_TX;
      }
    } catch { /* ignore */ }
  } else {
    // Simulation failed — try to use estimateEnergy result alone
    energy = estimatedEnergy;
    const errorMsg = simData?.result?.message
      ? Buffer.from(simData.result.message, "hex").toString()
      : "simulation reverted";
    error = errorMsg;
  }

  return { energy, energyPenalty, bandwidth, error };
}

/**
 * Build a step estimate from simulation result with fallback to typical values.
 *
 * When simulation succeeds, we trust its energy_used value directly (it already
 * includes energy_penalty per TronLink's implementation).
 * Only falls back to hardcoded typical values when simulation fails.
 */
function buildStep(
  step: string,
  description: string,
  simResult: { energy: number | null; energyPenalty: number; bandwidth: number | null; error?: string },
  typicalKey: string,
): StepEstimate {
  const typical = TYPICAL_RESOURCES[typicalKey];
  const simEnergy = simResult.energy;
  const energyEstimate = simEnergy !== null ? simEnergy : typical.energy;
  const energyPenalty = simResult.energyPenalty || 0;
  const energyBase = Math.max(energyEstimate - energyPenalty, 0);
  const bandwidthEstimate = simResult.bandwidth !== null
    ? simResult.bandwidth
    : typical.bandwidth;
  const energySource: StepEstimate["energySource"] = simEnergy !== null ? "simulation" : "typical";
  return {
    step,
    description,
    energyEstimate,
    energyBase,
    energyPenalty,
    bandwidthEstimate,
    energySource,
    ...(simResult.error ? { simulationError: simResult.error } : {}),
  };
}

/**
 * Calculate TRX cost from energy and bandwidth totals.
 */
function calculateTRXCost(totalEnergy: number, totalBandwidth: number): ResourceEstimation["costBreakdown"] & { total: string } {
  const energyCost = totalEnergy * RESOURCE_PRICES.energyPriceSun;
  const bandwidthCost = totalBandwidth * RESOURCE_PRICES.bandwidthPriceSun;
  const totalCost = energyCost + bandwidthCost;

  return {
    energyCostTRX: (energyCost / RESOURCE_PRICES.sunPerTRX).toFixed(3),
    bandwidthCostTRX: (bandwidthCost / RESOURCE_PRICES.sunPerTRX).toFixed(3),
    total: (totalCost / RESOURCE_PRICES.sunPerTRX).toFixed(3),
    note: `Energy price: ${RESOURCE_PRICES.energyPriceSun} SUN/unit, Bandwidth price: ${RESOURCE_PRICES.bandwidthPriceSun} SUN/point. If you have staked TRX for energy/bandwidth, actual TRX cost will be lower. Each account gets ${RESOURCE_PRICES.freeBandwidthPerDay} free bandwidth points per day.`,
  };
}

export type LendingOperation =
  | "supply" | "withdraw" | "withdraw_all" | "borrow" | "repay"
  | "enter_market" | "exit_market" | "approve" | "claim_rewards";

export interface ResourceWarning {
  hasEnoughEnergy: boolean;
  hasEnoughBandwidth: boolean;
  accountEnergy: number;
  accountBandwidth: number;
  requiredEnergy: number;
  requiredBandwidth: number;
  energyDeficit: number;
  bandwidthDeficit: number;
  /** Estimated TRX that will be burned to cover the energy deficit */
  energyBurnTRX: string;
  /** Estimated TRX that will be burned to cover the bandwidth deficit */
  bandwidthBurnTRX: string;
  /** Total TRX that will be burned (energy + bandwidth deficit) */
  totalBurnTRX: string;
  warning: string;
}

/**
 * Check if user has enough staked energy/bandwidth for an operation.
 * Returns a warning object if resources are insufficient.
 */
export async function checkResourceSufficiency(
  ownerAddress: string,
  requiredEnergy: number,
  requiredBandwidth: number,
  network = "mainnet",
): Promise<ResourceWarning> {
  const tronWeb = getTronWeb(network);
  const resources = await tronWeb.trx.getAccountResources(ownerAddress);

  const totalEnergy = (resources.EnergyLimit || 0) - (resources.EnergyUsed || 0);
  const freeBandwidth = (resources.freeNetLimit || 0) - (resources.freeNetUsed || 0);
  const stakedBandwidth = (resources.NetLimit || 0) - (resources.NetUsed || 0);

  const energyDeficit = Math.max(0, requiredEnergy - totalEnergy);
  // TRON bandwidth is all-or-nothing: free bandwidth is used only if it covers the full cost,
  // otherwise staked bandwidth is checked, and if neither suffices, full amount is burned as TRX.
  const bandwidthCovered = freeBandwidth >= requiredBandwidth || stakedBandwidth >= requiredBandwidth;
  const bandwidthDeficit = bandwidthCovered ? 0 : requiredBandwidth;
  const totalBandwidth = freeBandwidth + stakedBandwidth;

  const energyBurnTRX = energyDeficit * RESOURCE_PRICES.energyPriceSun / RESOURCE_PRICES.sunPerTRX;
  const bandwidthBurnTRX = bandwidthDeficit * RESOURCE_PRICES.bandwidthPriceSun / RESOURCE_PRICES.sunPerTRX;

  const warnings: string[] = [];
  if (energyDeficit > 0) {
    warnings.push(
      `Energy insufficient: you have ${totalEnergy} but need ~${requiredEnergy}. ` +
      `Deficit of ${energyDeficit} energy will burn ~${energyBurnTRX.toFixed(3)} TRX.`
    );
  }
  if (bandwidthDeficit > 0) {
    warnings.push(
      `Bandwidth insufficient: you have ${totalBandwidth} but need ~${requiredBandwidth}. ` +
      `Deficit of ${bandwidthDeficit} bandwidth will burn ~${bandwidthBurnTRX.toFixed(3)} TRX.`
    );
  }

  return {
    hasEnoughEnergy: energyDeficit === 0,
    hasEnoughBandwidth: bandwidthDeficit === 0,
    accountEnergy: totalEnergy,
    accountBandwidth: totalBandwidth,
    requiredEnergy,
    requiredBandwidth,
    energyDeficit,
    bandwidthDeficit,
    energyBurnTRX: energyBurnTRX.toFixed(3),
    bandwidthBurnTRX: bandwidthBurnTRX.toFixed(3),
    totalBurnTRX: (energyBurnTRX + bandwidthBurnTRX).toFixed(3),
    warning: warnings.length > 0
      ? `⚠️ RESOURCE WARNING: ${warnings.join(" ")} Consider staking TRX for energy to reduce costs.`
      : "",
  };
}

/**
 * Get typical resource requirements for a lending operation.
 */
export function getTypicalResources(operation: string, isTRX: boolean): { energy: number; bandwidth: number } {
  let key = operation;
  if (operation === "supply") key = isTRX ? "supply_trx" : "supply_trc20";
  if (operation === "repay") key = isTRX ? "repay_trx" : "repay_trc20";
  return TYPICAL_RESOURCES[key] || { energy: 100000, bandwidth: 300 };
}

/**
 * Check current TRC20 allowance and simulate approve energy.
 * Returns the step estimate, or null if current allowance is already sufficient.
 *
 * @param requiredAmount - The amount needed (raw units). If undefined, always estimate (for standalone approve).
 */
async function estimateApproveStep(
  tronWeb: any,
  ownerAddress: string,
  tokenAddress: string,
  spenderAddress: string,
  tokenSymbol: string,
  spenderLabel: string,
  requiredAmount: bigint | undefined,
  network: string,
): Promise<{ step: StepEstimate; skipped: boolean } | null> {
  const sim = (addr: string, fn: string, params: Array<{ type: string; value: any }>, opts: any = {}) =>
    trySimulateEnergy(tronWeb, ownerAddress, addr, fn, params, opts, network);

  // Check current allowance
  let currentAllowance = 0n;
  try {
    const token = tronWeb.contract(TRC20_ABI, tokenAddress);
    const raw = await token.methods.allowance(ownerAddress, spenderAddress).call();
    currentAllowance = BigInt(raw);
  } catch { /* default to 0 */ }

  // If requiredAmount is specified and current allowance covers it, skip approve
  if (requiredAmount !== undefined && currentAllowance >= requiredAmount && currentAllowance > 0n) {
    return null; // no approve needed
  }

  // Simulate approve
  const r = await sim(tokenAddress, "approve(address,uint256)", [
    { type: "address", value: spenderAddress }, { type: "uint256", value: MAX_UINT256 },
  ]);

  // SSTORE cold write (allowance 0→non-zero) costs ~3x more than warm write (non-zero→non-zero).
  // triggerConstantContract simulates against current state; if allowance is already set it
  // returns the cheaper warm cost. For first-time approve we use the typical cold-write value.
  if (r.energy !== null && currentAllowance === 0n) {
    r.energy = Math.max(r.energy, TYPICAL_RESOURCES.approve.energy);
  }

  const step = buildStep("approve", `Approve ${tokenSymbol} for ${spenderLabel}`, r, "approve");
  return { step, skipped: false };
}

/**
 * Estimate energy, bandwidth, and TRX cost for any JustLend operation.
 * Tries on-chain simulation first, falls back to historical typical values.
 *
 * @param spender - (optional) Custom spender address for approve operations. Defaults to jToken address.
 */
export async function estimateLendingEnergy(
  operation: LendingOperation,
  jTokenSymbol: string,
  amount: string,
  ownerAddress: string,
  network = "mainnet",
  spender?: string,
): Promise<ResourceEstimation> {
  const tronWeb = getTronWeb(network);
  const addresses = getJustLendAddresses(network);
  const steps: StepEstimate[] = [];

  const sim = (addr: string, fn: string, params: Array<{ type: string; value: any }>, opts: any = {}) =>
    trySimulateEnergy(tronWeb, ownerAddress, addr, fn, params, opts, network);

  let info: JTokenInfo | undefined;
  if (operation !== "claim_rewards") {
    info = resolveJToken(jTokenSymbol, network);
  }

  const isTRX = info ? (info.underlyingSymbol === "TRX" || !info.underlying) : false;

  switch (operation) {

    case "approve": {
      if (isTRX || !info!.underlying) throw new Error(`${jTokenSymbol} is native TRX — no approval needed`);
      const spenderAddr = spender || info!.address;
      const spenderLabel = spender ? spender : jTokenSymbol;
      const result = await estimateApproveStep(
        tronWeb, ownerAddress, info!.underlying, spenderAddr,
        info!.underlyingSymbol, spenderLabel, undefined, network,
      );
      if (result) steps.push(result.step);
      break;
    }

    case "supply": {
      const amountRaw = BigInt(Math.floor(parseFloat(amount) * 10 ** info!.underlyingDecimals));
      if (!isTRX && info!.underlying) {
        const approveResult = await estimateApproveStep(
          tronWeb, ownerAddress, info!.underlying, info!.address,
          info!.underlyingSymbol, jTokenSymbol, amountRaw, network,
        );
        if (approveResult) {
          steps.push(approveResult.step);
        }
      }
      if (isTRX) {
        const mr = await sim(info!.address, "mint()", [], { callValue: amountRaw.toString() });
        steps.push(buildStep("mint", `Supply ${amount} TRX to ${jTokenSymbol}`, mr, "supply_trx"));
      } else {
        const mr = await sim(info!.address, "mint(uint256)", [{ type: "uint256", value: amountRaw.toString() }]);
        steps.push(buildStep("mint", `Supply ${amount} ${info!.underlyingSymbol} to ${jTokenSymbol}`, mr, "supply_trc20"));
      }
      break;
    }

    case "withdraw": {
      const amountRaw = BigInt(Math.floor(parseFloat(amount) * 10 ** info!.underlyingDecimals)).toString();
      const r = await sim(info!.address, "redeemUnderlying(uint256)", [{ type: "uint256", value: amountRaw }]);
      steps.push(buildStep("redeemUnderlying", `Withdraw ${amount} ${info!.underlyingSymbol} from ${jTokenSymbol}`, r, "withdraw"));
      break;
    }

    case "withdraw_all": {
      // withdraw_all uses redeem(jTokenBalance), simulate with a typical jToken amount
      const r = await sim(info!.address, "redeem(uint256)", [{ type: "uint256", value: "100000000" }]);
      steps.push(buildStep("redeem", `Withdraw all ${info!.underlyingSymbol} from ${jTokenSymbol}`, r, "withdraw_all"));
      break;
    }

    case "borrow": {
      const amountRaw = BigInt(Math.floor(parseFloat(amount) * 10 ** info!.underlyingDecimals)).toString();
      const r = await sim(info!.address, "borrow(uint256)", [{ type: "uint256", value: amountRaw }]);
      steps.push(buildStep("borrow", `Borrow ${amount} ${info!.underlyingSymbol} from ${jTokenSymbol}`, r, "borrow"));
      break;
    }

    case "repay": {
      const amountRaw = BigInt(Math.floor(parseFloat(amount) * 10 ** info!.underlyingDecimals));
      if (!isTRX && info!.underlying) {
        const approveResult = await estimateApproveStep(
          tronWeb, ownerAddress, info!.underlying, info!.address,
          info!.underlyingSymbol, jTokenSymbol, amountRaw, network,
        );
        if (approveResult) {
          steps.push(approveResult.step);
        }
      }
      if (isTRX) {
        const r = await sim(info!.address, "repayBorrow()", [], { callValue: amountRaw.toString() });
        steps.push(buildStep("repayBorrow", `Repay ${amount} TRX to ${jTokenSymbol}`, r, "repay_trx"));
      } else {
        const r = await sim(info!.address, "repayBorrow(uint256)", [{ type: "uint256", value: amountRaw.toString() }]);
        steps.push(buildStep("repayBorrow", `Repay ${amount} ${info!.underlyingSymbol} to ${jTokenSymbol}`, r, "repay_trc20"));
      }
      break;
    }

    case "enter_market": {
      const r = await sim(addresses.comptroller, "enterMarkets(address[])", [{ type: "address[]", value: [info!.address] }]);
      steps.push(buildStep("enterMarkets", `Enable ${jTokenSymbol} as collateral`, r, "enter_market"));
      break;
    }

    case "exit_market": {
      const r = await sim(addresses.comptroller, "exitMarket(address)", [{ type: "address", value: info!.address }]);
      steps.push(buildStep("exitMarket", `Disable ${jTokenSymbol} as collateral`, r, "exit_market"));
      break;
    }

    case "claim_rewards": {
      const r = await sim(addresses.comptroller, "claimReward(address)", [{ type: "address", value: ownerAddress }]);
      steps.push(buildStep("claimReward", `Claim JustLend mining rewards`, r, "claim_rewards"));
      break;
    }
  }

  const totalEnergy = steps.reduce((sum, s) => sum + s.energyEstimate, 0);
  const totalBandwidth = steps.reduce((sum, s) => sum + s.bandwidthEstimate, 0);
  const hasTypical = steps.some((s) => s.energySource === "typical");
  const cost = calculateTRXCost(totalEnergy, totalBandwidth);

  return {
    operation,
    market: jTokenSymbol,
    steps,
    totalEnergy,
    totalBandwidth,
    estimatedTRXCost: cost.total,
    costBreakdown: {
      energyCostTRX: cost.energyCostTRX,
      bandwidthCostTRX: cost.bandwidthCostTRX,
      note: cost.note,
    },
    note: hasTypical
      ? "Some steps could not be simulated on-chain (e.g. insufficient balance or missing approval). Typical values from historical data are used. Actual costs may vary."
      : "All steps were successfully simulated on-chain. Actual costs should be close to these estimates.",
  };
}

/**
 * Simulate on-chain resource consumption for a lending operation.
 * Uses trySimulateEnergy for real estimation, falls back to TYPICAL_RESOURCES on failure.
 *
 * This is a lightweight version of estimateLendingEnergy — it only returns
 * { energy, bandwidth } for use in pre-transaction resource warnings.
 */
export async function simulateOperationResources(
  operation: string,
  jTokenSymbol: string,
  amount: string,
  ownerAddress: string,
  network = "mainnet",
): Promise<{ energy: number; bandwidth: number; source: "simulation" | "typical" }> {
  const typical = getTypicalResources(operation, operation === "supply" || operation === "repay"
    ? (() => {
        try { const i = resolveJToken(jTokenSymbol, network); return i.underlyingSymbol === "TRX" || !i.underlying; } catch { return false; }
      })()
    : false,
  );

  try {
    const tronWeb = getTronWeb(network);
    const addresses = getJustLendAddresses(network);
    let info: JTokenInfo | undefined;
    if (operation !== "claim_rewards") {
      info = resolveJToken(jTokenSymbol, network);
    }
    const isTRX = info ? (info.underlyingSymbol === "TRX" || !info.underlying) : false;

    const sim = (addr: string, fn: string, params: Array<{ type: string; value: any }>, opts: any = {}) =>
      trySimulateEnergy(tronWeb, ownerAddress, addr, fn, params, opts, network);

    let result: { energy: number | null; energyPenalty: number; bandwidth: number | null; error?: string };

    switch (operation) {
      case "supply": {
        const amountRaw = BigInt(Math.floor(parseFloat(amount) * 10 ** info!.underlyingDecimals));
        if (isTRX) {
          result = await sim(info!.address, "mint()", [], { callValue: amountRaw.toString() });
        } else {
          result = await sim(info!.address, "mint(uint256)", [{ type: "uint256", value: amountRaw.toString() }]);
        }
        break;
      }
      case "withdraw": {
        const amountRaw = BigInt(Math.floor(parseFloat(amount) * 10 ** info!.underlyingDecimals)).toString();
        result = await sim(info!.address, "redeemUnderlying(uint256)", [{ type: "uint256", value: amountRaw }]);
        break;
      }
      case "withdraw_all": {
        result = await sim(info!.address, "redeem(uint256)", [{ type: "uint256", value: "100000000" }]);
        break;
      }
      case "borrow": {
        const amountRaw = BigInt(Math.floor(parseFloat(amount) * 10 ** info!.underlyingDecimals)).toString();
        result = await sim(info!.address, "borrow(uint256)", [{ type: "uint256", value: amountRaw }]);
        break;
      }
      case "repay": {
        const amountRaw = BigInt(Math.floor(parseFloat(amount) * 10 ** info!.underlyingDecimals));
        if (isTRX) {
          result = await sim(info!.address, "repayBorrow()", [], { callValue: amountRaw.toString() });
        } else {
          result = await sim(info!.address, "repayBorrow(uint256)", [{ type: "uint256", value: amountRaw.toString() }]);
        }
        break;
      }
      case "enter_market": {
        result = await sim(addresses.comptroller, "enterMarkets(address[])", [{ type: "address[]", value: [info!.address] }]);
        break;
      }
      case "exit_market": {
        result = await sim(addresses.comptroller, "exitMarket(address)", [{ type: "address", value: info!.address }]);
        break;
      }
      case "claim_rewards": {
        result = await sim(addresses.comptroller, "claimReward(address)", [{ type: "address", value: ownerAddress }]);
        break;
      }
      default:
        return { ...typical, source: "typical" };
    }

    const energy = result!.energy ?? typical.energy;
    const bandwidth = result!.bandwidth ?? typical.bandwidth;
    return { energy, bandwidth, source: result!.energy !== null ? "simulation" : "typical" };
  } catch {
    return { ...typical, source: "typical" };
  }
}
