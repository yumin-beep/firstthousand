// Qloo access through the official harness MCP server (`qloo mcp`, stdio).
// The key stays in the server process environment; nothing here sends it to the browser.
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Tools the agent may call. qloo_capabilities is used only for the readiness check.
export const AGENT_TOOLS = [
  "qloo_describe",
  "qloo_recommend",
  "qloo_compare_audiences",
  "qloo_where_popular",
  "qloo_entity_tags",
  "qloo_audience_demographics",
  "qloo_find_tags",
  "qloo_rank",
];

// The package exports only its library entry (dist/index.js); the CLI sits beside it.
function harnessBin() {
  return fileURLToPath(new URL("./bin.js", import.meta.resolve("@qloo/qloo-harness")));
}

// Tool results arrive as one text block holding the harness result envelope.
export function parseEnvelope(callResult) {
  const text = callResult?.content?.find((c) => c.type === "text")?.text;
  if (!text) return { status: "error", error: { code: "no_content", recovery: "Empty tool result." } };
  try {
    return JSON.parse(text);
  } catch {
    return { status: "error", error: { code: "unparseable", recovery: text.slice(0, 300) } };
  }
}

export class QlooMcp {
  constructor({ apiKey, timeoutMs = 45000 } = {}) {
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.client = null;
    this.tools = [];
  }

  async connect() {
    if (this.client) return;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [harnessBin(), "mcp"],
      env: { ...process.env, QLOO_API_KEY: this.apiKey ?? "" },
      stderr: "ignore",
    });
    const client = new Client({ name: "firstthousand", version: "0.1.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    this.tools = tools.filter((t) => AGENT_TOOLS.includes(t.name));
    this.client = client;
  }

  async readiness() {
    await this.connect();
    const env = parseEnvelope(await this.client.callTool({ name: "qloo_capabilities", arguments: {} }));
    return { ready: Boolean(env?.adapter?.ready), supported: env?.adapter?.supported_operation_ids ?? [] };
  }

  async call(name, args) {
    if (!AGENT_TOOLS.includes(name)) {
      return { status: "error", error: { code: "tool_not_allowed", recovery: `Unknown tool ${name}.` } };
    }
    await this.connect();
    const result = await this.client.callTool({ name, arguments: args }, undefined, { timeout: this.timeoutMs });
    return parseEnvelope(result);
  }

  async close() {
    await this.client?.close();
    this.client = null;
  }
}
