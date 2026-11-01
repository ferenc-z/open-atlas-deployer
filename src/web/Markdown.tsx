// A small Markdown renderer for AI-written text (the daily brief, assessment reports): headings, paragraphs, lists,
// tables, fenced code, **bold**, *italic*, `code` and http(s) links. It builds React elements, never HTML strings,
// so nothing in the text can inject markup.

import type { ReactNode } from "react";

export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "code"; text: string };

const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    if (line.trim().startsWith("```")) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trim().startsWith("```"); i++) body.push(lines[i]!);
      blocks.push({ kind: "code", text: body.join("\n") }); i++; continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]!.replace(/#+\s*$/, "") }); i++; continue; }
    if (line.trim().startsWith("|") && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? "") && (lines[i + 1] ?? "").includes("-")) {
      const head = cells(line); const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i]!.trim().startsWith("|"); i++) rows.push(cells(lines[i]!));
      blocks.push({ kind: "table", head, rows }); continue;
    }
    const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
    if (item.test(line)) {
      const ordered = /^\s*\d/.test(line); const items: string[] = [];
      for (; i < lines.length; i++) {
        const m = item.exec(lines[i]!);
        if (m) items.push(m[2]!);
        else if (lines[i]!.trim() && /^\s{2,}/.test(lines[i]!) && items.length) items[items.length - 1] += ` ${lines[i]!.trim()}`;
        else break;
      }
      blocks.push({ kind: "list", ordered, items }); continue;
    }
    const para: string[] = [];
    for (; i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|```|\s*([-*+]|\d+[.)])\s)/.test(lines[i]!); i++) para.push(lines[i]!.trim());
    blocks.push({ kind: "paragraph", text: para.join(" ") });
  }
  return blocks;
}

export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0; let m: RegExpExecArray | null;
  while ((m = pattern.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = out.length;
    if (m[1] !== undefined) out.push(<code key={k}>{m[1]}</code>);
    else if (m[2] !== undefined || m[3] !== undefined) out.push(<strong key={k}>{inline(m[2] ?? m[3]!)}</strong>);
    else if (m[4] !== undefined) out.push(<em key={k}>{inline(m[4])}</em>);
    else out.push(<a key={k} href={m[6]} target="_blank" rel="noreferrer">{m[5]}</a>);
    last = pattern.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderBlock(b: Block, key: number): ReactNode {
  switch (b.kind) {
    case "heading": { const H = (`h${Math.min(b.level + 2, 6)}`) as "h3"; return <H key={key}>{inline(b.text)}</H>; }
    case "paragraph": return <p key={key}>{inline(b.text)}</p>;
    case "list": { const L = b.ordered ? "ol" : "ul"; return <L key={key}>{b.items.map((t, j) => <li key={j}>{inline(t)}</li>)}</L>; }
    case "table": return (
      <div key={key} className="md-table"><table>
        <thead><tr>{b.head.map((h, j) => <th key={j}>{inline(h)}</th>)}</tr></thead>
        <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, n) => <td key={n}>{inline(c)}</td>)}</tr>)}</tbody>
      </table></div>
    );
    case "code": return <pre key={key}><code>{b.text}</code></pre>;
  }
}

export function Markdown({ text, blocks }: { text?: string; blocks?: Block[] }) {
  return <div className="md">{(blocks ?? parseMarkdown(text ?? "")).map(renderBlock)}</div>;
}
