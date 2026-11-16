import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRequests } from "../src/server/plan.ts";

// D49: the build request names either the release tools' script or a Dockerfile (with its context prefix), never both.
test("D49: a dockerfile build reaches the executor with its prefix, a script build with its script", () => {
  const env = { registries: { ghcr: "ghcr.io/acme" } } as never;
  const manifest = (build: Record<string, unknown>) => ({
    app: "dossier", components: [{ id: "dossier", type: "compose-service", service: "dossier",
      source: { kind: "company-registry", registry: "ghcr", image: "open-atlas-dossier", build: { repo: "acme/dossier", tag: "v{version}", ...build } } }],
  }) as never;
  const [d] = buildRequests(env, manifest({ dockerfile: "Dockerfile", prefix: "apps/dossier-clj" }), "0.7.3");
  assert.deepEqual(d!.request.build, { repo: "acme/dossier", tag: "v0.7.3", dockerfile: "Dockerfile", prefix: "apps/dossier-clj", platform: "linux/amd64" });
  const [s] = buildRequests(env, manifest({ script: "build-images.sh" }), "0.7.3");
  assert.deepEqual(s!.request.build, { repo: "acme/dossier", tag: "v0.7.3", script: "build-images.sh", platform: "linux/amd64" });
});
