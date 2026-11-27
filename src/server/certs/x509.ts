// S41: what the certificate library shows and checks about one X.509 certificate. Names are written the way NiFi (Java's
// X500Name.toString) writes them, e.g. "CN=S2S, OU=NIFI": most specific RDN first, ", " between RDNs, " + " within one.

import { createHash, X509Certificate } from "node:crypto";
import { children, DerError, expect, oid, octets, parseDer, seq, TAG, text, time, type Der } from "./der.ts";

export interface SanEntry { type: "DNS" | "IP" | "EMAIL" | "URI"; value: string }

export interface CertInfo {
  subject: string;
  issuer: string;
  san: SanEntry[];
  notBefore: string;
  notAfter: string;
  /** Extended key usages: "serverAuth", "clientAuth", … or the OID; null when the certificate has no EKU extension. */
  eku: string[] | null;
  isCa: boolean;
  serial: string;
  /** SHA-256 of the DER, upper-case hex pairs joined by ":" (keytool's format). */
  sha256: string;
  pem: string;
}

const NAME_KEYS: Record<string, string> = {
  "2.5.4.3": "CN", "2.5.4.6": "C", "2.5.4.7": "L", "2.5.4.8": "ST", "2.5.4.9": "STREET", "2.5.4.10": "O", "2.5.4.11": "OU",
  "2.5.4.12": "T", "2.5.4.4": "SURNAME", "2.5.4.42": "GIVENNAME", "2.5.4.43": "INITIALS", "2.5.4.44": "GENERATION",
  "2.5.4.46": "DNQUALIFIER", "2.5.4.5": "SERIALNUMBER", "0.9.2342.19200300.100.1.25": "DC", "0.9.2342.19200300.100.1.1": "UID",
  "1.2.840.113549.1.9.1": "EMAILADDRESS",
};

const EKU_NAMES: Record<string, string> = {
  "1.3.6.1.5.5.7.3.1": "serverAuth", "1.3.6.1.5.5.7.3.2": "clientAuth", "1.3.6.1.5.5.7.3.3": "codeSigning",
  "1.3.6.1.5.5.7.3.4": "emailProtection", "1.3.6.1.5.5.7.3.8": "timeStamping", "1.3.6.1.5.5.7.3.9": "OCSPSigning",
  "2.5.29.37.0": "anyExtendedKeyUsage",
};

function avaValue(v: string): string {
  if (v === "" || /[,+=\n<>#;\\"]/.test(v) || /^\s|\s$/.test(v)) return `"${v.replace(/["\\]/g, (c) => `\\${c}`)}"`;
  return v;
}

/** A Name as Java prints it. */
export function formatName(name: Der): string {
  const rdns = seq(name).map((set) =>
    children(expect(set, TAG.SET)).map((atv) => {
      const [type, value] = seq(atv);
      const o = oid(type);
      const key = NAME_KEYS[o];
      return key ? `${key}=${avaValue(text(value))}` : `OID.${o}=#${value.raw.toString("hex")}`;
    }).join(" + "));
  return rdns.reverse().join(", ");
}

function ipText(b: Buffer): string {
  if (b.length === 4) return [...b].join(".");
  if (b.length === 16) {
    const words: string[] = [];
    for (let i = 0; i < 16; i += 2) words.push(b.readUInt16BE(i).toString(16));
    return words.join(":");
  }
  return b.toString("hex");
}

function sans(value: Buffer): SanEntry[] {
  const out: SanEntry[] = [];
  for (const g of seq(parseDer(value))) {
    switch (g.tag) {
      case 0x81: out.push({ type: "EMAIL", value: g.value.toString("utf8") }); break;
      case 0x82: out.push({ type: "DNS", value: g.value.toString("utf8") }); break;
      case 0x86: out.push({ type: "URI", value: g.value.toString("utf8") }); break;
      case 0x87: out.push({ type: "IP", value: ipText(g.value) }); break;
    }
  }
  return out;
}

export function fingerprint(der: Buffer): string {
  return createHash("sha256").update(der).digest("hex").toUpperCase().match(/../g)!.join(":");
}

/** Reads a DER certificate. Throws DerError (or Node's error) when it is not one. */
export function certInfo(der: Buffer): CertInfo {
  const x = new X509Certificate(der);
  const tbs = seq(seq(parseDer(der))[0]);
  let i = tbs[0].tag === 0xa0 ? 1 : 0;
  const serial = expect(tbs[i++], TAG.INTEGER).value.toString("hex").replace(/^(00)+(?=.)/, "").toUpperCase();
  i++; // signature algorithm
  const issuer = formatName(tbs[i++]);
  const validity = seq(tbs[i++]);
  const subject = formatName(tbs[i++]);
  i++; // subject public key
  let san: SanEntry[] = [], eku: string[] | null = null, isCa = false;
  for (const el of tbs.slice(i)) {
    if (el.tag !== 0xa3) continue;
    for (const ext of seq(children(el)[0])) {
      const parts = seq(ext);
      const id = oid(parts[0]);
      const value = octets(parts[parts.length - 1]);
      if (id === "2.5.29.17") san = sans(value);
      else if (id === "2.5.29.37") eku = seq(parseDer(value)).map((o) => { const s = oid(o); return EKU_NAMES[s] ?? s; });
      else if (id === "2.5.29.19") { const bc = seq(parseDer(value)); isCa = bc[0]?.tag === 0x01 && bc[0].value[0] !== 0; }
    }
  }
  if (validity.length !== 2) throw new DerError("bad validity");
  return {
    subject, issuer, san, eku, isCa, serial,
    notBefore: time(validity[0]).toISOString(), notAfter: time(validity[1]).toISOString(),
    sha256: fingerprint(der), pem: x.toString(),
  };
}

/** Certificates in PEM text, in order, as DER. */
export function pemCerts(pem: string): Buffer[] {
  return [...pem.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)].map((m) => Buffer.from(m[1].replace(/\s+/g, ""), "base64"));
}

/** Whether issuer signed cert. */
export function issued(issuer: X509Certificate, cert: X509Certificate): boolean {
  try { return cert.checkIssued(issuer) && cert.verify(issuer.publicKey); } catch { return false; }
}
