// The Deployer's own version (D16): the image sets DEPLOYER_VERSION when it is built; run from a checkout, package.json.
// Its heartbeat answer tells the executor which version is up, which is how an upgrade knows the new one took over.

import { readFileSync } from "node:fs";

export const DEPLOYER_VERSION: string = process.env.DEPLOYER_VERSION
  || (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
