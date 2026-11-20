// The overview and service page's calls (pages-rethink §10.2.2 items 1-5, 9, 10) over a `call(method, path, body)` function,
// so a test can see which route each action takes. api.ts binds it to fetch; ops-data.ts chooses between it and the sample data.

import type { Call } from "./flow-client.ts";
import type { AnalysisView, ServicePage, ServicesOverview, TodoView } from "../server/services/ops-types.ts";

export interface OpsClient {
  /** 1: every service, worst first. */
  overview(): Promise<ServicesOverview>;
  /** 2: one service's page. */
  page(service: string): Promise<ServicePage>;
  /** 3: Look again now for one service (202; a round already running answers 409, and the page then shows that one). */
  checkService(service: string): Promise<AnalysisView>;
  /** 4: Check now for every service. */
  checkAll(): Promise<{ run: string; services: string[] }>;
  /** 5: poll one analysis. */
  analysis(id: number): Promise<AnalysisView>;
  /** 9: Apply the AI's change: makes the configuration draft as the signed-in person. */
  draftTodo(todo: string): Promise<{ draft: string; service: string }>;
  /** 10: mark a to-do done or not needed. */
  todoState(todo: string, state: "done" | "dismissed"): Promise<TodoView>;
}

const enc = encodeURIComponent;

export function makeOpsClient(call: Call): OpsClient {
  return {
    overview: () => call("GET", "services/overview"),
    page: (service) => call("GET", `services/${enc(service)}/page`),
    checkService: (service) => call("POST", `services/${enc(service)}/analyses`, {}),
    checkAll: () => call("POST", "analyses", {}),
    analysis: (id) => call("GET", `analyses/${id}`),
    draftTodo: (todo) => call("POST", `todos/${enc(todo)}/draft`, {}),
    todoState: (todo, state) => call("POST", `todos/${enc(todo)}/state`, { state }),
  };
}
