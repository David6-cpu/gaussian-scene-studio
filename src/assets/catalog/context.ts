import { record, oneOf } from "../../data-validation.ts";
import { assetCatalog, ASSET_CATALOG_VERSION } from "./entries.ts";
import { parseCatalog, freeze, text, type AssetMetadata } from "./metadata.ts";
import {
  parsePreparedDefinition,
  validatePreparedArrays,
  jsonDigest,
  canonicalJson,
  type PreparedGroundDefinition,
  type PreparedGroundAsset,
} from "../../io/prepared-ground.ts";

export interface GroundReview {
  contentVersion: string;
  licenseChecked: boolean;
  decision: "pending" | "trial" | "rejected";
  limitations: string[];
  recordReference: string;
}
export interface LocalCatalogIndex {
  format: "wetland-local-catalog";
  version: 1;
  entries: { package: string; packageSha256: string; review: GroundReview }[];
  candidateScope: "combined" | "prepared-ground-only";
}
export interface CatalogContext {
  catalogVersion: string;
  entries: readonly AssetMetadata[];
  prepared: PreparedGroundDefinition | null;
  candidateScope: LocalCatalogIndex["candidateScope"];
}
export const BUILTIN_CONTEXT: CatalogContext = freeze({
  catalogVersion: ASSET_CATALOG_VERSION,
  entries: assetCatalog,
  prepared: null,
  candidateScope: "combined",
});
export function parseGroundReview(
  value: unknown,
  version: string,
): GroundReview {
  const r = record(value, [
    "contentVersion",
    "licenseChecked",
    "decision",
    "limitations",
    "recordReference",
  ]);
  if (
    r.contentVersion !== version ||
    r.licenseChecked !== true ||
    r.decision !== "trial"
  )
    throw Error("素材未获对应内容的许可核对与人工试用记录");
  if (
    !Array.isArray(r.limitations) ||
    r.limitations.length < 1 ||
    r.limitations.length > 12
  )
    throw Error("Missing review limitations");
  const reference = text(r.recordReference, 250);
  if (
    !/^(docs|\.local)\/[a-zA-Z0-9_./-]+$/.test(reference) ||
    reference.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw Error("Invalid local review reference");
  return freeze({
    contentVersion: version,
    licenseChecked: true,
    decision: "trial",
    limitations: r.limitations.map((v) => text(v)),
    recordReference: reference,
  });
}
async function contextFor(
  d: PreparedGroundDefinition,
  scope: CatalogContext["candidateScope"],
): Promise<CatalogContext> {
  if (assetCatalog.some((a) => a.id === d.metadata.id))
    throw Error("Duplicate builtin asset ID");
  const entries = parseCatalog([
    ...assetCatalog.filter(
      (a) => scope !== "prepared-ground-only" || a.category !== "ground",
    ),
    d.metadata,
  ]);
  const payload = { entries, prepared: d, candidateScope: scope };
  return freeze({
    catalogVersion: "asset-catalog-" + (await jsonDigest(payload)),
    ...payload,
  });
}
export async function makeCatalogContext(
  asset: PreparedGroundAsset | null,
  review?: GroundReview,
  scope: CatalogContext["candidateScope"] = "combined",
): Promise<CatalogContext> {
  oneOf(scope, ["combined", "prepared-ground-only"]);
  if (!asset) {
    if (scope !== "combined") throw Error("Missing prepared ground");
    return BUILTIN_CONTEXT;
  }
  const d = await parsePreparedDefinition(asset.definition);
  await validatePreparedArrays(d, asset.arrays);
  parseGroundReview(review, d.metadata.contentVersion);
  return contextFor(d, scope);
}
/** Recompute the server snapshot fingerprint. This does not authenticate its source. */
export async function parseCatalogContext(
  value: unknown,
): Promise<CatalogContext> {
  const c = record(value, [
    "catalogVersion",
    "entries",
    "prepared",
    "candidateScope",
  ]);
  if (c.prepared === null) {
    if (canonicalJson(c) !== canonicalJson(BUILTIN_CONTEXT))
      throw Error("Builtin catalog mismatch");
    return BUILTIN_CONTEXT;
  }
  const d = await parsePreparedDefinition(c.prepared),
    scope = oneOf(c.candidateScope, [
      "combined",
      "prepared-ground-only",
    ] as const),
    expected = await contextFor(d, scope);
  if (canonicalJson(c) !== canonicalJson(expected))
    throw Error("Catalog fingerprint or entries mismatch");
  return expected;
}
export function resolvePreparedDefinition(
  context: CatalogContext,
  ref: { id: string; contentVersion: string },
): PreparedGroundDefinition {
  const d = context.prepared;
  if (
    !d ||
    d.metadata.id !== ref.id ||
    d.metadata.contentVersion !== ref.contentVersion
  )
    throw Error("缺少匹配的地表ID/内容版本；不会降级为旧素材");
  return d;
}
