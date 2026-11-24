// Copying text from a click. navigator.clipboard.writeText can be refused even in a secure context with a click
// (NotAllowedError "Write permission denied": a browser or policy that does not grant clipboard-write, a page without
// focus), so the copy is first tried with a hidden textarea and execCommand("copy"), which runs synchronously inside the
// click, and only then with the Clipboard API. The caller shows the outcome: false means nothing reached the clipboard.

function copyWithTextarea(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;";
  const active = document.activeElement as HTMLElement | null;
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  area.remove();
  active?.focus?.();
  return ok;
}

export async function copyText(text: string): Promise<boolean> {
  if (copyWithTextarea(text)) return true;
  if (!navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
