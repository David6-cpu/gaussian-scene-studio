import { record } from "../data-validation.ts";
import { jsonDigest, canonicalJson } from "../io/prepared-ground.ts";
import {
  parseAssetManifest,
  parseSurfaceStyle,
  type AssetManifestV2,
  type SurfaceStyle,
} from "./asset-manifest.ts";
import { GENERAL_LIMITS, type AssetRef } from "./core.ts";
export type CatalogView = {
  readonly digest: string;
  readonly manifests: readonly AssetManifestV2[];
  readonly styles: readonly SurfaceStyle[];
};
export type AssetLibrary = CatalogView & {
  resolveMember: (
    ref: AssetRef,
    name: string,
    signal: AbortSignal,
  ) => Promise<Uint8Array>;
};
const freeze = <T>(v: T): T => {
  if (v && typeof v === "object") {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};
/** Style review hashes a reproducible identity JSON, excluding mutable review fields. */
export function styleIdentityProjection(value: SurfaceStyle) {
  const s = parseSurfaceStyle(value);
  return {
    projectionVersion: 1,
    id: s.id,
    parameters: s.parameters,
    provenance: s.provenance,
  };
}
export async function styleContentVersion(style: SurfaceStyle) {
  return "sha256-" + (await jsonDigest(styleIdentityProjection(style)));
}
function snapshot(
  manifests: readonly AssetManifestV2[],
  styles: readonly SurfaceStyle[],
) {
  if (
    !Array.isArray(manifests) ||
    manifests.length > 128 ||
    !Array.isArray(styles) ||
    styles.length > 128
  )
    throw Error("Unsupported catalog size or surface style contract");
  const m = manifests.map(parseAssetManifest);
  if (new Set(m.map((x) => x.id)).size !== m.length)
    throw Error("Duplicate catalog asset ID");
  const parsedStyles = styles.map(parseSurfaceStyle);
  if (
    new Set([...m, ...parsedStyles].map((s) => s.id)).size !==
    m.length + parsedStyles.length
  )
    throw Error("Duplicate catalog ID");
  const value = {
    manifests: m.sort((a, b) => a.id.localeCompare(b.id)),
    styles: parsedStyles.sort((a, b) => a.id.localeCompare(b.id)),
  };
  if (
    new TextEncoder().encode(canonicalJson(value)).length >
    GENERAL_LIMITS.maxJsonBytes
  )
    throw Error("Catalog JSON exceeds limit");
  return freeze(value);
}
export async function createCatalogView(
  manifests: readonly AssetManifestV2[],
  styles: readonly SurfaceStyle[],
): Promise<CatalogView> {
  const view = snapshot(manifests, styles);
  for (const s of view.styles)
    if (s.contentVersion !== (await styleContentVersion(s)))
      throw Error("Style identity mismatch");
  return freeze({ digest: await jsonDigest(view), ...view });
}
export async function verifyCatalogView(view: CatalogView): Promise<void> {
  const checked = makeAssetLibrary(view, async () => {
    throw Error("No resolver");
  });
  for (const s of checked.styles)
    if (s.contentVersion !== (await styleContentVersion(s)))
      throw Error("Style identity mismatch");
  if (
    view.digest !==
    (await jsonDigest({ manifests: checked.manifests, styles: checked.styles }))
  )
    throw Error("Catalog digest mismatch");
}
export function makeAssetLibrary(
  view: CatalogView,
  resolver: AssetLibrary["resolveMember"],
): AssetLibrary {
  record(view, ["digest", "manifests", "styles"]);
  if (!/^[0-9a-f]{64}$/.test(view.digest) || typeof resolver !== "function")
    throw Error("Invalid catalog digest or resolver");
  const s = snapshot(view.manifests, view.styles);
  return Object.freeze({
    digest: view.digest,
    ...s,
    resolveMember: async (ref: AssetRef, name: string, signal: AbortSignal) => {
      signal.throwIfAborted();
      const m = s.manifests.find(
        (m) => m.id === ref.id && m.contentVersion === ref.contentVersion,
      );
      const f = m?.files.find((f) => f.path === name);
      if (!m || !f) throw Error("Unknown asset reference or member");
      const bytes = await resolver(
        { id: m.id, contentVersion: m.contentVersion },
        name,
        signal,
      );
      signal.throwIfAborted();
      if (!(bytes instanceof Uint8Array) || bytes.length !== f.bytes)
        throw Error("Resolved member byte mismatch");
      return new Uint8Array(bytes);
    },
  });
}
