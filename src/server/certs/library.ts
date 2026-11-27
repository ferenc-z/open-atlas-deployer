// S41 step 3: the certificate library. Reads an upload (nifi-toolkit's keystore, truststore and config.json, picked out of
// the files given), and makes the two things the library keeps: the plain facts of a version (subject, hosts, dates) that
// pages and the AI may see, and one sealed blob with the files, passwords and PEM that nothing returns.

import { basename } from "node:path";
import { CertError, parseToolkitConfig, type ParsedKeystore, type ParsedTruststore, type ToolkitConfig } from "./keystore.ts";
import { openUpload, type OpenedUpload } from "./check.ts";
import type { SecretBox } from "../secretbox.ts";
import type { NewCertVersion } from "../store.ts";

export const UPLOAD_FILE_MAX = 1024 * 1024;
export const UPLOAD_FILES_MAX = 8;

export interface UploadedFile { name: string; bytes: Buffer }

export interface ReadUpload { config: ToolkitConfig; opened: OpenedUpload; keystoreBytes: Buffer; truststoreBytes: Buffer }

/** The three files of a toolkit client run among the files given: config.json names the other two. */
export function readUpload(files: UploadedFile[]): ReadUpload {
  const find = (name: string) => files.find((f) => basename(f.name).toLowerCase() === basename(name).toLowerCase());
  const configFile = find("config.json");
  if (!configFile) throw new CertError("corrupt", "The upload has no config.json.");
  const config = parseToolkitConfig(configFile.bytes);
  const keystore = find(config.keyStore), truststore = find(config.trustStore);
  if (!keystore) throw new CertError("corrupt", `The upload has no ${basename(config.keyStore)} (the keystore config.json names).`);
  if (!truststore) throw new CertError("corrupt", `The upload has no ${basename(config.trustStore)} (the truststore config.json names).`);
  const opened = openUpload({
    keystore: { bytes: keystore.bytes, type: config.keyStoreType, password: config.keyStorePassword, keyPassword: config.keyPassword },
    truststore: { bytes: truststore.bytes, type: config.trustStoreType, password: config.trustStorePassword },
  });
  return { config, opened, keystoreBytes: keystore.bytes, truststoreBytes: truststore.bytes };
}

/** What a version shows of itself: no file, no password, no key. */
export function plainFacts(k: ParsedKeystore, t: ParsedTruststore) {
  const c = k.certificate;
  return { subject: c.subject, san: c.san, issuer: c.issuer, notBefore: c.notBefore, notAfter: c.notAfter, eku: c.eku, sha256: c.sha256, keystoreType: k.format, truststoreType: t.format, trusted: t.certificates.length };
}

/** The sealed part of a version: both files, the passwords, and the PEM the service executor will use. */
export function sealVersion(u: ReadUpload, box: SecretBox): NewCertVersion {
  const { keystore: k, truststore: t } = u.opened;
  if (k instanceof CertError) throw k;
  if (t instanceof CertError) throw t;
  const secret = {
    keystore: u.keystoreBytes.toString("base64"), truststore: u.truststoreBytes.toString("base64"),
    keystorePassword: u.config.keyStorePassword, keyPassword: u.config.keyPassword, truststorePassword: u.config.trustStorePassword,
    privateKeyPem: k.privateKeyPem, chainPem: k.chainPem, caPem: t.caPem,
  };
  return { ...plainFacts(k, t), sealed: box.seal(JSON.stringify(secret)) };
}

/** The certificate a version holds, PEM (leaf first), for the check of the services that use it. */
export function currentPem(sealed: string, box: SecretBox): string | undefined {
  try { return (JSON.parse(box.open(sealed)) as { chainPem?: string }).chainPem; } catch { return undefined; }
}
