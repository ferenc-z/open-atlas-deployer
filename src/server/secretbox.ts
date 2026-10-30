// Secrets at rest (design §7.2): env values listed in the manifest's env.secrets are kept AES-256-GCM
// encrypted with DEPLOYER_CREDENTIAL_ENCRYPTION_KEY, which lives only in the host's env file for the
// Deployer. Comparing two environments uses an HMAC under a key both Deployers share, so a viewer
// learns whether a secret is the same in UAT and PROD, never the secret.

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const PREFIX = "v1:";

export class SecretBox {
  private key: Buffer;

  constructor(keyBase64: string) {
    const key = Buffer.from(keyBase64, "base64");
    if (key.length !== 32) throw new Error("DEPLOYER_CREDENTIAL_ENCRYPTION_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)");
    this.key = key;
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  }

  open(sealed: string): string {
    if (!sealed.startsWith(PREFIX)) throw new Error("not a sealed value");
    const raw = Buffer.from(sealed.slice(PREFIX.length), "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  }
}

/** A secret's fingerprint for comparing environments: the same only when the value and the shared key are. */
export function fingerprint(compareKey: string, app: string, key: string, value: string): string {
  return createHmac("sha256", compareKey).update(`${app}\0${key}\0${value}`).digest("base64url").slice(0, 22);
}
