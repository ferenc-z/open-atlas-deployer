// Where the overview and service page get their data: the same switch as the flow pages (flows-data.ts). While the server
// routes (§10.2.2 items 1-5, 9, 10) do not exist the pages run on the sample data; set USE_SAMPLE_DATA to false there and
// they call the real API unchanged.
import { opsClient } from "./api.ts";
import { USE_SAMPLE_DATA } from "./flows-data.ts";
import type { OpsClient } from "./ops-client.ts";
import { mockOpsClient } from "./ops-mock.ts";

export const ops: OpsClient = USE_SAMPLE_DATA ? mockOpsClient : opsClient;
