// Prints DEPLOYER_EMERGENCY_PASSWORD_HASH for the emergency account (§9.3). Reads the password
// from stdin so it stays out of the shell history: echo -n '...' | node bin/hash-password.ts

import { hashPassword } from "../src/server/auth.ts";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const password = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
if (password.length < 16) {
  console.error("the emergency password must be at least 16 characters");
  process.exit(2);
}
console.log(`DEPLOYER_EMERGENCY_PASSWORD_HASH=${hashPassword(password)}`);
