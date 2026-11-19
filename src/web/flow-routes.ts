// Where the flow pages live in the console: hash routes, so the service page's business card (6a) is a plain link, and a
// page that wants to open one can set location.hash. App reads them on load and on hashchange.
//   #/flows/<service>            the confirmation page of a service
//   #/flow/<flow>?service=<id>   one flow (the service is the one the person came from)

export type FlowRoute = { kind: "flows"; service: string } | { kind: "flow"; flow: string; service?: string };

const enc = encodeURIComponent;
export const flowsHref = (service: string) => `#/flows/${enc(service)}`;
export const flowHref = (flow: string, service?: string) => `#/flow/${enc(flow)}${service ? `?service=${enc(service)}` : ""}`;

export function parseFlowRoute(hash: string): FlowRoute | null {
  const m = /^#\/(flows|flow)\/([^/?#]+)(?:\?(.*))?$/u.exec(hash);
  if (!m) return null;
  try {
    const id = decodeURIComponent(m[2]!);
    if (m[1] === "flows") return { kind: "flows", service: id };
    const service = new URLSearchParams(m[3] ?? "").get("service");
    return { kind: "flow", flow: id, ...(service ? { service } : {}) };
  } catch {
    return null;
  }
}

/** Asks App to open the Ask AI panel beside the page (App listens for it). */
export const openAskAi = () => window.dispatchEvent(new Event("oa:open-assistant"));
