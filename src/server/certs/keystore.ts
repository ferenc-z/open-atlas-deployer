// S41: opening a NiFi keystore and truststore without Java. JKS is read here (Sun's format: magic 0xFEEDFEED, SHA-1
// integrity over "password + Mighty Aphrodite + body", private keys under Sun's own key protection); PKCS#12 is read
// here too (PBES2/PBKDF2 with AES, or the PKCS#12 PBE with 3DES; HMAC with the PKCS#12 key derivation). Only Node's
// crypto is used. The file's own magic decides how it is read, like Java's keystore.type.compat: a JKS-typed file that
// is PKCS#12 opens as PKCS#12, and the other way round. Errors are CertError, told apart as wrong password, a format or
// algorithm not supported, and a damaged file. No message holds a password or key material.

import { createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, pbkdf2Sync, timingSafeEqual, X509Certificate, type KeyObject } from "node:crypto";
import { children, DerError, int, oid, octets, parseDer, seq, text } from "./der.ts";
import { certInfo, issued, type CertInfo } from "./x509.ts";

export type StoreType = "JKS" | "PKCS12";
export type CertErrorKind = "bad-password" | "unsupported" | "corrupt";

export class CertError extends Error {
  readonly kind: CertErrorKind;
  constructor(kind: CertErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface ParsedKeystore {
  /** The format the bytes are in (may differ from the type asked for, see above). */
  format: StoreType;
  alias: string | null;
  privateKeyPem: string;
  /** The key's own certificate. */
  certificatePem: string;
  /** The key's certificate followed by the rest of its chain, as the store has it. */
  chainPem: string;
  certificate: CertInfo;
  chain: CertInfo[];
}

export interface TrustedCert extends CertInfo { alias: string | null }
export interface ParsedTruststore {
  format: StoreType;
  certificates: TrustedCert[];
  /** All trusted certificates, PEM, one after the other. */
  caPem: string;
}

interface RawKey { alias: string | null; pkcs8: () => Buffer; chain: Buffer[]; localKeyId?: string }
interface RawStore { format: StoreType; keys: RawKey[]; trusted: { alias: string | null; der: Buffer }[]; certs: { alias: string | null; der: Buffer; localKeyId?: string }[] }

const corrupt = (what: string) => new CertError("corrupt", `The ${what} is damaged or is not a keystore.`);

function detect(bytes: Buffer): StoreType {
  if (bytes.length >= 4) {
    const magic = bytes.readUInt32BE(0);
    if (magic === 0xfeedfeed) return "JKS";
    if (magic === 0xcececece) throw new CertError("unsupported", "JCEKS keystores are not supported; use JKS or PKCS12.");
  }
  if (bytes.length > 0 && bytes[0] === 0x30) return "PKCS12";
  throw corrupt("file");
}

function readStore(bytes: Buffer, type: StoreType, storePassword: string, keyPassword: string | undefined, what: string): RawStore {
  if (type !== "JKS" && type !== "PKCS12") throw new CertError("unsupported", `Keystore type ${String(type)} is not supported; use JKS or PKCS12.`);
  const format = detect(bytes);
  try {
    return format === "JKS" ? readJks(bytes, storePassword, keyPassword ?? storePassword) : readPkcs12(bytes, storePassword, keyPassword ?? storePassword);
  } catch (e) {
    if (e instanceof CertError) throw e;
    if (e instanceof DerError || e instanceof RangeError) throw corrupt(what);
    throw e;
  }
}

// ---- JKS ----

const utf16be = (s: string) => Buffer.from(s, "utf16le").swap16();
const sha1 = (...parts: Buffer[]) => { const h = createHash("sha1"); for (const p of parts) h.update(p); return h.digest(); };
const JKS_KEY_OID = "1.3.6.1.4.1.42.2.17.1.1";

function readJks(b: Buffer, password: string, keyPassword: string): RawStore {
  let at = 4;
  const u16 = () => { const v = b.readUInt16BE(at); at += 2; return v; };
  const u32 = () => { const v = b.readUInt32BE(at); at += 4; return v; };
  const bytes = (n: number) => { if (at + n > b.length) throw new RangeError("truncated"); const v = b.subarray(at, at + n); at += n; return v; };
  const utf = () => bytes(u16()).toString("utf8");
  const version = u32();
  if (version !== 1 && version !== 2) throw new CertError("unsupported", `JKS version ${version} is not supported.`);
  const certOf = () => {
    if (version === 2) { const t = utf(); if (t !== "X.509") throw new CertError("unsupported", `Certificates of type ${t} are not supported.`); }
    return Buffer.from(bytes(u32()));
  };
  const keys: { alias: string; protectedKey: Buffer; chain: Buffer[] }[] = [];
  const trusted: { alias: string; der: Buffer }[] = [];
  const count = u32();
  for (let i = 0; i < count; i++) {
    const tag = u32();
    const alias = utf();
    bytes(8); // date
    if (tag === 1) {
      const protectedKey = Buffer.from(bytes(u32()));
      const chain: Buffer[] = [];
      const n = u32();
      for (let j = 0; j < n; j++) chain.push(certOf());
      keys.push({ alias, protectedKey, chain });
    } else if (tag === 2) {
      trusted.push({ alias, der: certOf() });
    } else if (tag === 3) {
      throw new CertError("unsupported", "The keystore holds secret keys (JCEKS entries), which are not supported.");
    } else {
      throw new RangeError("bad entry tag");
    }
  }
  const digest = bytes(20);
  if (at !== b.length) throw new RangeError("trailing bytes");
  const expected = sha1(utf16be(password), Buffer.from("Mighty Aphrodite", "utf8"), b.subarray(0, at - 20));
  if (!timingSafeEqual(digest, expected)) {
    // The digest covers everything: a wrong password and a changed byte look the same. A store whose certificates
    // still read is taken as a wrong password.
    for (const c of [...keys.flatMap((k) => k.chain), ...trusted.map((t) => t.der)]) {
      try { new X509Certificate(c); } catch { throw corrupt("keystore"); }
    }
    throw new CertError("bad-password", "The keystore password is wrong (or the file was changed).");
  }
  return {
    format: "JKS",
    keys: keys.map((k) => ({ alias: k.alias, chain: k.chain, pkcs8: () => jksKey(k.protectedKey, keyPassword) })),
    trusted, certs: [],
  };
}

/** Sun's JKS key protection: a SHA-1 keystream from password and salt, XORed in, with a SHA-1 check over the result. */
function jksKey(protectedKey: Buffer, password: string): Buffer {
  let alg: string, data: Buffer;
  try {
    const epki = seq(parseDer(protectedKey));
    alg = oid(seq(epki[0])[0]);
    data = octets(epki[1]);
  } catch { throw corrupt("private key"); }
  if (alg !== JKS_KEY_OID) throw new CertError("unsupported", `The private key is protected with ${alg}, which is not supported.`);
  if (data.length < 41) throw corrupt("private key");
  const pwd = utf16be(password);
  const salt = data.subarray(0, 20), enc = data.subarray(20, data.length - 20), check = data.subarray(data.length - 20);
  const plain = Buffer.alloc(enc.length);
  let block = salt as Buffer;
  for (let off = 0; off < enc.length; off += 20) {
    block = sha1(pwd, block);
    for (let j = 0; j < 20 && off + j < enc.length; j++) plain[off + j] = enc[off + j] ^ block[j];
  }
  if (!timingSafeEqual(sha1(pwd, plain), check)) throw new CertError("bad-password", "The key password is wrong.");
  return plain;
}

// ---- PKCS#12 ----

const OID = {
  data: "1.2.840.113549.1.7.1", encryptedData: "1.2.840.113549.1.7.6",
  keyBag: "1.2.840.113549.1.12.10.1.1", shroudedKeyBag: "1.2.840.113549.1.12.10.1.2", certBag: "1.2.840.113549.1.12.10.1.3",
  safeContentsBag: "1.2.840.113549.1.12.10.1.6", x509Cert: "1.2.840.113549.1.9.22.1",
  friendlyName: "1.2.840.113549.1.9.20", localKeyId: "1.2.840.113549.1.9.21", javaTrusted: "2.16.840.1.113894.746875.1.1",
  pbes2: "1.2.840.113549.1.5.13", pbkdf2: "1.2.840.113549.1.5.12", pbmac1: "1.2.840.113549.1.5.14",
};
const HASHES: Record<string, string> = {
  "1.3.14.3.2.26": "sha1", "2.16.840.1.101.3.4.2.4": "sha224", "2.16.840.1.101.3.4.2.1": "sha256", "2.16.840.1.101.3.4.2.2": "sha384", "2.16.840.1.101.3.4.2.3": "sha512",
};
const PRFS: Record<string, string> = {
  "1.2.840.113549.2.7": "sha1", "1.2.840.113549.2.8": "sha224", "1.2.840.113549.2.9": "sha256", "1.2.840.113549.2.10": "sha384", "1.2.840.113549.2.11": "sha512",
};
const PBES2_CIPHERS: Record<string, { name: string; key: number }> = {
  "2.16.840.1.101.3.4.1.2": { name: "aes-128-cbc", key: 16 }, "2.16.840.1.101.3.4.1.22": { name: "aes-192-cbc", key: 24 },
  "2.16.840.1.101.3.4.1.42": { name: "aes-256-cbc", key: 32 }, "1.2.840.113549.3.7": { name: "des-ede3-cbc", key: 24 },
};
const P12_CIPHERS: Record<string, { name: string; key: number; iv: number }> = {
  "1.2.840.113549.1.12.1.1": { name: "rc4", key: 16, iv: 0 }, "1.2.840.113549.1.12.1.2": { name: "rc4-40", key: 5, iv: 0 },
  "1.2.840.113549.1.12.1.3": { name: "des-ede3-cbc", key: 24, iv: 8 }, "1.2.840.113549.1.12.1.4": { name: "des-ede-cbc", key: 16, iv: 8 },
  "1.2.840.113549.1.12.1.5": { name: "rc2-cbc", key: 16, iv: 8 }, "1.2.840.113549.1.12.1.6": { name: "rc2-40-cbc", key: 5, iv: 8 },
};

/** Decryption gave no sensible result: wrong password, or damage. */
class DecryptFailed extends Error {}

const bmp = (s: string) => Buffer.concat([utf16be(s), Buffer.alloc(2)]);

function fill(src: Buffer, v: number): Buffer {
  const len = v * Math.ceil(src.length / v);
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = src[i % src.length];
  return out;
}

/** RFC 7292 appendix B.2. */
function p12kdf(hash: string, password: Buffer, salt: Buffer, id: number, iterations: number, n: number): Buffer {
  const v = hash === "sha384" || hash === "sha512" ? 128 : 64;
  const I = Buffer.concat([fill(salt, v), fill(password, v)]);
  const D = Buffer.alloc(v, id);
  const out: Buffer[] = [];
  let have = 0;
  while (have < n) {
    let A = createHash(hash).update(D).update(I).digest();
    for (let k = 1; k < iterations; k++) A = createHash(hash).update(A).digest();
    out.push(A);
    have += A.length;
    if (have >= n) break;
    const B = fill(A, v).subarray(0, v);
    for (let j = 0; j < I.length; j += v) {
      let carry = 1;
      for (let k = v - 1; k >= 0; k--) {
        const sum = I[j + k] + B[k] + carry;
        I[j + k] = sum & 0xff;
        carry = sum >> 8;
      }
    }
  }
  return Buffer.concat(out).subarray(0, n);
}

function decipher(name: string, key: Buffer, iv: Buffer | null, data: Buffer): Buffer {
  let d;
  try { d = createDecipheriv(name, key, iv); } catch {
    throw new CertError("unsupported", `The store is encrypted with ${name}, which this server cannot decrypt; re-export it with AES (PBES2).`);
  }
  try { return Buffer.concat([d.update(data), d.final()]); } catch { throw new DecryptFailed(); }
}

function decrypt(algorithm: ReturnType<typeof parseDer>, data: Buffer, password: string): Buffer {
  const alg = seq(algorithm);
  const id = oid(alg[0]);
  if (id === OID.pbes2) {
    const [kdf, scheme] = seq(alg[1]).map((p) => seq(p));
    if (oid(kdf[0]) !== OID.pbkdf2) throw new CertError("unsupported", `Key derivation ${oid(kdf[0])} is not supported.`);
    const params = seq(kdf[1]);
    const salt = octets(params[0]);
    const iterations = int(params[1]);
    let prf = "sha1";
    for (const p of params.slice(2)) {
      if (p.tag === 0x30) {
        const o = oid(seq(p)[0]);
        if (!PRFS[o]) throw new CertError("unsupported", `PBKDF2 with ${o} is not supported.`);
        prf = PRFS[o];
      }
    }
    const cipher = PBES2_CIPHERS[oid(scheme[0])];
    if (!cipher) throw new CertError("unsupported", `Encryption ${oid(scheme[0])} is not supported.`);
    const key = pbkdf2Sync(Buffer.from(password, "utf8"), salt, iterations, cipher.key, prf);
    return decipher(cipher.name, key, octets(scheme[1]), data);
  }
  const cipher = P12_CIPHERS[id];
  if (!cipher) throw new CertError("unsupported", `Encryption ${id} is not supported.`);
  const params = seq(alg[1]);
  const salt = octets(params[0]), iterations = int(params[1]);
  const pwd = bmp(password);
  const key = p12kdf("sha1", pwd, salt, 1, iterations, cipher.key);
  const iv = cipher.iv ? p12kdf("sha1", pwd, salt, 2, iterations, cipher.iv) : null;
  return decipher(cipher.name, key, iv, data);
}

function readPkcs12(bytes: Buffer, password: string, keyPassword: string): RawStore {
  const pfx = seq(parseDer(bytes));
  if (int(pfx[0]) !== 3) throw new CertError("unsupported", "Only PKCS#12 version 3 is supported.");
  const authSafe = seq(pfx[1]);
  if (oid(authSafe[0]) !== OID.data) throw new CertError("unsupported", "Signed (public-key protected) PKCS#12 files are not supported.");
  const content = octets(children(authSafe[1])[0]);
  let macOk = false;
  if (pfx[2]) {
    const mac = seq(pfx[2]);
    const digestInfo = seq(mac[0]);
    const algId = oid(seq(digestInfo[0])[0]);
    if (algId === OID.pbmac1) throw new CertError("unsupported", "PBMAC1 integrity is not supported.");
    const hash = HASHES[algId];
    if (!hash) throw new CertError("unsupported", `Integrity algorithm ${algId} is not supported.`);
    const digest = octets(digestInfo[1]);
    const salt = octets(mac[1]);
    const iterations = mac[2] ? int(mac[2]) : 1;
    const len = createHash(hash).digest().length;
    const key = p12kdf(hash, bmp(password), salt, 3, iterations, len);
    const expected = createHmac(hash, key).update(content).digest();
    if (digest.length !== expected.length || !timingSafeEqual(digest, expected)) throw new CertError("bad-password", "The keystore password is wrong (or the file was changed).");
    macOk = true;
  }
  const store: RawStore = { format: "PKCS12", keys: [], trusted: [], certs: [] };
  const bags = (safeContents: Buffer) => {
    for (const bag of seq(parseDer(safeContents))) {
      const [typeEl, valueEl, attrsEl] = seq(bag);
      const type = oid(typeEl);
      const value = children(valueEl)[0];
      let alias: string | null = null, localKeyId: string | undefined, javaTrusted = false;
      if (attrsEl) {
        for (const attr of children(attrsEl)) {
          const [aType, aValues] = seq(attr);
          const a = oid(aType), first = children(aValues)[0];
          if (a === OID.friendlyName && first) alias = text(first);
          else if (a === OID.localKeyId && first) localKeyId = octets(first).toString("hex");
          else if (a === OID.javaTrusted) javaTrusted = true;
        }
      }
      if (type === OID.keyBag) {
        const raw = Buffer.from(value.raw);
        store.keys.push({ alias, localKeyId, chain: [], pkcs8: () => raw });
      } else if (type === OID.shroudedKeyBag) {
        const epki = seq(value);
        const alg = epki[0], data = Buffer.from(octets(epki[1]));
        store.keys.push({ alias, localKeyId, chain: [], pkcs8: () => {
          try { const k = decrypt(alg, data, keyPassword); parseDer(k); return k; } catch (e) {
            if (e instanceof DecryptFailed || e instanceof DerError) throw new CertError("bad-password", "The key password is wrong.");
            throw e;
          }
        } });
      } else if (type === OID.certBag) {
        const cb = seq(value);
        if (oid(cb[0]) !== OID.x509Cert) continue;
        const der = Buffer.from(octets(children(cb[1])[0]));
        store.certs.push({ alias, der, localKeyId });
        if (javaTrusted) store.trusted.push({ alias, der });
      } else if (type === OID.safeContentsBag) {
        bags(value.raw);
      }
    }
  };
  for (const ci of seq(parseDer(content))) {
    const parts = seq(ci);
    const type = oid(parts[0]);
    const inner = children(parts[1])[0];
    if (type === OID.data) {
      bags(octets(inner));
    } else if (type === OID.encryptedData) {
      const eci = seq(seq(inner)[1]);
      const enc = eci[2];
      if (!enc || (enc.tag !== 0x80 && enc.tag !== 0xa0)) throw new DerError("no encrypted content");
      const data = enc.tag === 0x80 ? enc.value : Buffer.concat(children(enc).map((c) => octets(c)));
      let plain: Buffer;
      try { plain = decrypt(eci[1], data, password); bags(plain); } catch (e) {
        if (!(e instanceof DecryptFailed || e instanceof DerError)) throw e;
        if (macOk) throw corrupt("keystore");
        throw new CertError("bad-password", "The keystore password is wrong.");
      }
    } else {
      throw new CertError("unsupported", "Public-key encrypted PKCS#12 contents are not supported.");
    }
  }
  return store;
}

// ---- results ----

const spki = (k: KeyObject) => k.export({ type: "spki", format: "der" });

/** The chain from leaf up, following issuers among the given certificates. */
function chainFrom(leaf: Buffer, pool: Buffer[]): Buffer[] {
  const chain = [leaf];
  const xs = pool.map((d) => ({ d, x: new X509Certificate(d) }));
  let cur = new X509Certificate(leaf);
  while (chain.length < 10) {
    if (cur.checkIssued(cur)) break;
    const next = xs.find((c) => !chain.some((d) => d.equals(c.d)) && issued(c.x, cur));
    if (!next) break;
    chain.push(next.d);
    cur = next.x;
  }
  return chain;
}

/** Opens a keystore and gives its one private key, as PKCS#8 PEM, with its certificate chain. */
export function parseKeystore(bytes: Buffer, type: StoreType, storePassword: string, keyPassword?: string): ParsedKeystore {
  const store = readStore(bytes, type, storePassword, keyPassword, "keystore");
  if (store.keys.length === 0) throw new CertError("unsupported", "The keystore has no private key.");
  if (store.keys.length > 1) throw new CertError("unsupported", "The keystore has more than one private key; NiFi's keystore holds one.");
  const raw = store.keys[0];
  let key: KeyObject;
  try { key = createPrivateKey({ key: raw.pkcs8(), format: "der", type: "pkcs8" }); } catch (e) {
    if (e instanceof CertError) throw e;
    throw corrupt("private key");
  }
  const pub = spki(createPublicKey(key));
  try {
    let chain = raw.chain;
    if (store.format === "PKCS12") {
      const leaf = store.certs.find((c) => raw.localKeyId && c.localKeyId === raw.localKeyId)
        ?? store.certs.find((c) => spki(new X509Certificate(c.der).publicKey).equals(pub));
      if (!leaf) throw new CertError("corrupt", "The keystore has no certificate for its private key.");
      chain = chainFrom(leaf.der, store.certs.map((c) => c.der));
    }
    if (chain.length === 0) throw new CertError("corrupt", "The keystore has no certificate for its private key.");
    if (!spki(new X509Certificate(chain[0]).publicKey).equals(pub)) throw new CertError("corrupt", "The keystore's certificate does not belong to its private key.");
    const infos = chain.map((d) => certInfo(d));
    return {
      format: store.format,
      alias: raw.alias ?? store.certs.find((c) => c.der.equals(chain[0]))?.alias ?? null,
      privateKeyPem: key.export({ type: "pkcs8", format: "pem" }) as string,
      certificatePem: infos[0].pem,
      chainPem: infos.map((i) => i.pem).join(""),
      certificate: infos[0],
      chain: infos,
    };
  } catch (e) {
    if (e instanceof CertError) throw e;
    throw corrupt("keystore");
  }
}

/** Opens a truststore and gives the certificates Java would trust: its certificate entries (for PKCS#12, those marked
 *  trusted the way Java marks them) and the first certificate of each key entry. */
export function parseTruststore(bytes: Buffer, type: StoreType, password: string): ParsedTruststore {
  const store = readStore(bytes, type, password, undefined, "truststore");
  const found: { alias: string | null; der: Buffer }[] = [...store.trusted];
  for (const k of store.keys) {
    const first = store.format === "JKS" ? k.chain[0] : store.certs.find((c) => k.localKeyId && c.localKeyId === k.localKeyId)?.der;
    if (first) found.push({ alias: k.alias, der: first });
  }
  try {
    const certificates = found.map((f) => ({ alias: f.alias, ...certInfo(f.der) }));
    return { format: store.format, certificates, caPem: certificates.map((c) => c.pem).join("") };
  } catch (e) {
    if (e instanceof CertError) throw e;
    throw corrupt("truststore");
  }
}

// ---- nifi-toolkit config.json ----

export interface ToolkitConfig {
  keyStore: string;
  keyStoreType: StoreType;
  keyStorePassword: string;
  keyPassword: string;
  trustStore: string;
  trustStoreType: StoreType;
  trustStorePassword: string;
  dn: string | null;
}

function storeType(v: unknown, field: string): StoreType {
  const s = typeof v === "string" ? v.toUpperCase() : "";
  if (s === "JKS" || s === "PKCS12") return s;
  throw new CertError("unsupported", `config.json: ${field} must be JKS or PKCS12.`);
}

/** Reads what the certificate library needs from nifi-toolkit's config.json (1.28.1, client mode). The rest (the CA's
 *  token above all) is dropped here and never returned. */
export function parseToolkitConfig(json: string | Buffer): ToolkitConfig {
  let o: unknown;
  try { o = JSON.parse(typeof json === "string" ? json : json.toString("utf8")); } catch { throw new CertError("corrupt", "config.json is not valid JSON."); }
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new CertError("corrupt", "config.json is not a JSON object.");
  const c = o as Record<string, unknown>;
  const str = (field: string, optional = false): string | null => {
    const v = c[field];
    if (typeof v === "string" && v !== "") return v;
    if (optional && (v === undefined || v === null)) return null;
    throw new CertError("corrupt", `config.json has no ${field}.`);
  };
  const keyStorePassword = str("keyStorePassword")!;
  return {
    keyStore: str("keyStore")!,
    keyStoreType: storeType(c.keyStoreType, "keyStoreType"),
    keyStorePassword,
    keyPassword: str("keyPassword", true) ?? keyStorePassword,
    trustStore: str("trustStore")!,
    trustStoreType: storeType(c.trustStoreType, "trustStoreType"),
    trustStorePassword: str("trustStorePassword")!,
    dn: str("dn", true),
  };
}
