// Runs ELK on a FlowGraph. The bundled build runs the layout in the page's own thread (no worker file to serve).

import ELKModule from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import type { FlowGraph } from "../server/services/ops-types.ts";
import { fromElk, toElk, type Laid } from "./flowgraph.ts";

// elkjs is CommonJS: depending on the loader the constructor is the module itself or its `default`.
type Elk = { layout(graph: ElkNode): Promise<ElkNode> };
const ELK = ((ELKModule as unknown as { default?: unknown }).default ?? ELKModule) as new () => Elk;
let elk: Elk | undefined;

export async function layoutFlow(graph: FlowGraph): Promise<Laid> {
  elk ??= new ELK();
  return fromElk(graph, await elk.layout(toElk(graph)));
}
