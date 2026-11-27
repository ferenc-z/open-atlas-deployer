// S41: a small DER reader for what the keystore code needs (X.509 fields, PKCS#12 structures, JKS's key wrapper).
// DER only: definite lengths. Anything that does not parse throws DerError; the callers turn it into CertError.

export class DerError extends Error {}

export interface Der {
  /** The identifier octet as read: class bits, constructed bit and tag number (low tag numbers only). */
  tag: number;
  /** The whole element, header included. */
  raw: Buffer;
  /** The contents. */
  value: Buffer;
}

export const TAG = { INTEGER: 0x02, BIT_STRING: 0x03, OCTET_STRING: 0x04, NULL: 0x05, OID: 0x06, UTF8: 0x0c, PRINTABLE: 0x13, T61: 0x14, IA5: 0x16, UTC_TIME: 0x17, GENERALIZED_TIME: 0x18, UNIVERSAL: 0x1c, BMP: 0x1e, SEQUENCE: 0x30, SET: 0x31 } as const;

/** Reads the element at offset; returns it and the offset after it. */
export function readDer(buf: Buffer, offset = 0): { el: Der; next: number } {
  if (offset + 2 > buf.length) throw new DerError("truncated");
  const tag = buf[offset];
  if ((tag & 0x1f) === 0x1f) throw new DerError("high tag numbers are not supported");
  let len = buf[offset + 1];
  let head = 2;
  if (len === 0x80) throw new DerError("indefinite length");
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n > 4 || offset + 2 + n > buf.length) throw new DerError("bad length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[offset + 2 + i];
    head += n;
  }
  const end = offset + head + len;
  if (end > buf.length) throw new DerError("truncated");
  return { el: { tag, raw: buf.subarray(offset, end), value: buf.subarray(offset + head, end) }, next: end };
}

/** One element filling the whole buffer. */
export function parseDer(buf: Buffer): Der {
  const { el, next } = readDer(buf, 0);
  if (next !== buf.length) throw new DerError("trailing bytes");
  return el;
}

/** The elements inside a constructed element. */
export function children(el: Der): Der[] {
  if (!(el.tag & 0x20)) throw new DerError("not constructed");
  const out: Der[] = [];
  let at = 0;
  while (at < el.value.length) {
    const { el: c, next } = readDer(el.value, at);
    out.push(c);
    at = next;
  }
  return out;
}

export function expect(el: Der | undefined, tag: number): Der {
  if (!el || el.tag !== tag) throw new DerError(`expected tag 0x${tag.toString(16)}`);
  return el;
}

export function seq(el: Der | undefined): Der[] {
  return children(expect(el, TAG.SEQUENCE));
}

export function oid(el: Der | undefined): string {
  const v = expect(el, TAG.OID).value;
  if (v.length === 0) throw new DerError("empty OID");
  const parts: number[] = [];
  let n = 0;
  for (const b of v) {
    n = n * 128 + (b & 0x7f);
    if (!(b & 0x80)) { parts.push(n); n = 0; }
  }
  const first = parts.shift()!;
  const a = first < 80 ? Math.floor(first / 40) : 2;
  return [a, first - a * 40, ...parts].join(".");
}

export function int(el: Der | undefined): number {
  const v = expect(el, TAG.INTEGER).value;
  if (v.length === 0 || v.length > 6) throw new DerError("integer out of range");
  let n = 0;
  for (const b of v) n = n * 256 + b;
  return n;
}

export function octets(el: Der | undefined): Buffer {
  return expect(el, TAG.OCTET_STRING).value;
}

/** A string-like value (directory strings, IA5, BMP). */
export function text(el: Der): string {
  switch (el.tag) {
    case TAG.BMP: {
      const b = Buffer.from(el.value);
      return b.swap16().toString("utf16le");
    }
    case TAG.UNIVERSAL: throw new DerError("UniversalString is not supported");
    case TAG.T61: return el.value.toString("latin1");
    default: return el.value.toString("utf8");
  }
}

export function time(el: Der): Date {
  const s = el.value.toString("ascii");
  let m: RegExpMatchArray | null;
  if (el.tag === TAG.UTC_TIME && (m = s.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/))) {
    const yy = Number(m[1]);
    return new Date(Date.UTC(yy < 50 ? 2000 + yy : 1900 + yy, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
  }
  if (el.tag === TAG.GENERALIZED_TIME && (m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/))) {
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
  }
  throw new DerError("bad time");
}
