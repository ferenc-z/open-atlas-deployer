// S41: opening JKS and PKCS#12 stores, nifi-toolkit's config.json, and the per-service certificate check (certs/).
// testdata/certs/toolkit-client: made by nifi-toolkit 1.28.1 in client mode (-D "CN=S2S,OU=NIFI", SANs nifi-1.lab and
// nifi-2.lab) against a throwaway local CA. testdata/certs/openssl: openssl 3 PKCS#12 (AES and 3DES), serverAuth only.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { checkForService, openUpload, type CertCheck } from "../src/server/certs/check.ts";
import { CertError, parseKeystore, parseToolkitConfig, parseTruststore } from "../src/server/certs/keystore.ts";
import { pemCerts } from "../src/server/certs/x509.ts";

const file = (dir: string, name: string) => readFileSync(new URL(`../testdata/certs/${dir}/${name}`, import.meta.url));
const TK = parseToolkitConfig(file("toolkit-client", "config.json"));
const KS = file("toolkit-client", "keystore.jks"), TS = file("toolkit-client", "truststore.jks");
const P12_PASS = file("openssl", "pass.txt").toString("utf8").trim();
const AES = file("openssl", "aes.p12"), DES = file("openssl", "des.p12");

const kind = (f: () => unknown) => { try { f(); } catch (e) { if (e instanceof CertError) return e.kind; throw e; } return "none"; };
const item = (r: CertCheck, code: string) => r.items.find((i) => i.code === code);

test("toolkit config.json: the store fields, and nothing else (no token)", () => {
  const raw = JSON.parse(file("toolkit-client", "config.json").toString("utf8"));
  assert.ok(raw.token, "testdata has a token to drop");
  assert.deepEqual(Object.keys(TK).sort(), ["dn", "keyPassword", "keyStore", "keyStorePassword", "keyStoreType", "trustStore", "trustStorePassword", "trustStoreType"]);
  assert.equal(TK.keyStore, "keystore.jks");
  assert.equal(TK.keyStoreType, "JKS");
  assert.equal(TK.trustStoreType, "JKS");
  assert.equal(TK.dn, "CN=S2S,OU=NIFI");
  assert.ok(!JSON.stringify(TK).includes(raw.token));
  assert.equal(kind(() => parseToolkitConfig("{not json")), "corrupt");
  assert.equal(kind(() => parseToolkitConfig(JSON.stringify({ ...raw, keyStoreType: "BCFKS" }))), "unsupported");
  assert.equal(kind(() => parseToolkitConfig(JSON.stringify({ ...raw, trustStorePassword: undefined }))), "corrupt");
  assert.equal(parseToolkitConfig(JSON.stringify({ ...raw, keyPassword: undefined })).keyPassword, raw.keyStorePassword);
});

test("JKS keystore from nifi-toolkit client mode: key, chain and what the page shows", () => {
  const k = parseKeystore(KS, TK.keyStoreType, TK.keyStorePassword, TK.keyPassword);
  assert.equal(k.format, "JKS");
  assert.equal(k.alias, "nifi-key");
  const c = k.certificate;
  assert.equal(c.subject, "CN=S2S, OU=NIFI");
  assert.equal(c.issuer, "CN=localhost, OU=NIFI");
  assert.deepEqual(c.san.filter((s) => s.type === "DNS").map((s) => s.value).filter((v) => v.endsWith(".lab")), ["nifi-1.lab", "nifi-2.lab"]);
  assert.ok(c.eku?.includes("clientAuth") && c.eku.includes("serverAuth"));
  assert.equal(c.isCa, false);
  const x = new X509Certificate(k.certificatePem);
  assert.equal(c.sha256, x.fingerprint256);
  assert.equal(c.notAfter, new Date(x.validTo).toISOString());
  assert.equal(c.serial, x.serialNumber.toUpperCase().replace(/^0+(?=.)/, ""));
  // The private key belongs to the certificate.
  const pub = (k2: ReturnType<typeof createPublicKey>) => k2.export({ type: "spki", format: "der" });
  assert.ok(pub(createPublicKey(createPrivateKey(k.privateKeyPem))).equals(pub(x.publicKey)));
  assert.match(k.privateKeyPem, /^-----BEGIN PRIVATE KEY-----/);
  // Chain: leaf, then the toolkit CA, which is nifi-cert.pem.
  assert.equal(pemCerts(k.chainPem).length, k.chain.length);
  const ca = new X509Certificate(file("toolkit-client", "nifi-cert.pem"));
  assert.ok(k.chain.some((i) => i.sha256 === ca.fingerprint256));
});

test("JKS truststore: the toolkit CA, same as nifi-cert.pem", () => {
  const t = parseTruststore(TS, TK.trustStoreType, TK.trustStorePassword);
  assert.equal(t.format, "JKS");
  assert.equal(t.certificates.length, 1);
  const ca = new X509Certificate(file("toolkit-client", "nifi-cert.pem"));
  assert.equal(t.certificates[0].sha256, ca.fingerprint256);
  assert.equal(t.certificates[0].subject, "CN=localhost, OU=NIFI");
  assert.equal(t.certificates[0].isCa, true);
  assert.equal(pemCerts(t.caPem).length, 1);
});

test("PKCS12 from openssl, AES (PBES2) and 3DES (PKCS#12 PBE, SHA-1 MAC)", () => {
  const ca = new X509Certificate(file("openssl", "ca.pem"));
  for (const bytes of [AES, DES]) {
    const k = parseKeystore(bytes, "PKCS12", P12_PASS);
    assert.equal(k.format, "PKCS12");
    assert.equal(k.alias, "web");
    assert.equal(k.certificate.subject, "CN=web, OU=NIFI");
    assert.equal(k.certificate.issuer, "CN=test-ca, OU=TEST");
    assert.deepEqual(k.certificate.san, [{ type: "DNS", value: "nifi-1.lab" }, { type: "DNS", value: "web.lab" }]);
    assert.deepEqual(k.certificate.eku, ["serverAuth"]);
    assert.equal(k.chain.length, 2);
    assert.equal(k.chain[1].sha256, ca.fingerprint256);
    createPrivateKey(k.privateKeyPem);
  }
  // Java's compat: a PKCS12 file opens as PKCS12 when asked as JKS.
  assert.equal(parseKeystore(AES, "JKS", P12_PASS).format, "PKCS12");
  // openssl does not mark the CA trusted the way Java does: a Java truststore would only trust the key's own certificate.
  assert.deepEqual(parseTruststore(AES, "PKCS12", P12_PASS).certificates.map((c) => c.subject), ["CN=web, OU=NIFI"]);
});

test("wrong passwords are told apart from damage and unsupported formats", () => {
  assert.equal(kind(() => parseKeystore(KS, "JKS", "wrong")), "bad-password");
  assert.equal(kind(() => parseKeystore(KS, "JKS", TK.keyStorePassword, "wrong")), "bad-password");
  assert.equal(kind(() => parseTruststore(TS, "JKS", "wrong")), "bad-password");
  assert.equal(kind(() => parseKeystore(AES, "PKCS12", "wrong")), "bad-password");
  assert.equal(kind(() => parseKeystore(DES, "PKCS12", "wrong")), "bad-password");
  // Damaged: cut short, garbage, a byte changed in a certificate's header.
  assert.equal(kind(() => parseKeystore(KS.subarray(0, KS.length - 100), "JKS", TK.keyStorePassword)), "corrupt");
  assert.equal(kind(() => parseKeystore(AES.subarray(0, 1000), "PKCS12", P12_PASS)), "corrupt");
  assert.equal(kind(() => parseKeystore(Buffer.from("hello, not a keystore"), "JKS", "x")), "corrupt");
  assert.equal(kind(() => parseKeystore(Buffer.alloc(0), "JKS", "x")), "corrupt");
  const bent = Buffer.from(TS);
  const at = bent.indexOf(Buffer.from("X.509")) + 5 + 4; // first certificate's DER
  bent[at + 1] ^= 0x7f;
  assert.equal(kind(() => parseTruststore(bent, "JKS", TK.trustStorePassword)), "corrupt");
  // Unsupported.
  const jceks = Buffer.from(KS); jceks.writeUInt32BE(0xcececece, 0);
  assert.equal(kind(() => parseKeystore(jceks, "JKS", "x")), "unsupported");
  assert.equal(kind(() => parseKeystore(KS, "BCFKS" as "JKS", "x")), "unsupported");
  assert.equal(kind(() => parseKeystore(TS, "JKS", TK.trustStorePassword)), "unsupported"); // no private key
  // Messages never carry a password.
  try { parseKeystore(KS, "JKS", "s3cret-guess"); } catch (e) { assert.ok(!(e as Error).message.includes("s3cret")); }
});

const toolkit = () => openUpload({
  keystore: { bytes: KS, type: TK.keyStoreType, password: TK.keyStorePassword, keyPassword: TK.keyPassword },
  truststore: { bytes: TS, type: TK.trustStoreType, password: TK.trustStorePassword },
});
const HOSTS = ["nifi-1.lab", "nifi-2.lab"];

test("check: the toolkit certificate passes for its nodes", () => {
  const opened = toolkit();
  const current = (opened.keystore as { chainPem: string }).chainPem;
  const r = checkForService(opened, { hosts: [...HOSTS, "NIFI-1.lab"], current, now: new Date() });
  assert.deepEqual(r.items.filter((i) => !i.ok), []);
  assert.deepEqual(r.items.map((i) => i.code), ["open", "eku", "san", "validity", "trusts-new", "trusts-current"]);
  assert.equal(r.ok, true);
});

test("check: SAN not covering a node; CN is not looked at", () => {
  const r = checkForService(toolkit(), { hosts: [...HOSTS, "nifi-3.lab", "S2S", "10.0.0.1"], now: new Date() });
  assert.equal(r.ok, false);
  const san = item(r, "san")!;
  assert.equal(san.ok, false);
  // The toolkit puts the CN into the SANs too, so S2S is covered by the SAN, not by the CN.
  const coversCn = parseKeystore(KS, "JKS", TK.keyStorePassword, TK.keyPassword).certificate.san.some((s) => s.value === "S2S");
  assert.deepEqual(san.missing, coversCn ? ["nifi-3.lab", "10.0.0.1"] : ["nifi-3.lab", "S2S", "10.0.0.1"]);
});

test("check: expired, and not yet valid", () => {
  const opened = toolkit();
  const k = opened.keystore as { certificate: { notBefore: string; notAfter: string } };
  const after = new Date(new Date(k.certificate.notAfter).getTime() + 1000);
  const r = checkForService(opened, { hosts: HOSTS, now: after });
  assert.equal(r.ok, false);
  assert.match(item(r, "validity")!.message, /expired/);
  const before = new Date(new Date(k.certificate.notBefore).getTime() - 1000);
  assert.match(item(checkForService(opened, { hosts: HOSTS, now: before }), "validity")!.message, /not valid before/);
});

test("check: the new truststore does not trust the certificate in use", () => {
  const inUse = parseKeystore(AES, "PKCS12", P12_PASS).chainPem;
  const r = checkForService(toolkit(), { hosts: HOSTS, current: inUse, now: new Date() });
  assert.equal(r.ok, false);
  assert.equal(item(r, "trusts-current")!.ok, false);
  assert.equal(item(r, "trusts-new")!.ok, true);
  // Given as DER certificates, the toolkit's own certificate is trusted.
  const der = pemCerts((toolkit().keystore as { certificatePem: string }).certificatePem);
  assert.equal(item(checkForService(toolkit(), { hosts: HOSTS, current: der }), "trusts-current")!.ok, true);
});

test("check: EKU without clientAuth; a truststore that does not trust the new certificate", () => {
  const opened = openUpload({
    keystore: { bytes: AES, type: "PKCS12", password: P12_PASS },
    truststore: { bytes: TS, type: "JKS", password: TK.trustStorePassword },
  });
  const r = checkForService(opened, { hosts: ["nifi-1.lab"], now: new Date() });
  assert.deepEqual(r.items.filter((i) => !i.ok).map((i) => i.code), ["eku", "trusts-new"]);
  assert.match(item(r, "eku")!.message, /lacks clientAuth/);
});

test("check: a store that does not open fails the check and says why", () => {
  const opened = openUpload({
    keystore: { bytes: KS, type: "JKS", password: "wrong" },
    truststore: { bytes: TS, type: "JKS", password: TK.trustStorePassword },
  });
  const r = checkForService(opened, { hosts: HOSTS });
  assert.equal(r.ok, false);
  assert.deepEqual(r.items.map((i) => i.code), ["open"]);
  assert.deepEqual(r.items[0].error, { file: "keystore", kind: "bad-password" });
  const t = checkForService(openUpload({
    keystore: { bytes: KS, type: "JKS", password: TK.keyStorePassword, keyPassword: TK.keyPassword },
    truststore: { bytes: TS.subarray(0, 50), type: "JKS", password: TK.trustStorePassword },
  }), { hosts: HOSTS });
  assert.deepEqual(t.items[0].error, { file: "truststore", kind: "corrupt" });
  assert.equal(t.ok, false);
});
