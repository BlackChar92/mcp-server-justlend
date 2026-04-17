import { describe, it, expect } from "vitest";
import {
  fetchMoolahVaultList,
  fetchMoolahMarketList,
} from "../../../src/core/services/moolah-backend.js";
import { skipOn429 } from "../../helpers.js";

// Mainnet backend reachability tests.
//
// TODO: the actual Moolah API envelope for list endpoints is nested
// (e.g. /index/vault/list returns { code, data: { allVaults: { totalCount, list }, userVaults, ... } })
// and uses camelCase field names different from our TypeScript interfaces
// (e.g. `assetSymbol` / `apy` / `tvl` instead of `underlyingSymbol` / `supplyAPY` / `totalAssetsUSD`).
// The tests below confirm connectivity only. A follow-up task should update
// moolah-backend.ts types and extraction logic to match the real response shape.

describe("Moolah backend API reachability (mainnet)", () => {
  it("fetchMoolahVaultList returns a non-null response", skipOn429(async () => {
    const res = await fetchMoolahVaultList({ pageSize: 2 }, "mainnet");
    expect(res).toBeTruthy();
  }));

  it("fetchMoolahMarketList returns a non-null response", skipOn429(async () => {
    const res = await fetchMoolahMarketList({ pageSize: 2 }, "mainnet");
    expect(res).toBeTruthy();
  }));
});
