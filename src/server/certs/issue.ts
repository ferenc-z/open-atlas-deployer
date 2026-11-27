// S40: the NiFi certificate a service executor connects to its NiFi with, from the certificate library. A service is
// bound to one version (service_cert_bindings); the heartbeat's watch entries name it (a reference, never a key), and
// the executor fetches the PEM with its own token when the reference changes (GET /executor/v1/nifi-certs/<service>).
// While a change of the service is running whose revision holds the key store of another library version, that one
// is the pending version: its CA joins the bundle (NiFi restarts on either side of the change), and the client
// certificate stays the bound one until the binding moves (S41: "trust both CAs first, switch the client certificate
// after the restart").

import { createHash } from "node:crypto";
import type { SecretBox } from "../secretbox.ts";
import type { Store } from "../store.ts";

/** What a watch entry says of its service's certificate. null: none chosen, the executor cannot call this NiFi. */
export interface CertRef { cert: string; version: number; sha256: string; pending: { cert: string; version: number } | null }

/** What the executor gets: the client certificate (chain, leaf first), its key and the CA bundle, all PEM. */
export interface ExecutorCert {
  service: string; cert: string; version: number; subject: string; sha256: string;
  certificatePem: string; privateKeyPem: string; caPem: string; pending: { cert: string; version: number } | null;
}

export const UNBOUND_MESSAGE = "No certificate is chosen for this service: choose one from the certificate library, or the service executor cannot connect to this NiFi.";

interface Sealed { keystore?: string; chainPem?: string; privateKeyPem?: string; caPem?: string }

const open = (store: Store, box: SecretBox, cert: string, version: number): Sealed | undefined => {
  const sealed = store.nifiCertSealed(cert, version);
  if (!sealed) return undefined;
  try { return JSON.parse(box.open(sealed)) as Sealed; } catch { return undefined; }
};

// The sha256 of each version's key store file, by "cert#version": a version never changes, so once is enough.
const keystoreShas = new Map<string, string | null>();
const keystoreSha = (store: Store, box: SecretBox, cert: string, version: number): string | null => {
  const key = `${cert}#${version}`;
  if (!keystoreShas.has(key)) {
    const k = open(store, box, cert, version)?.keystore;
    keystoreShas.set(key, k ? createHash("sha256").update(Buffer.from(k, "base64")).digest("hex") : null);
    if (keystoreShas.size > 500) keystoreShas.delete(keystoreShas.keys().next().value!);
  }
  return keystoreShas.get(key)!;
};

/** The library version a running change of the service puts on its nodes, when it is not the bound one. */
export function pendingCert(store: Store, box: SecretBox | undefined, service: string, bound: { cert: string; version: number }): { cert: string; version: number } | null {
  const change = store.activeServiceChange(service);
  if (!box || !change?.revision) return null;
  const body = store.serviceConfig(service, change.revision)?.body;
  const shas = new Set((body?.members ?? []).flatMap((m) => m.files.filter((f) => f.name === "keystore").map((f) => f.sha256)));
  if (!shas.size) return null;
  for (const c of store.nifiCerts()) {
    for (const v of c.versions) {
      if (c.id === bound.cert && v.version === bound.version) continue;
      const sha = keystoreSha(store, box, c.id, v.version);
      if (sha && shas.has(sha)) return { cert: c.id, version: v.version };
    }
  }
  return null;
}

/** The reference a watch entry carries (null: no certificate chosen). */
export function certRef(store: Store, box: SecretBox | undefined, service: string): CertRef | null {
  const b = store.serviceCertBindings().find((x) => x.service === service);
  if (!b) return null;
  const v = store.nifiCert(b.cert)?.versions.find((x) => x.version === b.version);
  if (!v) return null;
  return { cert: b.cert, version: b.version, sha256: v.sha256, pending: pendingCert(store, box, service, b) };
}

/** The services registered on a host (a standalone's, or a cluster with a node there). */
export function servicesOn(store: Store, host: string): Set<string> {
  return new Set([
    ...store.standalones().filter((s) => s.member.host === host).map((s) => s.id),
    ...store.clusters().filter((c) => c.nodes.some((n) => n.host === host)).map((c) => c.id),
  ]);
}

export type IssueResult =
  | { ok: true; cert: ExecutorCert }
  | { ok: false; status: 404 | 409 | 503; code: string; message: string };

/** GET /executor/v1/nifi-certs/<service> for the service executor of host: only a service registered on that host. */
export function executorCert(store: Store, box: SecretBox | undefined, host: string, service: string): IssueResult {
  // Not on this host, or no such service: the same answer, so a token learns nothing of other hosts' services.
  if (!servicesOn(store, host).has(service)) return { ok: false, status: 404, code: "cert/not-watched", message: `${service} is not a service registered on ${host}.` };
  if (!box) return { ok: false, status: 503, code: "cert/no-key", message: "DEPLOYER_CREDENTIAL_ENCRYPTION_KEY is not set: the certificate library cannot be opened." };
  const ref = certRef(store, box, service);
  if (!ref) return { ok: false, status: 409, code: "cert/unbound", message: UNBOUND_MESSAGE };
  const s = open(store, box, ref.cert, ref.version);
  if (!s?.chainPem || !s.privateKeyPem) return { ok: false, status: 503, code: "cert/unreadable", message: `Certificate ${ref.cert} version ${ref.version} cannot be opened with this Deployer's key.` };
  const subject = store.nifiCert(ref.cert)?.versions.find((v) => v.version === ref.version)?.subject ?? "";
  const cas = [s.caPem ?? ""];
  if (ref.pending) cas.push(open(store, box, ref.pending.cert, ref.pending.version)?.caPem ?? "");
  return {
    ok: true,
    cert: {
      service, cert: ref.cert, version: ref.version, subject, sha256: ref.sha256,
      certificatePem: s.chainPem, privateKeyPem: s.privateKeyPem, caPem: joinPem(cas), pending: ref.pending,
    },
  };
}

/** PEM bundles joined, each certificate once. */
export function joinPem(bundles: string[]): string {
  const blocks = bundles.flatMap((b) => b.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map((b) => b.trim());
  return [...new Set(blocks)].map((b) => `${b}\n`).join("");
}
