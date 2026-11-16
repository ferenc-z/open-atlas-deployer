// What is open on a page (an assessment, a service, the app chosen on the env page), for the Deploy Assistant beside
// the page: App collects it and adds it to the Assistant's page context (key=value), so the person can ask about what
// they are looking at without naming it.

import { createContext, useContext, useEffect } from "react";

export type SetFocus = (key: string, value: string | undefined) => void;
export const PageFocus = createContext<SetFocus>(() => undefined);

/** Tells the Assistant that `value` is open under `key` (e.g. assessment, service, app), until it closes or the page goes. */
export function usePageFocus(key: string, value: string | undefined): void {
  const set = useContext(PageFocus);
  useEffect(() => { set(key, value || undefined); return () => set(key, undefined); }, [set, key, value]);
}
