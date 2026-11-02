// Stand-ins for the services phase 5 talks to: GitHub (a release with its bundle, release manifests), Workbench's
// Administration API, Studio's and OMA's Builder MCPs. One fetch function, routed by host; every call is recorded.

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { readTarGz, stripTop } from "../src/server/tar.ts";

/** A .tar.gz of these files under one top directory, as release scripts make them. */
export function tarGz(files: Record<string, string>, top = "pkg"): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(`${top}/${name}`, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export interface FakeState {
  calls: string[];
  /** GitHub: release assets by "repo@tag/asset", release manifests by "repo@tag". */
  assets: Record<string, Buffer>;
  manifests: Record<string, { provides?: Record<string, string>; requires?: Record<string, string> }>;
  /** GitHub: tags and releases by repo, compares by "repo base...head", issues opened. */
  tags: Record<string, string[]>;
  releases: Record<string, { tag_name: string; name: string; draft: boolean; prerelease: boolean; published_at: string; body?: string; assets: { name: string }[] }[]>;
  compares: Record<string, { files: { filename: string; status: string; patch?: string }[]; commits: { commit: { message: string } }[] }>;
  issues: { repo: string; title: string; body: string; labels: string[]; token: string | null }[];
  workbench: {
    apps: { id: string; version: string; previousVersion?: string; agentSlots?: Record<string, { name?: string; businessAgentId: string | null }> }[];
    agents: { id: string; name: string; agentId: string; enabled: boolean }[];
    key: string;
    users: { email: string; displayName?: string; enabled: boolean; isAdmin: boolean; roleIds: string[] }[];
    roles: { id: string; name: string; enabled: boolean }[];
    /** W3: the maintenance notice, and every change to it. */
    maintenance: { message: string; startsAt: string; endsAt: string } | null;
    maintenanceLog: string[];
    /** §15: what /api/workbench/version says. */
    version?: string;
    /** §15.4 step 6: the plug-in manifest (the Deployer's own entry) and each entry's visibility. */
    plugins: Record<string, unknown>[];
    visibility: Record<string, { mode: string; groupIds: string[] }>;
  };
  studio: { draft: string; revision: number; uploaded?: string; queries: string[]; published: number; graph: string };
  oma: { packages: number; revision: number; agents: string[]; failPublish?: boolean;
    /** OMA's REST API (x-api-key oma_test): sessions the Deployer opens, and what the Agent answers in them. */
    sessions: { id: string; body: Record<string, unknown>; messages: string[] }[]; reply: string;
    /** §15.4 step 6: what OMA's REST API knows (agents by id, Environments, Vault credentials), and whether it answers. */
    down?: boolean; rest?: { agents: Record<string, { archived_at?: string }>; environments: string[]; credentials: Record<string, { auth: { mcp_server_url: string }; archived_at?: string | null }[]>; hidden?: string[] } };
}

export function fakeState(): FakeState {
  return {
    calls: [],
    assets: {},
    manifests: {},
    tags: {},
    releases: {},
    compares: {},
    issues: [],
    workbench: { apps: [], agents: [], key: "wbk_test",
      users: [{ email: "u@x", displayName: "U", enabled: true, isAdmin: false, roleIds: ["r_uat"] }, { email: "p@x", enabled: true, isAdmin: false, roleIds: ["r_prod"] }, { email: "a@x", enabled: true, isAdmin: true, roleIds: [] }],
      roles: [{ id: "r_uat", name: "deploy-uat", enabled: true }, { id: "r_prod", name: "deploy-prod", enabled: true }],
      maintenance: null, maintenanceLog: [], plugins: [], visibility: {} },
    studio: { graph: "acme/book", draft: '{:contract {:contract/family "atlas-semantic"}\n :workspace {:workspace/id "ws-uat"}\n :graph {:graph/id "g-uat" :graph/label "Book"}}', revision: 3, queries: [], published: 0 },
    oma: { packages: 0, revision: 0, agents: [], sessions: [], reply: "" },
  };
}

async function mcp(request: Request, tool: (name: string, args: Record<string, any>) => unknown): Promise<Response> {
  const message = await request.json() as { id?: number; method: string; params?: { name: string; arguments: Record<string, any> } };
  if (message.id === undefined) return new Response(null, { status: 202 });
  if (message.method === "initialize") return Response.json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: {} } }, { headers: { "mcp-session-id": "s1" } });
  try {
    const out = tool(message.params!.name, message.params!.arguments);
    return Response.json({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(out) }] } });
  } catch (error) {
    return Response.json({ jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text: (error as Error).message }] } });
  }
}

export function fakeServices(s: FakeState): typeof fetch {
  return (async (input: URL | string | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    const call = `${request.method} ${url.host}${url.pathname}`;
    s.calls.push(call);
    if (url.host === "api.github.test") {
      let m = /^\/repos\/([^/]+\/[^/]+)\/releases\/tags\/(.+)$/.exec(url.pathname);
      if (m && !Object.keys(s.assets).some((k) => k.startsWith(`${m![1]}@${decodeURIComponent(m![2]!)}/`))) {
        const r = (s.releases[m[1]!] ?? []).find((x) => x.tag_name === decodeURIComponent(m![2]!));
        if (r) return Response.json({ ...r, assets: [] });
      }
      if (m) {
        const assets = Object.keys(s.assets).filter((k) => k.startsWith(`${m![1]}@${decodeURIComponent(m![2]!)}/`));
        if (!assets.length) return new Response("{}", { status: 404 });
        return Response.json({ assets: assets.map((k) => ({ name: k.split("/").at(-1), url: `https://api.github.test/assets/${encodeURIComponent(k)}` })) });
      }
      m = /^\/repos\/([^/]+\/[^/]+)\/tags$/.exec(url.pathname);
      if (m) return Response.json((s.tags[m[1]!] ?? []).map((name) => ({ name })));
      m = /^\/repos\/([^/]+\/[^/]+)\/releases$/.exec(url.pathname);
      if (m) return Response.json(s.releases[m[1]!] ?? []);
      m = /^\/repos\/([^/]+\/[^/]+)\/compare\/(.+)$/.exec(url.pathname);
      if (m) { const c = s.compares[`${m[1]} ${decodeURIComponent(m[2]!)}`]; return c ? Response.json(c) : new Response("{}", { status: 404 }); }
      m = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(url.pathname);
      if (m && request.method === "POST") {
        const body = await request.json() as { title: string; body: string; labels: string[] };
        s.issues.push({ repo: m[1]!, ...body, token: request.headers.get("authorization") });
        return Response.json({ html_url: `https://github.com/${m[1]}/issues/${s.issues.length}` }, { status: 201 });
      }
      m = /^\/assets\/(.+)$/.exec(url.pathname);
      if (m) return new Response(new Uint8Array(s.assets[decodeURIComponent(m[1]!)]!));
      m = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(url.pathname);
      if (m) {
        const doc = s.manifests[`${m[1]}@${url.searchParams.get("ref")}`];
        return doc ? new Response(JSON.stringify(doc)) : new Response("{}", { status: 404 });
      }
    }
    if (url.host === "workbench:8090") {
      if (url.pathname === "/api/workbench/version") return Response.json({ serverBuild: "b", version: s.workbench.version ?? "1.25.1" });
      if (request.headers.get("authorization") !== `Bearer ${s.workbench.key}`) return Response.json({ finding: { code: "auth/admin-token-invalid" } }, { status: 401 });
      const wb = s.workbench;
      if (url.pathname === "/api/workbench/admin/apps" && request.method === "GET") return Response.json({ apps: wb.apps });
      if (url.pathname === "/api/workbench/admin/apps/upload") {
        const file = (await request.formData()).get("package") as File;
        const files = stripTop(readTarGz(Buffer.from(await file.arrayBuffer())));
        const app = JSON.parse(files.get("app/app.json")!.toString()) as { id: string; version: string; agentSlots?: Record<string, { name: string }> };
        const existing = wb.apps.find((a) => a.id === app.id);
        if (existing) { existing.previousVersion = existing.version; existing.version = app.version; }
        // As Workbench does: a new app's slots bind by name to the one enabled Business Agent of that name.
        const bound: Record<string, string> = {};
        if (!existing) {
          wb.apps.push({ id: app.id, version: app.version, agentSlots: Object.fromEntries(Object.entries(app.agentSlots ?? {}).map(([k, v]) => {
            const match = wb.agents.filter((a) => a.enabled && a.name === v.name);
            if (match.length === 1) bound[k] = match[0]!.id;
            return [k, { name: v.name, businessAgentId: bound[k] ?? null }];
          })) });
        }
        return Response.json({ app: { id: app.id, version: app.version }, bound }, { status: 201 });
      }
      let m = /^\/api\/workbench\/admin\/apps\/([^/]+)\/switch-version$/.exec(url.pathname);
      if (m) {
        const a = wb.apps.find((x) => x.id === m![1])!;
        [a.version, a.previousVersion] = [a.previousVersion!, a.version];
        return Response.json({ version: a.version });
      }
      if (url.pathname === "/api/workbench/admin/business-agents") return Response.json({ agents: wb.agents });
      if (url.pathname === "/api/workbench/admin/users") return Response.json({ users: wb.users });
      if (url.pathname === "/api/workbench/admin/maintenance" && request.method === "PUT") { wb.maintenance = await request.json() as typeof wb.maintenance; wb.maintenanceLog.push(`set ${wb.maintenance!.message}`); return Response.json({ notice: wb.maintenance }); }
      if (url.pathname === "/api/workbench/admin/maintenance" && request.method === "DELETE") { wb.maintenance = null; wb.maintenanceLog.push("cleared"); return Response.json({ notice: null }); }
      if (url.pathname === "/api/workbench/admin/roles" && request.method === "POST") {
        const body = await request.json() as { name: string };
        if (wb.roles.some((r) => r.name === body.name)) return Response.json({ finding: { code: "role/duplicate" } }, { status: 409 });
        const role = { id: `r_${body.name}`, name: body.name, enabled: true };
        wb.roles.push(role);
        return Response.json({ role }, { status: 201 });
      }
      if (url.pathname === "/api/workbench/admin/roles") return Response.json({ roles: wb.roles });
      if (url.pathname === "/api/workbench/admin/plugins" && request.method === "GET") return Response.json({ plugins: wb.plugins.map((p) => ({ ...p, dataTokenConfigured: false, visibility: wb.visibility[String(p.id)] ?? null, linkedAgents: [] })) });
      m = /^\/api\/workbench\/admin\/plugins\/([^/]+)\/visibility$/.exec(url.pathname);
      if (m && request.method === "PUT") { wb.visibility[m[1]!] = await request.json() as { mode: string; groupIds: string[] }; return Response.json({ visibility: wb.visibility[m[1]!] }); }
      m = /^\/api\/workbench\/admin\/plugins\/([^/]+)$/.exec(url.pathname);
      if (m && request.method === "PUT") {
        const entry = await request.json() as Record<string, unknown>;
        if (entry.id !== m[1] || "visibility" in entry || "linkedAgents" in entry) return Response.json({ finding: { code: "plugin/entry-invalid" } }, { status: 400 });
        const at = wb.plugins.findIndex((p) => p.id === m![1]);
        if (at >= 0) wb.plugins[at] = entry; else wb.plugins.push(entry);
        return Response.json({ plugin: entry }, { status: at >= 0 ? 200 : 201 });
      }
      m = /^\/api\/workbench\/admin\/business-agents\/([^/]+)$/.exec(url.pathname);
      if (m && request.method === "PATCH") {
        const body = await request.json() as { agentId: string };
        wb.agents.find((a) => a.id === m![1])!.agentId = body.agentId;
        return Response.json({ agent: wb.agents.find((a) => a.id === m![1]) });
      }
    }
    if (url.host === "studio.test") {
      if (request.headers.get("authorization") !== "Bearer oaw_v1.test") return new Response("no", { status: 401 });
      return mcp(request, (name, args) => {
        s.calls.push(`studio ${name}`);
        if (args.graph !== s.studio.graph) throw new Error(`no graph ${args.graph}`);
        if (name === "get_graph") return { text: s.studio.uploaded ?? s.studio.draft, revision: s.studio.revision };
        if (name === "upload_graph") {
          if (args.expected_revision !== s.studio.revision) throw new Error("revision conflict");
          s.studio.uploaded = args.text; s.studio.revision++;
          return { revision: s.studio.revision };
        }
        if (name === "save_saved_query") { s.studio.queries.push(args.name); return { saved: args.name }; }
        if (name === "publish_graph") { s.studio.published++; return { version: s.studio.published }; }
        throw new Error(`unknown tool ${name}`);
      });
    }
    if (url.host === "oma.test" && s.oma.down) throw new TypeError("fetch failed");
    if (url.host === "oma.test" && url.pathname === "/health") return Response.json({ status: "ok" });
    if (url.host === "oma.test" && url.pathname.startsWith("/v1/")) {
      if (request.headers.get("x-api-key") !== "oma_test") return new Response("no", { status: 401 });
      const rest = s.oma.rest ?? { agents: {}, environments: [], credentials: {} };
      if (url.pathname === "/v1/agents" && request.method === "GET") return Response.json({ data: Object.keys(rest.agents).map((id) => ({ id })) });
      let r = /^\/v1\/agents\/([^/]+)$/.exec(url.pathname);
      if (r && request.method === "GET") { const a = rest.agents[r[1]!]; return a ? Response.json({ id: r[1], archived_at: a.archived_at ?? null }) : new Response("{}", { status: 404 }); }
      r = /^\/v1\/environments\/([^/]+)$/.exec(url.pathname);
      if (r && request.method === "GET") return rest.environments.includes(r[1]!) ? Response.json({ id: r[1] }) : new Response("{}", { status: 404 });
      // Like OMA, a Vault the key does not own reads fine but its credentials are hidden (resource_not_found).
      r = /^\/v1\/vaults\/([^/]+)$/.exec(url.pathname);
      if (r && request.method === "GET") return rest.credentials[r[1]!] || rest.hidden?.includes(r[1]!) ? Response.json({ id: r[1], archived_at: null }) : new Response("{}", { status: 404 });
      r = /^\/v1\/vaults\/([^/]+)\/credentials$/.exec(url.pathname);
      if (r && request.method === "GET") { const c = rest.credentials[r[1]!]; return c ? Response.json({ data: c }) : new Response("{}", { status: 404 }); }
      if (url.pathname === "/v1/sessions" && request.method === "POST") {
        const id = `sess_${s.oma.sessions.length + 1}`;
        s.oma.sessions.push({ id, body: await request.json() as Record<string, unknown>, messages: [] });
        return Response.json({ id });
      }
      const m = /^\/v1\/sessions\/([^/]+)\/events$/.exec(url.pathname);
      const session = m && s.oma.sessions.find((x) => x.id === m[1]);
      if (session && request.method === "POST") {
        const body = await request.json() as { events: { content: { text: string }[] }[] };
        session.messages.push(...body.events.map((e) => e.content.map((c) => c.text).join("")));
        return new Response(null, { status: 202 }); // as OMA answers

      }
      if (session) return Response.json({ data: s.oma.reply ? [{ type: "user.message" }, { type: "agent.message", content: [{ type: "text", text: s.oma.reply }] }, { type: "session.status_idle" }] : [{ type: "user.message" }] });
      return new Response("{}", { status: 404 });
    }
    if (url.host === "oma.test") {
      if (request.headers.get("authorization") !== "Bearer omab_test") return new Response("no", { status: 401 });
      return mcp(request, (name, args) => {
        s.calls.push(`oma ${name}`);
        if (name === "create_package_draft") { s.oma.packages++; return { id: `pkg_${s.oma.packages}` }; }
        if (name === "update_package_manifest") { s.oma.revision++; (s as any).lastManifest = args; return { revision: s.oma.revision }; }
        if (name === "validate_package") return { valid: true };
        if (name === "publish_package") {
          if (s.oma.failPublish) throw new Error("model not available");
          const id = `agent_${s.oma.agents.length + 1}`;
          s.oma.agents.push(id);
          return { revision: s.oma.revision, agents: [{ agent_id: id }] };
        }
        throw new Error(`unknown tool ${name}`);
      });
    }
    return new Response("unexpected", { status: 599 });
  }) as typeof fetch;
}
