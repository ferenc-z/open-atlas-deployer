// S41 step 4b: the certificate library and the services. A library version becomes a draft per service (the two stores on
// every node and the TLS keys of nifi.properties); a service's binding follows the keystore it should have, by the
// file's sha256: a change that applies a draft, a rollback or an adopted file moves it, and a keystore that is no library
// version marks the service as using its own certificate. Nothing here returns a file, a password or a key.

import { createHash } from "node:crypto";
import type { SecretBox } from "../secretbox.ts";
import type { Actor, Store } from "../store.ts";
import { openFile, type ServiceConfigBody } from "../services/config.ts";
import { effectiveProperties } from "../services/configdoc.ts";
import { installKey } from "../services/draft.ts";
import { openUpload, type OpenedUpload } from "./check.ts";
import type { StoreType } from "./keystore.ts";

/** What a version's sealed blob holds (library.ts sealVersion). */
export interface VersionSecret {
  keystore: string; truststore: string; keystorePassword: string; keyPassword?: string; truststorePassword: string;
  privateKeyPem: string; chainPem: string; caPem: string;
}

export const sha256Of = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function openVersion(sealed: string, box: SecretBox): VersionSecret {
  return JSON.parse(box.open(sealed)) as VersionSecret;
}

/** The version's stores opened again, for the per-service check. */
export function openedVersion(secret: VersionSecret, types: { keystoreType: string; truststoreType: string }): OpenedUpload {
  return openUpload({
    keystore: { bytes: Buffer.from(secret.keystore, "base64"), type: types.keystoreType as StoreType, password: secret.keystorePassword, keyPassword: secret.keyPassword ?? secret.keystorePassword },
    truststore: { bytes: Buffer.from(secret.truststore, "base64"), type: types.truststoreType as StoreType, password: secret.truststorePassword },
  });
}

/** The keys of nifi.properties a certificate draft sets: the paths stay as the service has them. */
export const CERT_KEYS = ["nifi.security.keystore", "nifi.security.keystoreType", "nifi.security.keystorePasswd", "nifi.security.keyPasswd", "nifi.security.truststore", "nifi.security.truststoreType", "nifi.security.truststorePasswd"] as const;

export class CertDraftError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

/**
 * The changes (as acceptChanges takes them) that put a library version on a service: on each node its keystore and
 * truststore replaced whole, and in nifi.properties the store paths (kept as they are), types (as the files are) and
 * passwords (secrets: sealed by acceptChanges, shown hidden). A cluster gets every key on each node, since toolkit
 * installs often differ per node in exactly these keys.
 */
export function certDraftChanges(body: ServiceConfigBody, kind: "standalone" | "cluster", box: SecretBox, secret: VersionSecret, types: { keystoreType: string; truststoreType: string }): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of body.members) {
    const key = installKey(m);
    for (const store of ["keystore", "truststore"]) {
      if (!m.files.some((f) => f.name === store)) throw new CertDraftError("cert-draft/no-stores", `The kept configuration of ${key} has no ${store}: bind the certificate in use first (that reads the stores from the hosts).`);
    }
    const props = m.files.find((f) => f.name === "nifi.properties");
    const opened = props && openFile(props, box);
    if (!opened?.ok) throw new CertDraftError("cert-draft/no-properties", `${key}: nifi.properties is not kept or cannot be opened.`);
    const have = effectiveProperties(opened.bytes);
    const path = (k: string) => {
      const v = have.get(k)?.value;
      if (!v) throw new CertDraftError("cert-draft/no-tls", `${key}: nifi.properties sets no ${k}; this service does not use TLS yet.`);
      return v;
    };
    out.push({ file: "keystore", member: key, base64: secret.keystore }, { file: "truststore", member: key, base64: secret.truststore });
    const member = kind === "cluster" ? key : null;
    out.push(
      { file: "nifi.properties", member, key: "nifi.security.keystore", value: path("nifi.security.keystore") },
      { file: "nifi.properties", member, key: "nifi.security.keystoreType", value: types.keystoreType },
      { file: "nifi.properties", member, key: "nifi.security.keystorePasswd", secret: secret.keystorePassword },
      { file: "nifi.properties", member, key: "nifi.security.keyPasswd", secret: secret.keyPassword ?? secret.keystorePassword },
      { file: "nifi.properties", member, key: "nifi.security.truststore", value: path("nifi.security.truststore") },
      { file: "nifi.properties", member, key: "nifi.security.truststoreType", value: types.truststoreType },
      { file: "nifi.properties", member, key: "nifi.security.truststorePasswd", secret: secret.truststorePassword },
    );
  }
  return out;
}

const SYSTEM: Actor = { id: "deployer", via: "cli" };

/** Where a service's certificate comes from, as the keystore it should have says. */
export type CertSource = { cert: string; version: number } | { own: string | null } | null;

export class CertSources {
  private readonly shas = new Map<string, string | null>();
  private readonly store: Store;
  private readonly box: SecretBox;
  constructor(store: Store, box: SecretBox) { this.store = store; this.box = box; }

  /** The sha256 of a version's keystore file (kept sealed; opened once and remembered). */
  keystoreSha(cert: string, version: number): string | null {
    const id = `${cert}#${version}`;
    if (!this.shas.has(id)) {
      const sealed = this.store.nifiCertSealed(cert, version);
      let sha: string | null = null;
      try { if (sealed) sha = sha256Of(Buffer.from(openVersion(sealed, this.box).keystore, "base64")); } catch { /* sealed with another key */ }
      this.shas.set(id, sha);
    }
    return this.shas.get(id)!;
  }

  /** The library version whose keystore is this file: the entry the service is bound to first, then the newest. */
  versionWithKeystore(sha: string, prefer?: string): { cert: string; version: number } | undefined {
    const all = this.store.nifiCerts().flatMap((c) => c.versions.map((v) => ({ cert: c.id, version: v.version })));
    all.sort((a, b) => Number(b.cert === prefer) - Number(a.cert === prefer) || b.version - a.version);
    return all.find((v) => this.keystoreSha(v.cert, v.version) === sha);
  }

  /** The keystore sha256 each member should have now (null: no keystore kept for it). */
  keptKeystores(service: string): Map<string, string> {
    return new Map(this.store.serviceMemberFiles(service).filter((f) => f.file === "keystore").map((f) => [f.member, f.expectedSha256]));
  }

  /** Moves the binding to what the kept keystores are. A rolling change half done (nodes differ) leaves it as it is. */
  sync(service: string, actor: Actor = SYSTEM): CertSource {
    const kept = this.keptKeystores(service);
    if (!kept.size) return this.current(service);
    const shas = new Set(kept.values());
    if (shas.size > 1) {
      if (this.store.activeServiceChange(service)) return this.current(service);
      this.store.setServiceCertSource(service, { own: null }, actor);
      return { own: null };
    }
    const [sha] = shas;
    const bound = this.store.serviceCertBindings().find((b) => b.service === service);
    const found = this.versionWithKeystore(sha!, bound?.cert);
    this.store.setServiceCertSource(service, found ?? { own: sha! }, actor);
    return found ?? { own: sha! };
  }

  current(service: string): CertSource {
    const b = this.store.serviceCertBindings().find((x) => x.service === service);
    if (b) return { cert: b.cert, version: b.version };
    const own = this.store.serviceCertOwnMarks().find((x) => x.service === service);
    return own ? { own: own.sha256 } : null;
  }
}
