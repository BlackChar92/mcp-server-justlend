import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getMoolahVaultMiningApy,
  getMoolahMiningResolver,
  getMoolahAccruingMining,
  getMoolahPendingMiningPeriods,
  claimMoolahMiningPeriod,
} from "../../../src/core/services/moolah-mining.js";
import * as backend from "../../../src/core/services/moolah-backend.js";

// Network-free unit tests focused on the parsing logic that determines claim
// correctness — hex-to-decimal conversion, decimals per token, slot-aligned
// amounts arrays, settling vs accruing classification, and distributor
// availability errors. The on-chain merkle pre-checks belong to integration
// coverage and are stubbed via the existing `claim_moolah_mining_period`
// flow; we don't exercise tronWeb here.

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getMoolahVaultMiningApy", () => {
  it("returns USDD/TRX split and total, with enabled=true when nonzero", async () => {
    vi.spyOn(backend, "fetchV2VaultMiningRates").mockResolvedValue({
      "TVAULT...": { USDDNEW: "0.05", TRXNEW: "0.02" },
    } as any);
    const res = await getMoolahVaultMiningApy("TVAULT...", "mainnet");
    expect(res.miningApy.usdd).toBeCloseTo(0.05);
    expect(res.miningApy.trx).toBeCloseTo(0.02);
    expect(res.miningApy.total).toBeCloseTo(0.07);
    expect(res.enabled).toBe(true);
  });

  it("returns zeros and enabled=false for an unknown vault", async () => {
    vi.spyOn(backend, "fetchV2VaultMiningRates").mockResolvedValue({} as any);
    const res = await getMoolahVaultMiningApy("TUNKNOWN", "mainnet");
    expect(res.miningApy.total).toBe(0);
    expect(res.enabled).toBe(false);
  });
});

describe("getMoolahMiningResolver", () => {
  it("filters out vaults with zero APY", async () => {
    vi.spyOn(backend, "fetchV2VaultMiningRates").mockResolvedValue({
      TA: { USDDNEW: "0.1", TRXNEW: "0" },
      TB: { USDDNEW: "0",   TRXNEW: "0"  },
      TC: { USDDNEW: "0.02", TRXNEW: "0.03" },
    } as any);
    const res = await getMoolahMiningResolver("mainnet");
    expect(res.count).toBe(2);
    expect(res.vaults.TA.total).toBeCloseTo(0.1);
    expect(res.vaults.TC.total).toBeCloseTo(0.05);
    expect(res.vaults.TB).toBeUndefined();
  });
});

describe("getMoolahAccruingMining", () => {
  it("aggregates gainNew across vaults and only counts gainLast in settling window", async () => {
    vi.spyOn(backend, "fetchV2UserMiningState").mockResolvedValue({
      vaultA: {
        USDDNEW: { gainNew: "10", gainLast: "5", price: 1, miningStatus: 1, currRewardStatus: "1", currEndTime: "2026-05-10 12:00" },
        TRXNEW:  { gainNew: "20", gainLast: "0", price: 0.1, miningStatus: 1, currRewardStatus: "1", currEndTime: "2026-05-10 12:00" },
      },
      vaultB: {
        // Settling window: status=2, currRewardStatus=1, gainLast counts
        USDDNEW: { gainNew: "0", gainLast: "7", price: 1, miningStatus: 2, currRewardStatus: "1" },
        // Outside settling window (status=3), gainLast must NOT count
        TRXNEW:  { gainNew: "0", gainLast: "100", price: 0.1, miningStatus: 3, currRewardStatus: "1" },
      },
      vaultC: {
        // currRewardStatus=2 should flip globalSettlementStatus
        USDDNEW: { gainNew: "0", gainLast: "0", price: 1, miningStatus: 1, currRewardStatus: "2" },
      },
    } as any);
    const res = await getMoolahAccruingMining("Tuser", "mainnet");
    // accruing: 10*1 + 20*0.1 = 12
    expect(res.accruingUsd).toBeCloseTo(12);
    // settling: 7*1 only (vaultB.TRXNEW excluded by status=3)
    expect(res.settlingUsd).toBeCloseTo(7);
    expect(res.globalSettlementStatus).toBe(true);
    expect(res.settlementTime).toBe("2026-05-10 12:00");
    const usdd = res.pendingByToken.find(p => p.token === "USDD");
    const trx  = res.pendingByToken.find(p => p.token === "TRX");
    expect(usdd?.amount).toBe("10");
    expect(trx?.amount).toBe("20");
  });

  it("ignores NFT tokens entirely", async () => {
    vi.spyOn(backend, "fetchV2UserMiningState").mockResolvedValue({
      vault: {
        NFTNEW: { gainNew: "999", gainLast: "999", price: 100, miningStatus: 1, currRewardStatus: "1" },
      },
    } as any);
    const res = await getMoolahAccruingMining("Tuser", "mainnet");
    expect(res.accruingUsd).toBe(0);
    expect(res.pendingByToken.length).toBe(0);
  });

  it("treats sentinel '1970-01-01 08:00' end time as missing", async () => {
    vi.spyOn(backend, "fetchV2UserMiningState").mockResolvedValue({
      v: {
        USDDNEW: { gainNew: "1", gainLast: "0", price: 1, miningStatus: 1, currRewardStatus: "1", currEndTime: "1970-01-01 08:00" },
      },
    } as any);
    const res = await getMoolahAccruingMining("Tuser", "mainnet");
    expect(res.settlementTime).toBe("");
  });
});

describe("getMoolahPendingMiningPeriods", () => {
  it("decodes hex amounts using per-token decimals (TRX=6, USDD=18)", async () => {
    // 1_000_000 raw with 6 decimals = 1.0 TRX; 2*10^18 raw with 18 decimals = 2.0 USDD
    vi.spyOn(backend, "fetchV2UnclaimedAirdrop").mockResolvedValue({
      "0": {
        merkleIndex: 0,
        index: 7,
        proof: ["0xabc"],
        tokenSymbol: ["USDD", "TRX"],
        tokenAddress: ["TUSDD...", "TTRX..."],
        amount: ["0x1bc16d674ec80000", "0xf4240"], // 2e18, 1e6
        claimed: false,
      },
      "1": {
        merkleIndex: 1, index: 0, proof: [], tokenSymbol: ["USDD"], tokenAddress: ["TUSDD..."],
        amount: ["1000000000000000000"], claimed: true,
      },
    } as any);
    const res = await getMoolahPendingMiningPeriods("Tuser", { network: "mainnet" });
    // claimed:true round excluded by default
    expect(res.periods.length).toBe(1);
    const p = res.periods[0];
    expect(p.merkleIndex).toBe(0);
    expect(p.index).toBe(7);
    expect(p.tokens[0].symbol).toBe("USDD");
    expect(p.tokens[0].decimals).toBe(18);
    expect(p.tokens[0].amount).toBe("2");
    expect(p.tokens[0].amountRaw).toBe("2000000000000000000");
    expect(p.tokens[1].symbol).toBe("TRX");
    expect(p.tokens[1].decimals).toBe(6);
    expect(p.tokens[1].amount).toBe("1");
    expect(p.tokens[1].amountRaw).toBe("1000000");
    // USD = 2 * 1 + 1 * 0.145 ≈ 2.145
    expect(p.totalUsd).toBeCloseTo(2.145, 5);
  });

  it("returns claimed rounds when includeClaimed=true", async () => {
    vi.spyOn(backend, "fetchV2UnclaimedAirdrop").mockResolvedValue({
      "0": { merkleIndex: 0, index: 0, proof: [], tokenSymbol: ["USDD"], tokenAddress: [""], amount: ["0"], claimed: true },
    } as any);
    const res = await getMoolahPendingMiningPeriods("Tuser", { includeClaimed: true, network: "mainnet" });
    expect(res.periods.length).toBe(1);
    expect(res.periods[0].claimed).toBe(true);
  });
});

describe("claimMoolahMiningPeriod (config errors)", () => {
  it("errors clearly when distributor is not configured for the network", async () => {
    // Mainnet has merkleDistributorV2 = "" until contracts ship. The error
    // surfaces before any wallet or network call, so no mocks are needed.
    await expect(
      claimMoolahMiningPeriod({ periodKey: "0", network: "mainnet" }),
    ).rejects.toThrow(/V2 mining distributor is not configured/);
  });

  it("requires either periodKey or full claim fields", async () => {
    // Nile has the address configured, so we expect the validation error,
    // not the missing-distributor error.
    await expect(
      claimMoolahMiningPeriod({ network: "nile" }),
    ).rejects.toThrow(/Either periodKey or full claim fields/);
  });
});
