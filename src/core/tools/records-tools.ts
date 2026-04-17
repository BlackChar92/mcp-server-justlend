import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as services from "../services/index.js";
import { sanitizeError } from "./shared.js";

/**
 * Historical transaction records (paginated REST).
 *
 * All endpoints here are **mainnet-only** — the `labc.ablesdxd.link` host
 * does not have nile counterparts. Passing network='nile' will throw early.
 *
 * The V2 Moolah records tool (`get_moolah_records`) lives in
 * `moolah-dashboard-tools.ts` to keep the `moolah_` namespace cohesive.
 */
export function registerRecordsTools(server: McpServer) {

  server.registerTool(
    "get_lending_records",
    {
      description:
        "Get a user's V1 JustLend transaction history: supply, withdraw, borrow, repay, and collateral enable/disable. " +
        "Paginated. Each record includes actionType (1-11), actionName (human-readable), token, amount, USD value, and txId. " +
        "Mainnet-only.",
      inputSchema: {
        address: z.string().describe("TRON address (T...). Default: configured wallet"),
        page: z.number().optional().describe("Page number, 1-indexed. Default: 1"),
        pageSize: z.number().optional().describe("Records per page. Default: 20"),
        network: z.string().optional().describe("Must be 'mainnet'. Default: mainnet"),
      },
      annotations: { title: "Get V1 Lending Records", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ address, page = 1, pageSize = 20, network = services.getGlobalNetwork() }) => {
      try {
        const userAddr = address || await services.getWalletAddress();
        const res = await services.fetchLendingRecords(userAddr, page, pageSize, network);
        return { content: [{ type: "text", text: JSON.stringify({ address: userAddr, ...res }, null, 2) }] };
      } catch (error: any) {
        return { content: [{ type: "text", text: `Error: ${sanitizeError(error)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "get_strx_records",
    {
      description:
        "Get a user's sTRX staking history: stake, unstake, withdraw (after unbonding), and sTRX transfers. " +
        "Each record has opType (1-6) and a human-readable opName. Paginated. Mainnet-only.",
      inputSchema: {
        address: z.string().describe("TRON address. Default: configured wallet"),
        page: z.number().optional().describe("Page number, 1-indexed. Default: 1"),
        pageSize: z.number().optional().describe("Records per page. Default: 20"),
        network: z.string().optional().describe("Must be 'mainnet'. Default: mainnet"),
      },
      annotations: { title: "Get sTRX Records", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ address, page = 1, pageSize = 20, network = services.getGlobalNetwork() }) => {
      try {
        const userAddr = address || await services.getWalletAddress();
        const res = await services.fetchStrxRecords(userAddr, page, pageSize, network);
        return { content: [{ type: "text", text: JSON.stringify({ address: userAddr, ...res }, null, 2) }] };
      } catch (error: any) {
        return { content: [{ type: "text", text: `Error: ${sanitizeError(error)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "get_vote_records",
    {
      description:
        "Get a user's governance voting history: get_vote (JST → WJST deposits), votes cast for/against proposals, " +
        "vote withdrawals, and JST conversions back. Each record has opType (1-6), opName, amount, and proposalId " +
        "(for votes and withdrawals). Use get_user_vote_status for real-time current voting power. Mainnet-only.",
      inputSchema: {
        address: z.string().describe("TRON address. Default: configured wallet"),
        page: z.number().optional().describe("Page number, 1-indexed. Default: 1"),
        pageSize: z.number().optional().describe("Records per page. Default: 20"),
        network: z.string().optional().describe("Must be 'mainnet'. Default: mainnet"),
      },
      annotations: { title: "Get Vote Records", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ address, page = 1, pageSize = 20, network = services.getGlobalNetwork() }) => {
      try {
        const userAddr = address || await services.getWalletAddress();
        const res = await services.fetchVoteRecords(userAddr, page, pageSize, network);
        return { content: [{ type: "text", text: JSON.stringify({ address: userAddr, ...res }, null, 2) }] };
      } catch (error: any) {
        return { content: [{ type: "text", text: `Error: ${sanitizeError(error)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "get_energy_rental_records",
    {
      description:
        "Get a user's JustLend energy-rental history: rent, extend, rent_more, end, recycle actions. " +
        "Distinct from get_user_energy_rental_orders which returns current active on-chain orders — " +
        "this one returns the full historical action log. Paginated. Mainnet-only.",
      inputSchema: {
        address: z.string().describe("TRON address. Default: configured wallet"),
        page: z.number().optional().describe("Page number, 1-indexed. Default: 1"),
        pageSize: z.number().optional().describe("Records per page. Default: 20"),
        network: z.string().optional().describe("Must be 'mainnet'. Default: mainnet"),
      },
      annotations: { title: "Get Energy Rental Records", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ address, page = 1, pageSize = 20, network = services.getGlobalNetwork() }) => {
      try {
        const userAddr = address || await services.getWalletAddress();
        const res = await services.fetchEnergyRentalRecords(userAddr, page, pageSize, network);
        return { content: [{ type: "text", text: JSON.stringify({ address: userAddr, ...res }, null, 2) }] };
      } catch (error: any) {
        return { content: [{ type: "text", text: `Error: ${sanitizeError(error)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "get_claimable_rewards",
    {
      description:
        "Scan all JustLend merkle airdrop distributors for a user's unclaimed rewards. Returns a map keyed by " +
        "merkle distributor index; each entry includes the token symbol, address, and amount. " +
        "Read-only — actually claiming requires per-distributor merkle proofs passed to multiClaim() on-chain " +
        "(write path deferred until the proof fields are confirmed against a live address with rewards). " +
        "Mainnet-only.",
      inputSchema: {
        address: z.string().describe("TRON address. Default: configured wallet"),
        network: z.string().optional().describe("Must be 'mainnet'. Default: mainnet"),
      },
      annotations: { title: "Get Claimable Rewards", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ address, network = services.getGlobalNetwork() }) => {
      try {
        const userAddr = address || await services.getWalletAddress();
        const res = await services.fetchClaimableRewards(userAddr, network);
        const count = Object.keys(res.merkleRewards ?? {}).length;
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              address: userAddr,
              distributorCount: count,
              rewards: res.merkleRewards,
              note: count === 0
                ? "No claimable rewards found for this address."
                : "Use the returned amounts/proofs to build multiClaim() calls against the appropriate distributors.",
            }, null, 2),
          }],
        };
      } catch (error: any) {
        return { content: [{ type: "text", text: `Error: ${sanitizeError(error)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "get_liquidation_records",
    {
      description:
        "Get a user's V1 JustLend liquidation history — both positions the user liquidated and positions where the user was liquidated. " +
        "Distinct from get_moolah_liquidation_records which covers V2 Moolah liquidations. Paginated. Mainnet-only.",
      inputSchema: {
        address: z.string().describe("TRON address. Default: configured wallet"),
        page: z.number().optional().describe("Page number, 1-indexed. Default: 1"),
        pageSize: z.number().optional().describe("Records per page. Default: 20"),
        network: z.string().optional().describe("Must be 'mainnet'. Default: mainnet"),
      },
      annotations: { title: "Get V1 Liquidation Records", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ address, page = 1, pageSize = 20, network = services.getGlobalNetwork() }) => {
      try {
        const userAddr = address || await services.getWalletAddress();
        const res = await services.fetchLiquidationRecords(userAddr, page, pageSize, network);
        return { content: [{ type: "text", text: JSON.stringify({ address: userAddr, ...res }, null, 2) }] };
      } catch (error: any) {
        return { content: [{ type: "text", text: `Error: ${sanitizeError(error)}` }], isError: true };
      }
    },
  );
}
