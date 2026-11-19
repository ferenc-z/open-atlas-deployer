// The one place the flow pages' data source is chosen. While the server routes (§10.2.2 items 6, 7, 8) do not exist, the
// pages run on the sample data; once they do, set USE_SAMPLE_DATA to false (or delete this file and the mock) and the
// pages call the real API unchanged.
import { flowClient } from "./api.ts";
import type { FlowClient } from "./flow-client.ts";
import { mockFlowClient } from "./flows-mock.ts";

export const USE_SAMPLE_DATA = true;
export const flows: FlowClient = USE_SAMPLE_DATA ? mockFlowClient : flowClient;
