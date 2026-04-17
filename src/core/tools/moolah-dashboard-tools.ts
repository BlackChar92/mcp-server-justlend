import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as services from "../services/index.js";
import { sanitizeError } from "./shared.js";

export function registerMoolahDashboardTools(server: McpServer) {

  server.registerTool(
    "get_moolah_dashboard",
    {
      description:
        "JustLend V2 (Moolah) protocol overview: top vaults (APY, TVL) and top markets (borrow/supply rates). " +
        "If address is provided, also includes the user's aggregated V2 position (total supply, borrow, health factor).",
      inputSchema: {
        address: z.string().optional().describe("User address to include V2 position summary. Default: configured wallet"),
        depositToken: z.string().optional().describe("Filter vaults and markets by deposit token symbol"),
        collateralToken: z.string().optional().describe("Filter markets by collateral token symbol"),
        network: z.string().optional().describe("Network. Default: mainnet"),
      },
      annotations: { title: "Get Moolah Dashboard", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ address, depositToken, collateralToken, network = services.getGlobalNetwork() }) => {
      try {
        const userAddr = address || await services.getWalletAddress().catch(() => "");

        const dashboardPromise = services.getMoolahDashboard({ depositToken, collateralToken, network });
        const positionPromise = userAddr
          ? services.fetchMoolahUserPosition(userAddr, network).catch(() => null)
          : Promise.resolve(null);

        const [dashboard, userPosition] = await Promise.all([dashboardPromise, positionPromise]);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ ...dashboard, userPosition }, null, 2),
          }],
        };
      } catch (error: any) {
        return { content: [{ type: "text", text: `Error: ${sanitizeError(error)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "get_moolah_history",
    {
      description:
        "Get a user's JustLend V2 position history (net worth, supply, borrow over time) " +
        "and recent transaction records (supply, borrow, repay, etc.).",
      inputSchema: {
        address: z.string().optional().describe("User address. Default: configured wallet"),
        timeFilter: z.enum(["ONE_DAY", "ONE_WEEK", "ONE_MONTH"]).optional().describe("History time range. Default: ONE_WEEK"),
        network: z.string().optional().describe("Network. Default: mainnet"),
      },
      annotations: { title: "Get Moolah History", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ address, timeFilter = "ONE_WEEK", network = services.getGlobalNetwork() }) => {
      try {
        const userAddr = address || await services.getWalletAddress();
        const [summary, records] = await Promise.all([
          services.getMoolahUserSummary({ userAddress: userAddr, timeFilter, network }),
          services.fetchMoolahUserRecords(userAddr, { pageSize: 20 }, network),
        ]);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ position: summary.position, history: summary.history, recentTransactions: records.list }, null, 2),
          }],
        };
      } catch (error: any) {
        return { content: [{ type: "text", text: `Error: ${sanitizeError(error)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "get_moolah_records",
    {
      description:
        "Get a user's paginated V2 (Moolah) transaction history — supply, withdraw, borrow, repay, liquidate events. " +
        "Distinct from get_moolah_history (which returns position curves + a small recent-txs preview) — this one is the " +
        "full paginated record list. Works on both mainnet and nile.",
      inputSchema: {
        address: z.string().optional().describe("User address. Default: configured wallet"),
        pageNo: z.number().optional().describe("Page number, 1-indexed. Default: 1"),
        pageSize: z.number().optional().describe("Records per page. Default: 20"),
        network: z.string().optional().describe("Network. Default: mainnet"),
      },
      annotations: { title: "Get Moolah Records", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ address, pageNo = 1, pageSize = 20, network = services.getGlobalNetwork() }) => {
      try {
        const userAddr = address || await services.getWalletAddress();
        const res = await services.fetchMoolahUserRecords(userAddr, { pageNo, pageSize }, network);
        return { content: [{ type: "text", text: JSON.stringify({ address: userAddr, ...res }, null, 2) }] };
      } catch (error: any) {
        return { content: [{ type: "text", text: `Error: ${sanitizeError(error)}` }], isError: true };
      }
    },
  );
}
