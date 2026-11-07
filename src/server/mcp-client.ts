// A small MCP client (streamable HTTP, JSON-RPC) for the services the drivers configure: Studio's Builder MCP
// (studio-graph) and OMA's Builder MCP (oma-agent). One session per client; a tool error is thrown with its text.

export class McpError extends Error {}

export class McpClient {
  private url: string;
  private headers: () => Record<string, string>;
  private fetcher: typeof fetch;
  private session: string | undefined;
  private ready: Promise<void> | undefined;
  private id = 0;

  constructor(url: string, headers: () => Record<string, string>, fetcher: typeof fetch = fetch) {
    this.url = url;
    this.headers = headers;
    this.fetcher = fetcher;
  }

  private async rpc(method: string, params?: unknown, notify = false): Promise<any> {
    const response = await this.fetcher(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...this.headers(), ...(this.session ? { "mcp-session-id": this.session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", method, ...(notify ? {} : { id: ++this.id }), ...(params !== undefined ? { params } : {}) }),
      signal: AbortSignal.timeout(120_000),
    });
    this.session = response.headers.get("mcp-session-id") ?? this.session;
    if (response.status === 401 || response.status === 403) throw new McpError(`${this.url} refused the credentials (HTTP ${response.status})`);
    if (!response.ok && !(notify && response.status === 202)) throw new McpError(`${this.url} returned HTTP ${response.status}`);
    const raw = await response.text();
    if (notify || !raw.trim()) return null;
    const text = (response.headers.get("content-type") ?? "").includes("text/event-stream")
      ? raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).at(-1) ?? "{}"
      : raw;
    const message = JSON.parse(text);
    if (message.error) throw new McpError(`${method}: ${message.error.message ?? JSON.stringify(message.error)}`);
    return message.result;
  }

  private init(): Promise<void> {
    this.ready ??= (async () => {
      await this.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "open-atlas-deployer", version: "1" } });
      await this.rpc("notifications/initialized", undefined, true);
    })().catch((error) => { this.ready = undefined; throw error; });
    return this.ready;
  }

  /** Calls one tool; the answer is the tool's text parsed as JSON when it is JSON. */
  async call(name: string, args: Record<string, unknown>): Promise<any> {
    await this.init();
    const result = await this.rpc("tools/call", { name, arguments: args });
    const text = ((result?.content ?? []) as { type: string; text?: string }[]).map((c) => c.text ?? "").join("");
    if (result?.isError) throw new McpError(`${name}: ${text.slice(0, 2000)}`);
    if (result?.structuredContent) return result.structuredContent;
    try { return JSON.parse(text); } catch { return text; }
  }
}
