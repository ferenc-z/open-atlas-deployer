// Issues a host's executor token (design §7.4, D35) on the Deployer's host, for the first install when nobody can sign
// in to the page yet. The token goes straight into a file (mode 600) and is never printed; copy that file to the
// host's EXECUTOR_TOKEN_FILE. Later tokens are issued on the Hosts page. S18: the last argument says which of the
// host's executors the token is for (deploy, the default, or service); --revoke revokes that executor's tokens.
// Usage: node bin/executor-token.ts <state directory (DEPLOYER_DATA)> <host> <token file> [deploy|service]
//        node bin/executor-token.ts <state directory> <host> --revoke <deploy|service>

import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tokenSha256 } from "../src/server/handoff.ts";
import { Store } from "../src/server/store.ts";

const usage = "usage: node bin/executor-token.ts <state directory> <host> <token file> [deploy|service]\n" +
  "       node bin/executor-token.ts <state directory> <host> --revoke <deploy|service>";
const [dataDir, host, file, kind = "deploy"] = process.argv.slice(2);
if (!dataDir || !host || !file) { console.error(usage); process.exit(2); }
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(host)) { console.error(`${host} is not a host name`); process.exit(2); }
if (kind !== "deploy" && kind !== "service") { console.error(`${kind} is not an executor (deploy or service)`); process.exit(2); }
const actor = { id: "executor-token", via: "cli" as const };
if (file === "--revoke") {
  const store = new Store(join(dataDir, "deployer.db"));
  const n = store.revokeExecutorTokens(host, actor, kind);
  store.close();
  console.log(`revoked ${n} ${kind} executor token(s) of ${host}`);
  process.exit(0);
}
if (existsSync(file)) { console.error(`${file} exists; remove it first (revoke the old token on the Hosts page)`); process.exit(1); }
const store = new Store(join(dataDir, "deployer.db"));
const token = `dpe_${randomBytes(24).toString("base64url")}`;
writeFileSync(file, `${token}\n`, { mode: 0o600 });
store.addExecutorToken(host, tokenSha256(token), token.slice(0, 10), actor, kind);
store.close();
console.log(`issued a ${kind} executor token for ${host} (prefix ${token.slice(0, 10)}…) into ${file}`);
