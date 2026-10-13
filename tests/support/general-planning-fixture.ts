/** Ephemeral constructed metadata / replies only: never register as accepted real assets. */
import {
  manifestFixture,
  intentFixture,
  planFixture,
} from "../../src/general-scene/test-fixtures.ts";
import { parseAssetManifest } from "../../src/general-scene/asset-manifest.ts";
import {
  createCatalogView,
  makeAssetLibrary,
} from "../../src/general-scene/asset-library.ts";
import { parseIntent } from "../../src/general-scene/contracts.ts";
import { documentDigest } from "../../src/general-scene/canonical.ts";
import { LLAMA_SMALL_MODEL } from "../../src/planner/service.ts";
export const atom = (
  key: string,
  value: any,
  source: "user" | "model" | "default" | "manual" = "model",
) => ({
  key,
  value,
  source,
  span: source === "user" ? [0, 1] : null,
  strength: "hard",
  negated: false,
});
export function asset(
  id = "test-rock",
  category = "rock",
  kind: "object" | "patch" = "object",
): any {
  const m: any = manifestFixture(kind);
  m.id = id;
  m.category = category;
  m.tags = ["constructed"];
  m.contentVersion = "sha256-" + (kind === "patch" ? "b" : "a").repeat(64);
  m.gaussian.full.quality = {
    status: "passed",
    report: "docs/constructed-test-only.md",
  };
  m.quality.status = "accepted";
  m.quality.inspectionViews = [{ position: [0, 1, 3], target: [0, 0, 0] }];
  m.quality.humanReview = {
    reviewer: "Constructed test double — not human evidence",
    reviewedAt: "2026-10-11T00:00:00Z",
    asset: { id: m.id, contentVersion: m.contentVersion },
    files: m.files.map(({ path, sha256 }: any) => ({ path, sha256 })),
    operations: m.quality.operations,
  };
  return parseAssetManifest(m);
}
export async function library(
  manifests: any[] = [asset(), asset("test-ground", "ground", "patch")],
) {
  return makeAssetLibrary(
    await createCatalogView(manifests, []),
    async (_ref, name) =>
      new Uint8Array(
        manifests.flatMap((m) => m.files).find((f) => f.path === name)?.bytes ??
          0,
      ),
  );
}
export function intent(): any {
  const i = intentFixture();
  i.requestId = "op-1";
  i.raw = "放2个石头，不要水，使用扫描地块。";
  i.features[0].quantity.span = [1, 2];
  i.prohibitions = [];
  i.terrain = [atom("source", "patch")];
  return parseIntent(i);
}
export const request = () => ({
  operationId: "op-1",
  prompt: intent().raw,
  baseRevisionId: null,
  manualOverrides: [] as any[],
});
export async function draft(
  lib: Awaited<ReturnType<typeof library>>,
  i = intent(),
): Promise<any> {
  const p = planFixture();
  p.planId = "plan:op-1";
  p.generatorVersion = "general-planner-v1";
  p.rulesVersion = "general-rules-v1";
  p.intentDigest = await documentDigest(i);
  p.catalogDigest = lib.digest;
  p.terrain = {
    source: "patch",
    assetRef: { id: "test-ground", contentVersion: "sha256-" + "b".repeat(64) },
    transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 },
  };
  p.surfaceStyleRef = null;
  p.groups[0].groupId = "rocks";
  p.groups[0].assetRef = {
    id: "test-rock",
    contentVersion: "sha256-" + "a".repeat(64),
  };
  p.groups[0].orientation = { mode: "surface-normal", yawDegrees: [0, 0] };
  p.relations[0].groupId = "rocks";
  return p;
}
export const reply = (value: any) => ({
  raw: typeof value === "string" ? value : JSON.stringify(value),
  model: LLAMA_SMALL_MODEL,
  done: true,
  doneReason: "stop",
});

export async function style() {
  const { styleContentVersion } =
    await import("../../src/general-scene/asset-library.ts");
  const { parseSurfaceStyle } =
    await import("../../src/general-scene/asset-manifest.ts");
  const m = manifestFixture("patch"),
    s: any = {
      id: "test-style",
      contentVersion: "pending",
      parameters: { roughness: 0.5 },
      quality: structuredClone(m.quality),
      provenance: m.provenance,
    };
  s.contentVersion = await styleContentVersion(s);
  s.quality.status = "accepted";
  s.quality.inspectionViews = [{ position: [0, 1, 3], target: [0, 0, 0] }];
  s.quality.humanReview = {
    reviewer: "Constructed test double — not human evidence",
    reviewedAt: "2026-10-11T00:00:00Z",
    asset: { id: s.id, contentVersion: s.contentVersion },
    files: [{ path: "style-identity.json", sha256: s.contentVersion.slice(7) }],
    operations: s.quality.operations,
  };
  return parseSurfaceStyle(s);
}
