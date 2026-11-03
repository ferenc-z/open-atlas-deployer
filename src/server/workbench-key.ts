// The Deployer's Workbench API key (§15.6 ③): an administrator pastes it on the Setup page and it is kept sealed with
// DEPLOYER_CREDENTIAL_ENCRYPTION_KEY in the state database, in effect at once. DEPLOYER_WORKBENCH_API_KEY_FILE stays;
// when the file has a key, the file wins and the page cannot change it.

import type { SecretBox } from "./secretbox.ts";
import type { Actor, Store } from "./store.ts";
import { readToken, type TokenSource } from "./versions.ts";

const SETTING = "workbench-api-key";

export class WorkbenchKey {
  private store: Store;
  private file: TokenSource;
  private box: SecretBox | undefined;

  constructor(store: Store, file: TokenSource, box: SecretBox | undefined) {
    this.store = store;
    this.file = file;
    this.box = box;
  }

  /** Where the key in use comes from. */
  source(): "file" | "page" | null {
    if (readToken(this.file)) return "file";
    return this.fromPage() ? "page" : null;
  }

  value(): string { return readToken(this.file) || this.fromPage(); }

  /** Whether the page may set the key: it needs the credential key, and no key in the file. */
  canSet(): { ok: true } | { ok: false; reason: string } {
    if (readToken(this.file)) return { ok: false, reason: `The key comes from ${this.file}, which wins over the page: change it there.` };
    if (!this.box) return { ok: false, reason: "DEPLOYER_CREDENTIAL_ENCRYPTION_KEY is not configured, so the key cannot be kept sealed." };
    return { ok: true };
  }

  save(key: string, actor: Actor) {
    if (!this.box) throw new Error("no credential key");
    this.store.setSetting(SETTING, this.box.seal(key), actor);
  }

  clear(actor: Actor) { this.store.setSetting(SETTING, null, actor); }

  private fromPage(): string {
    const sealed = this.store.setting(SETTING);
    if (!sealed || !this.box) return "";
    try { return this.box.open(sealed); } catch { return ""; }
  }
}
