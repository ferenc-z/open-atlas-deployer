// Makes the read-only key PROD's Deployer uses to read UAT's (design §6.3).
// Usage: node bin/peer-key.ts
//   the key goes into a file on the PROD host (DEPLOYER_UAT_KEY_FILE, mode 600);
//   its SHA-256 goes into UAT's env file (DEPLOYER_PEER_KEY_SHA256).

import { sha256 } from "../src/server/auth.ts";
import { newPeerKey } from "../src/server/peer.ts";

const key = newPeerKey();
console.log(`key (PROD, DEPLOYER_UAT_KEY_FILE):      ${key}`);
console.log(`sha256 (UAT, DEPLOYER_PEER_KEY_SHA256): ${sha256(key)}`);
