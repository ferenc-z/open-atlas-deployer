// Where the business pages live in the console: hash routes, so a card or a list row is a plain link, and a page that wants to
// open one can set location.hash. App reads them on load and on hashchange.
//   #/businesses[?service=<id>]   every registered business (S39), optionally only those that run on one service
//   #/register                    register a business (S39; replaces the old confirmation page of a service's flows)
//   #/flow/<flow>?service=<id>    one business (the service is the one the person came from)

export type FlowRoute = { kind: "businesses"; service?: string } | { kind: "register" } | { kind: "flow"; flow: string; service?: string };

const enc = encodeURIComponent;
export const businessesHref = (service?: string) => `#/businesses${service ? `?service=${enc(service)}` : ""}`;
export const registerHref = () => "#/register";
export const flowHref = (flow: string, service?: string) => `#/flow/${enc(flow)}${service ? `?service=${enc(service)}` : ""}`;

export function parseFlowRoute(hash: string): FlowRoute | null {
  const m = /^#\/(businesses|register|flows|flow)(?:\/([^/?#]+))?(?:\?(.*))?$/u.exec(hash);
  if (!m) return null;
  try {
    const service = new URLSearchParams(m[3] ?? "").get("service");
    if (m[1] === "register") return m[2] === undefined ? { kind: "register" } : null;
    if (m[1] === "businesses") return m[2] === undefined ? { kind: "businesses", ...(service ? { service } : {}) } : null;
    if (m[2] === undefined) return null;
    const id = decodeURIComponent(m[2]);
    // The old per-service confirmation page: its links now land on that service's businesses.
    if (m[1] === "flows") return { kind: "businesses", service: id };
    return { kind: "flow", flow: id, ...(service ? { service } : {}) };
  } catch {
    return null;
  }
}

/** Asks App to open the Ask AI panel beside the page (App listens for it). */
export const openAskAi = () => window.dispatchEvent(new Event("oa:open-assistant"));
