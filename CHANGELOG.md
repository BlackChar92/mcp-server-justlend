# Changelog

All notable changes to this project are documented here. Format inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) with [Semantic Versioning](https://semver.org/).

## [1.1.0] — 2026-04-17 (unreleased)

**Theme**: JustLend V2 (Moolah) protocol support + historical records + gas estimation.

### Added — JustLend V2 (Moolah) core (M1)

- **Service layer** (6 modules, 42 exported functions):
  - `moolah-backend.ts` — REST wrapper for `zenvora.ablesdxd.link` (16 functions covering vault / market / position / liquidation / records / token endpoints)
  - `moolah-query.ts` — on-chain view reads: `getMoolahMarketState`, `getMoolahUserPosition`, `getMoolahMarketParams`, `isMoolahPositionHealthy`, vault totalAssets / maxWithdraw / convertToShares+Assets, and liquidation quote helper
  - `moolah-vault.ts` — ERC4626 vault write ops (deposit / withdraw / redeem / approve)
  - `moolah-market.ts` — supplyCollateral / withdrawCollateral / borrow / repay / composite supplyCollateralAndBorrow / approveMoolahProxy
  - `moolah-liquidation.ts` — `moolahLiquidate` + `approveLiquidatorToken`
  - `moolah-dashboard.ts` — `getMoolahDashboard`, `getMoolahUserSummary`, V2 vault/market history helpers
- **Contract ABIs** (4 new): `MOOLAH_CORE_ABI`, `TRX_PROVIDER_ABI`, `MOOLAH_VAULT_ABI`, `PUBLIC_LIQUIDATOR_ABI`
- **Contract addresses**: mainnet + nile Moolah core addresses (MoolahProxy, TrxProviderProxy, PublicLiquidatorProxy, WTRX, ResilientOracle, IRM) plus vault registry. Nile is missing USDD vault (not deployed there); only TRX and USDT vaults are registered.
- **MCP tools** (21 new):
  - Vault (6): `get_moolah_vault`, `get_moolah_vaults`, `approve_moolah_vault`, `moolah_vault_deposit`, `moolah_vault_withdraw`, `moolah_vault_redeem`
  - Market (8): `get_moolah_market`, `get_moolah_markets`, `get_moolah_user_position`, `approve_moolah_proxy`, `moolah_supply_collateral`, `moolah_withdraw_collateral`, `moolah_borrow`, `moolah_repay`
  - Liquidation (5): `get_moolah_pending_liquidations`, `get_moolah_liquidation_quote`, `get_moolah_liquidation_records`, `approve_liquidator_token`, `moolah_liquidate`
  - Dashboard (2): `get_moolah_dashboard`, `get_moolah_history`
- **AI prompts** (4 new): `moolah_supply`, `moolah_borrow`, `moolah_liquidate`, `moolah_portfolio`

### Added — historical records (M2, +6 tools)

- New service module `records.ts` wrapping the paginated history endpoints on `labc.ablesdxd.link` (mainnet-only):
  - `get_lending_records` → `/justlend/record/depositBorrow` (11 V1 action types)
  - `get_strx_records` → `/justlend/record/strx`
  - `get_vote_records` → `/justlend/record/vote`
  - `get_energy_rental_records` → `/justlend/record/rent`
  - `get_liquidation_records` → `/justlend/record/liquidate` (V1 liquidations)
- Plus V2 Moolah records: `get_moolah_records` → `/record/lend`
- Each service function enriches numeric action/op codes with human-readable names (`actionName` / `opName`) so callers don't need a local lookup table.

### Added — history time series + airdrop rewards (M3, +3 tools)

- `get_moolah_vault_history` → `/vault/history-data` (APY / TVL curves)
- `get_moolah_market_history` → `/market/history-data` (borrow/supply APY + utilization curves)
- `get_claimable_rewards` → `/sunProject/getAllUnClaimedAirDrop` (scans all JustLend merkle distributors; read-only — the write path `multiClaim()` is deferred until the live response's merkle-proof fields are verified against a real airdropped address)

### Added — Moolah gas estimator (M4, +1 tool)

- `estimate_moolah_energy` + `moolah-estimate.ts` service module. Returns historical typical values for all 11 Moolah write operations with TRX vs TRC20 route differentiation. On-chain simulation for Moolah's tuple-args ops is not yet wired (typical values used as fallback; status exposed via `source: "typical"`).

### Fixed — HIGH-severity audit findings

- **`Number(callValue)` precision**: all TRX-payable broadcast paths (`writeContract`, `safeSend`, and both `estimateEnergy` fallbacks) now go through a new exported `callValueToSafeNumber()` helper that rejects amounts above `Number.MAX_SAFE_INTEGER` (~9.007×10¹⁵ sun / ~9 B TRX) and negative values. Mirrors the existing guard in `transfer.ts`.
- **HTTP Bearer-token timing leak**: API-key comparison in `http-server.ts` is now routed through `crypto.timingSafeEqual` via a new `src/server/auth.ts` helper. Equal-length buffers only; short-circuit and length-difference leakages removed.

### Changed — backend type alignment

- Rewrote every interface in `moolah-backend.ts` after verifying real API response shapes against the live endpoints (the first-pass types were extrapolated from front-end store field names that differ from the wire format). All fields marked optional since `/index/vault/list` and `/vault/info` use different field names for the same vault data (`vaultAddress` vs `address`, `assetDecimals` plural vs `assetDecimal` singular, etc.).
- `fetchMoolahVaultList` and `fetchMoolahMarketList` flatten the nested `allVaults.list` / `allMarkets` envelopes into a consistent `{ list, total, userList, userTotal, ... }` shape for downstream consumers.
- `getMoolahDashboard` now enforces the requested `pageSize` client-side because `/index/market/list` ignores the server-side `pageSize` parameter.
- AI prompt copy: every reference to non-existent fields (`safePercent`, `healthFactor`, `maxBorrowableUSD`) replaced with the real `risk` (0–1 ratio) and `lltv` fields.

### Tests

- 57 new tests added; full suite now **321 passed / 11 skipped / 0 regressions** across 37 test files.
- New files:
  - `moolah-config.test.ts` — chains.ts + helper validation (no network)
  - `moolah-query.test.ts` — mainnet on-chain reads (skipOn429)
  - `moolah-backend.test.ts` — mainnet REST reachability + shape (skipOn429)
  - `moolah-dashboard.test.ts` — dashboard composition (skipOn429)
  - `moolah-liquidation-logic.test.ts` — mocked input validation
  - `moolah-estimate.test.ts` — typical-resources table coverage
  - `records.test.ts` — all 5 V1 record endpoints + nile rejection
  - `contracts-callvalue-guard.test.ts` — audit-fix coverage for callValue guard
  - `tests/server/auth.test.ts` — audit-fix coverage for `authHeaderMatches`

### Docs

- `forTest/docs/v1.1.0/v1.1.0-development-plan.md` and `m1-moolah-dev-steps.md` revised to match shipped reality and annotated with a "分支代码落地情况" section that cross-checks plan against code via `grep`/`git log`/`npm test`.
- `forTest/audit/mcp-server-justlend-audit-report-v1.1.0-20260417.md` + 修改版 variant documenting the security audit and HIGH fixes.
- `CHANGELOG.md` (this file, new).

---

## [1.0.4] — 2026-04-09

- Pin all dependency versions to exact installed versions.
- Fix: zero private key buffer after use; bump `follow-redirects`.
- Fix: use BigInt comparison for sTRX unstake balance check; safe float-to-SUN conversion.
- Docs: update README architecture, prompts, and energy rental example.

## [1.0.3] — earlier

- Browser-wallet signing via TronLink (sign-only mode).
- Dual wallet mode: `browser` (recommended) or `agent` (encrypted local storage).

See `git log --oneline` for the full history prior to v1.0.4.
