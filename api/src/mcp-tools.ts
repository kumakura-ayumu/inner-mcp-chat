import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * MCPサーバーを生成してツールを登録する。
 * InMemoryTransport で Function 内から直接呼び出すことを想定。
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "inner-mcp-server",
    version: "1.0.0",
  });

  // ── ツール: get_server_status ──────────────────────────────────────────────
  server.registerTool(
    "get_server_status",
    {
      description:
        "サーバーの各種メトリクス（CPU・メモリ・ディスク・バックアップ状況）を生の数値データとして返します。",
    },
    async () => {
      const metrics = {
        cpu_usage_percent: 88,
        memory_usage_percent: 94,
        disk_status: "CRITICAL_IO_LATENCY",
        last_backup_days_ago: 12,
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(metrics),
          },
        ],
      };
    }
  );

  return server;
}
