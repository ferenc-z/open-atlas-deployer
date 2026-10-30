// Reads a .tar.gz release bundle into memory (§5.1 release-asset): regular files only, by path. Links, devices and
// paths that climb out (.., absolute) are refused, so nothing in a bundle can point outside it.

import { gunzipSync } from "node:zlib";

export class TarError extends Error {}

const text = (b: Buffer, start: number, length: number) => b.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
const octal = (b: Buffer, start: number, length: number) => parseInt(text(b, start, length).trim() || "0", 8);

export function readTarGz(bytes: Buffer): Map<string, Buffer> {
  let tar: Buffer;
  try { tar = gunzipSync(bytes); } catch (error) { throw new TarError(`不是 gzip 压缩的 tar 包：${(error as Error).message}`); }
  const files = new Map<string, Buffer>();
  let offset = 0;
  let longName: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((x) => x === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") { longName = body.toString("utf8").replace(/\0.*$/s, ""); continue; }
    if (type === "x") {
      const path = body.toString("utf8").match(/^\d+ path=(.*)$/m)?.[1];
      if (path) longName = path;
      continue;
    }
    if (type === "g") continue;
    const prefix = text(header, 345, 155);
    const name = (longName ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100))).replace(/^\.\//, "");
    longName = undefined;
    if (type === "5") continue;
    if (type !== "0" && type !== "7") throw new TarError(`包里的 ${name} 不是普通文件（类型 ${type}）`);
    if (name.startsWith("/") || name.split("/").includes("..")) throw new TarError(`包里的路径 ${name} 越出了包`);
    files.set(name, Buffer.from(body));
  }
  return files;
}

/** release-1.0.0/app/x → app/x when every path sits in one top directory, as `tar czf x.tar.gz release-1.0.0` makes. */
export function stripTop(files: Map<string, Buffer>): Map<string, Buffer> {
  const tops = new Set([...files.keys()].map((p) => (p.includes("/") ? p.slice(0, p.indexOf("/")) : "")));
  if (tops.size !== 1 || tops.has("")) return files;
  const top = [...tops][0]!.length + 1;
  return new Map([...files].map(([p, b]) => [p.slice(top), b]));
}
