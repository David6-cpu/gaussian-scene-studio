import { record, finite, integer, oneOf, vector } from "../../data-validation";

export const categories = [
  "ground",
  "rock",
  "grass",
  "reed",
  "plant-proxy",
] as const;
export const biomes = ["wetland", "snow-mountain"] as const;
export const loaders = [
  "riverside-ground-v1",
  "river-rock-v1",
  "river-low-grass-v2",
  "river-grass-v1",
  "river-reed-v1",
  "legacy-rock-v1",
  "legacy-plant-v1",
] as const;
export type Category = (typeof categories)[number];
export type Biome = (typeof biomes)[number];
export type Origin = "captured" | "procedural";
export type Unit = "display-unit" | "metre";
export interface AssetMetadata {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly title: string;
  readonly contentVersion: string;
  readonly category: Category;
  readonly biomes: readonly Biome[];
  readonly tags: readonly string[];
  readonly origin: Origin;
  readonly spatial: {
    readonly unit: Unit;
    readonly metricScale: boolean;
    readonly scaleEvidence: string | null;
    readonly upAxis: "+Y";
    readonly forwardAxis: "+Z" | null;
    readonly handedness: "right";
    readonly dimensions: readonly [number, number | null, number];
    readonly dimensionBasis: "usable-ground-area" | "placement-footprint";
    readonly anchor: readonly [number, number, number];
    readonly radius: number | null;
  };
  readonly gaussian: {
    readonly full: number;
    readonly coarse: number | null;
    readonly shBands: 0 | 1 | 2 | 3;
    readonly sourceBytes: number;
  };
  readonly quality: {
    readonly status: "trial" | "legacy";
    readonly report: string;
    readonly limitations: readonly string[];
  };
  readonly provenance: {
    readonly author: string;
    readonly source: string;
    readonly license: "CC-BY-4.0" | "project-internal";
    readonly licenseUrl: string | null;
    readonly licenseFile: string | null;
    readonly changes: string;
    readonly files: readonly {
      readonly path: string;
      readonly bytes: number;
      readonly sha256: string;
    }[];
  };
  readonly loader: (typeof loaders)[number];
}
export function text(value: unknown, max = 1000): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw Error("文本为空或无效");
  return value;
}
export function identifier(value: unknown): string {
  const id = text(value, 80);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id))
    throw Error("ID或标签必须为受限标识符");
  return id;
}
function list<T>(
  value: unknown,
  parse: (item: unknown) => T,
  max: number,
  empty = false,
): T[] {
  if (!Array.isArray(value) || value.length > max || (!empty && !value.length))
    throw Error("列表长度无效");
  return value.map(parse);
}
function unique<T>(items: T[]): T[] {
  if (new Set(items).size !== items.length) throw Error("存在重复项");
  return items;
}
function path(value: unknown): string {
  const p = text(value, 250);
  if (
    !/^(?:src|docs|public)\/[a-zA-Z0-9_./-]+$/.test(p) ||
    p.split("/").some((x) => !x || x === "." || x === "..")
  )
    throw Error("无效项目相对路径");
  return p;
}
function url(value: unknown): string {
  const s = text(value, 500),
    u = new URL(s);
  if (!["https:", "http:"].includes(u.protocol) || u.username || u.password)
    throw Error("无效来源URL");
  return s;
}
export function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export function parseAssetMetadata(value: unknown): AssetMetadata {
  const a = record(value, [
    "schemaVersion",
    "id",
    "title",
    "contentVersion",
    "category",
    "biomes",
    "tags",
    "origin",
    "spatial",
    "gaussian",
    "quality",
    "provenance",
    "loader",
  ]);
  const s = record(a.spatial, [
    "unit",
    "metricScale",
    "scaleEvidence",
    "upAxis",
    "forwardAxis",
    "handedness",
    "dimensions",
    "dimensionBasis",
    "anchor",
    "radius",
  ]);
  const g = record(a.gaussian, ["full", "coarse", "shBands", "sourceBytes"]);
  const q = record(a.quality, ["status", "report", "limitations"]);
  const p = record(a.provenance, [
    "author",
    "source",
    "license",
    "licenseUrl",
    "licenseFile",
    "changes",
    "files",
  ]);
  const origin = oneOf(a.origin, ["captured", "procedural"] as const);
  const unit = oneOf(s.unit, ["display-unit", "metre"] as const);
  const metricScale = oneOf(s.metricScale, [true, false]);
  const scaleEvidence = s.scaleEvidence === null ? null : path(s.scaleEvidence);
  if (
    metricScale !== (unit === "metre") ||
    (metricScale && !scaleEvidence) ||
    (!metricScale && scaleEvidence)
  )
    throw Error("米制与定标依据不一致");
  if (!Array.isArray(s.dimensions) || s.dimensions.length !== 3)
    throw Error("尺寸无效");
  const dimensions: [number, number | null, number] = [
    finite(s.dimensions[0], Number.MIN_VALUE, 1000),
    s.dimensions[1] === null
      ? null
      : finite(s.dimensions[1], Number.MIN_VALUE, 1000),
    finite(s.dimensions[2], Number.MIN_VALUE, 1000),
  ];
  const full = integer(g.full, 1, 250000);
  const license = oneOf(p.license, ["CC-BY-4.0", "project-internal"] as const);
  const licenseUrl = p.licenseUrl === null ? null : url(p.licenseUrl);
  const licenseFile = p.licenseFile === null ? null : path(p.licenseFile);
  const files = list(
    p.files,
    (v) => {
      const f = record(v, ["path", "bytes", "sha256"]),
        sha256 = text(f.sha256, 64);
      if (!/^[0-9a-f]{64}$/.test(sha256)) throw Error("无效文件摘要");
      return {
        path: path(f.path),
        bytes: integer(f.bytes, 1, 64 * 1024 ** 2),
        sha256,
      };
    },
    16,
    true,
  );
  unique(files.map((f) => f.path));
  if (
    origin === "captured" &&
    (license !== "CC-BY-4.0" ||
      licenseUrl !== "https://creativecommons.org/licenses/by/4.0/" ||
      !licenseFile ||
      !files.length)
  )
    throw Error("实拍资产缺少原许可或文件依据");
  if (
    origin === "procedural" &&
    (license !== "project-internal" ||
      licenseUrl !== null ||
      licenseFile !== null ||
      files.length)
  )
    throw Error("程序资产不能虚构外部许可或实拍证据");
  const category = oneOf(a.category, categories),
    loader = oneOf(a.loader, loaders);
  if (
    (origin === "captured") !== (loader === "riverside-ground-v1") ||
    (category === "ground") !== (loader === "riverside-ground-v1")
  )
    throw Error("当前加载器不支持此来源/类别");
  const radius =
    s.radius === null ? null : finite(s.radius, Number.MIN_VALUE, 100);
  if ((category === "ground") !== (radius === null))
    throw Error("占地半径与类别不一致");
  return freeze({
    schemaVersion: oneOf(a.schemaVersion, [1] as const),
    id: identifier(a.id),
    title: text(a.title, 120),
    contentVersion: identifier(a.contentVersion),
    category,
    biomes: unique(list(a.biomes, (v) => oneOf(v, biomes), 2)),
    tags: unique(list(a.tags, identifier, 12)),
    origin,
    spatial: {
      unit,
      metricScale,
      scaleEvidence,
      upAxis: oneOf(s.upAxis, ["+Y"] as const),
      forwardAxis: oneOf(s.forwardAxis, ["+Z", null] as const),
      handedness: oneOf(s.handedness, ["right"] as const),
      dimensions,
      dimensionBasis: oneOf(s.dimensionBasis, [
        category === "ground" ? "usable-ground-area" : "placement-footprint",
      ] as const),
      anchor: vector(s.anchor, 3) as [number, number, number],
      radius,
    },
    gaussian: {
      full,
      coarse: g.coarse === null ? null : integer(g.coarse, 1, full),
      shBands: oneOf(g.shBands, [0, 1, 2, 3] as const),
      sourceBytes: integer(g.sourceBytes, 1, 64 * 1024 ** 2),
    },
    quality: {
      status: oneOf(q.status, ["trial", "legacy"] as const),
      report: path(q.report),
      limitations: list(q.limitations, (v) => text(v), 12),
    },
    provenance: {
      author: text(p.author, 120),
      source: origin === "captured" ? url(p.source) : path(p.source),
      license,
      licenseUrl,
      licenseFile,
      changes: text(p.changes),
      files,
    },
    loader,
  });
}
export function parseCatalog(value: unknown): readonly AssetMetadata[] {
  const entries = list(value, parseAssetMetadata, 100);
  unique(entries.map((a) => a.id));
  return freeze(
    entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  );
}
