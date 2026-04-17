import { describe, it, expect } from "vitest";
import { getMoolahDashboard } from "../../../src/core/services/moolah-dashboard.js";
import { skipOn429 } from "../../helpers.js";

// Dashboard composition — mainnet read-only. Verifies the wrapper shape only.
// See moolah-backend.test.ts for the backend-type-mismatch TODO.

describe("getMoolahDashboard (mainnet)", () => {
  it("returns an object with vaults/markets/totals keys", skipOn429(async () => {
    const dash = await getMoolahDashboard({ vaultPageSize: 2, marketPageSize: 2, network: "mainnet" });
    expect(dash).toBeTruthy();
    expect(dash).toHaveProperty("vaults");
    expect(dash).toHaveProperty("markets");
    expect(dash).toHaveProperty("totalVaults");
    expect(dash).toHaveProperty("totalMarkets");
  }));
});
