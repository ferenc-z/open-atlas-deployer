// S41: checking an uploaded certificate for one service. The upload is opened once (openUpload); each service is then
// checked on its own (checkForService) against its nodes' host names and the certificate it uses now. A service whose
// check fails cannot be picked for the change; the others are unaffected.

import { isIP } from "node:net";
import { X509Certificate } from "node:crypto";
import { CertError, parseKeystore, parseTruststore, type ParsedKeystore, type ParsedTruststore, type StoreType } from "./keystore.ts";
import { issued, pemCerts } from "./x509.ts";

export interface StoreInput { bytes: Buffer; type: StoreType; password: string; keyPassword?: string }
export interface OpenedUpload { keystore: ParsedKeystore | CertError; truststore: ParsedTruststore | CertError }

export function openUpload(upload: { keystore: StoreInput; truststore: StoreInput }): OpenedUpload {
  const attempt = <T>(f: () => T): T | CertError => { try { return f(); } catch (e) { if (e instanceof CertError) return e; throw e; } };
  const k = upload.keystore, t = upload.truststore;
  return {
    keystore: attempt(() => parseKeystore(k.bytes, k.type, k.password, k.keyPassword)),
    truststore: attempt(() => parseTruststore(t.bytes, t.type, t.password)),
  };
}

export type CheckCode = "open" | "eku" | "san" | "trusts-current" | "trusts-new" | "validity";
export interface CheckItem {
  code: CheckCode;
  ok: boolean;
  message: string;
  /** san: the host names the certificate does not cover. */
  missing?: string[];
  /** open: why a file did not open. */
  error?: { file: "keystore" | "truststore"; kind: CertError["kind"] };
}
export interface CertCheck { ok: boolean; items: CheckItem[] }

export interface ServiceCheckInput {
  /** Every node's host name (or IP address) as the service's members are registered. */
  hosts: string[];
  /** The certificate the service uses now: PEM text (leaf first, chain may follow) or DER certificates. None for a
   *  service without TLS yet. */
  current?: string | Buffer[];
  now?: Date;
}

/** Whether a SAN DNS name (wildcard allowed in the leftmost label only, for one label) covers a host name. */
function dnsMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase().replace(/\.$/, ""), h = host.toLowerCase().replace(/\.$/, "");
  if (!p.startsWith("*.")) return p === h;
  const dot = h.indexOf(".");
  return dot > 0 && h.slice(dot + 1) === p.slice(2);
}

function normIp(ip: string): string {
  try { return new URL(`http://${isIP(ip) === 6 ? `[${ip}]` : ip}/`).hostname.replace(/^\[|\]$/g, ""); } catch { return ip; }
}

function covers(cert: ParsedKeystore["certificate"], host: string): boolean {
  if (isIP(host)) {
    const want = normIp(host);
    return cert.san.some((s) => s.type === "IP" && normIp(s.value) === want);
  }
  return cert.san.some((s) => s.type === "DNS" && dnsMatches(s.value, host));
}

/** Whether a store trusting `anchors` accepts `chain` (leaf first): some certificate on the way up from the leaf is an
 *  anchor itself or is signed by one. */
function trusts(anchors: X509Certificate[], chain: X509Certificate[]): boolean {
  let cur: X509Certificate | undefined = chain[0];
  const seen = new Set<X509Certificate>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const c: X509Certificate = cur;
    if (anchors.some((a) => a.raw.equals(c.raw) || issued(a, c))) return true;
    cur = chain.find((n) => !seen.has(n) && issued(n, c));
  }
  return false;
}

export function checkForService(opened: OpenedUpload, input: ServiceCheckInput): CertCheck {
  const items: CheckItem[] = [];
  const { keystore: ks, truststore: ts } = opened;
  const failed: CheckItem["error"][] = [];
  if (ks instanceof CertError) failed.push({ file: "keystore", kind: ks.kind });
  if (ts instanceof CertError) failed.push({ file: "truststore", kind: ts.kind });
  items.push(failed.length === 0
    ? { code: "open", ok: true, message: "The keystore and truststore open with the given passwords." }
    : { code: "open", ok: false, message: [ks, ts].filter((e) => e instanceof CertError).map((e) => (e as CertError).message).join(" "), error: failed[0] });
  if (ks instanceof CertError) return { ok: false, items };
  const cert = ks.certificate;

  const eku = cert.eku ?? [];
  const lacking = ["clientAuth", "serverAuth"].filter((u) => !eku.includes(u));
  items.push(lacking.length === 0
    ? { code: "eku", ok: true, message: "Extended key usage has clientAuth and serverAuth." }
    : { code: "eku", ok: false, message: cert.eku ? `Extended key usage lacks ${lacking.join(" and ")}.` : "The certificate has no extended key usage; NiFi needs clientAuth and serverAuth." });

  const missing = [...new Set(input.hosts)].filter((h) => !covers(cert, h));
  items.push(missing.length === 0
    ? { code: "san", ok: true, message: "The subject alternative names cover every node." }
    : { code: "san", ok: false, message: `The subject alternative names do not cover ${missing.join(", ")}.`, missing });

  const now = input.now ?? new Date();
  const from = new Date(cert.notBefore), to = new Date(cert.notAfter);
  items.push(now < from
    ? { code: "validity", ok: false, message: `The certificate is not valid before ${cert.notBefore}.` }
    : now >= to
      ? { code: "validity", ok: false, message: `The certificate expired on ${cert.notAfter}.` }
      : { code: "validity", ok: true, message: `The certificate is valid until ${cert.notAfter}.` });

  if (!(ts instanceof CertError)) {
    const anchors = ts.certificates.map((c) => new X509Certificate(c.pem));
    const own = ks.chain.map((c) => new X509Certificate(c.pem));
    items.push(trusts(anchors, own)
      ? { code: "trusts-new", ok: true, message: "The new truststore trusts the new certificate." }
      : { code: "trusts-new", ok: false, message: "The new truststore does not trust the new certificate." });
    const current = input.current === undefined ? [] : typeof input.current === "string" ? pemCerts(input.current) : input.current;
    if (current.length > 0) {
      let chain: X509Certificate[] | null;
      try { chain = current.map((d) => new X509Certificate(d)); } catch { chain = null; }
      items.push(!chain
        ? { code: "trusts-current", ok: false, message: "The certificate in use could not be read." }
        : trusts(anchors, chain)
          ? { code: "trusts-current", ok: true, message: "The new truststore also trusts the certificate in use, so old and new nodes can talk during the rolling restart." }
          : { code: "trusts-current", ok: false, message: "The new truststore does not trust the certificate in use; old and new nodes could not talk during the rolling restart." });
    }
  }
  return { ok: items.every((i) => i.ok), items };
}
