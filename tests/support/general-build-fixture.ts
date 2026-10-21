import { sha256 } from "../../src/io/hash";
/** Isolated constructed byte/rights/review fixtures, NEVER registered in the real catalog. */
import { generalFixture, floatBytes } from "./general-fixture";
import { assetContentVersion } from "../../src/general-scene/asset-package";
import {
  parseAssetManifest,
  parseSurfaceStyle,
  type AssetManifestV2,
} from "../../src/general-scene/asset-manifest";
import {
  createCatalogView,
  makeAssetLibrary,
  styleContentVersion,
} from "../../src/general-scene/asset-library";
import { loadAsset } from "../../src/general-scene/asset-loader";
import { documentDigest } from "../../src/general-scene/canonical";
import {
  parseIntent,
  parsePlanDraft,
  parseEditableState,
  type CompileContext,
} from "../../src/general-scene/contracts";
import {
  planFixture,
  intentFixture,
  stateFixture,
  waterFixture,
} from "../../src/general-scene/test-fixtures";
export async function buildFixture(
  options: {
    categories?: string[];
    radius?: number;
    count?: number;
    patch?: boolean;
    anchor?: number;
    slope?: number;
    river?: boolean;
    patchSlope?: number;
    maxPlacementSlope?: number;
    points?: number;
    unusedVariant?: boolean;
    variantRadius?: number;
  } = {},
) {
  const packages: {
    manifest: AssetManifestV2;
    members: Map<string, Uint8Array>;
  }[] = [];
  for (const category of options.categories ?? ["rock"]) {
    const f = await generalFixture({ count: options.points ?? 4 });
    const m: any = structuredClone(f.manifest),
      old = m.id;
    m.id = `constructed-build-${category}`;
    m.category = category;
    const members = new Map<string, Uint8Array>();
    for (const [name, bytes] of f.members)
      members.set(name.replace(old, m.id), bytes);
    m.files = m.files.map((x: any) => ({
      ...x,
      path: x.path.replace(old, m.id),
    }));
    const r = options.radius ?? 0.05,
      a = options.anchor ?? 0;
    m.coordinates.fullBounds = { min: [a - r, 0, -r], max: [a + r, 0.6, r] };
    m.coordinates.usableBounds = structuredClone(m.coordinates.fullBounds);
    m.object = {
      ...m.object,
      maxSlopeDegrees: options.maxPlacementSlope ?? 15,
      anchor: [a, 0, 0],
      footprint: [
        [a - r, -r],
        [a + r, -r],
        [a + r, r],
        [a - r, r],
      ],
      collisionRadius: Math.SQRT2 * r,
      rotation: "upright-yaw",
      maxTiltDegrees: 0,
      supportPoints: [
        { id: "root", role: "root", position: [a, 0, 0] },
        ...[
          [a - r, -r],
          [a + r, -r],
          [a + r, r],
          [a - r, r],
        ].map(([x, z], i) => ({
          id: `edge${i}`,
          role: "edge",
          position: [x, 0, z],
        })),
      ],
    };
    if (a !== 0) {
      for (const file of m.files.filter((file: any) =>
        file.path.endsWith(".f32"),
      )) {
        const bytes = members.get(file.path)!,
          data = new Float32Array(
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ),
          );
        for (let index = 0; index < data.length; index += 14) data[index] = a;
        const changed = floatBytes(data);
        members.set(file.path, changed);
        file.sha256 = await sha256(changed);
        m.gaussian.full.sha256 = file.sha256;
      }
    }
    m.contentVersion = await assetContentVersion(m);
    admit(m);
    packages.push({ manifest: parseAssetManifest(m), members });
  }
  if (options.patch) {
    const f = await generalFixture({ patch: true });
    const m: any = structuredClone(f.manifest);
    m.patch.heightProxy.maxError = 0;
    if (options.patchSlope) {
      const heights = Float32Array.from(
        { length: 1681 },
        (_, i) =>
          ((i % 41) * 0.1 - 2) *
          Math.tan((options.patchSlope! * Math.PI) / 180),
      );
      const bytes = floatBytes(heights);
      f.members.set(m.patch.heightProxy.heightFile, bytes);
      const file = m.files.find(
        (x: any) => x.path === m.patch.heightProxy.heightFile,
      );
      file.sha256 = await sha256(bytes);
    }
    m.contentVersion = await assetContentVersion(m);
    admit(m);
    packages.push({ manifest: parseAssetManifest(m), members: f.members });
  }
  if (options.unusedVariant) {
    const source = packages[0],
      m: any = structuredClone(source.manifest),
      old = m.id;
    m.id = old + "-variant";
    if (options.variantRadius !== undefined) {
      const r = options.variantRadius,
        a = m.object.anchor[0];
      m.coordinates.fullBounds = { min: [a - r, 0, -r], max: [a + r, 0.6, r] };
      m.coordinates.usableBounds = structuredClone(m.coordinates.fullBounds);
      m.object.footprint = [
        [a - r, -r],
        [a + r, -r],
        [a + r, r],
        [a - r, r],
      ];
      m.object.collisionRadius = Math.SQRT2 * r;
      m.object.supportPoints = [
        { id: "root", role: "root", position: [a, 0, 0] },
        ...m.object.footprint.map(([x, z]: number[], i: number) => ({
          id: `edge${i}`,
          role: "edge",
          position: [x, 0, z],
        })),
      ];
    }
    m.quality.humanReview = null;
    m.quality.status = "candidate";
    const members = new Map<string, Uint8Array>();
    for (const [name, bytes] of source.members)
      members.set(name.replace(old, m.id), bytes);
    m.files = m.files.map((file: any) => ({
      ...file,
      path: file.path.replace(old, m.id),
    }));
    m.contentVersion = await assetContentVersion(m);
    admit(m);
    packages.push({ manifest: parseAssetManifest(m), members });
  }
  const base = packages[0].manifest;
  const s: any = {
    id: "constructed-build-style",
    contentVersion: "pending",
    parameters: {
      "sampler-version": 1,
      "tangent-scale": 0.7,
      "normal-scale": 0.1,
      opacity: 1,
      "terrain-color": [0.18, 0.23, 0.09],
      "water-color": [0.025, 0.16, 0.21],
      "color-variation": 0.12,
      "shore-step": 0.5,
    },
    quality: {
      ...structuredClone(base.quality),
      operations: ["browse"],
      humanReview: null,
      status: "candidate",
    },
    provenance: base.provenance,
  };
  s.contentVersion = await styleContentVersion(s);
  s.quality.status = "accepted";
  s.quality.humanReview = {
    reviewer: "Constructed fixture — not human admission",
    reviewedAt: "2026-10-13T00:00:00Z",
    asset: { id: s.id, contentVersion: s.contentVersion },
    files: [{ path: "style-identity.json", sha256: s.contentVersion.slice(7) }],
    operations: ["browse"],
  };
  const style = parseSurfaceStyle(s),
    lib = makeAssetLibrary(
      await createCatalogView(
        packages.map((p) => p.manifest),
        options.patch ? [] : [style],
      ),
      async (ref, name) => {
        const p = packages.find(
          (p) =>
            p.manifest.id === ref.id &&
            p.manifest.contentVersion === ref.contentVersion,
        );
        const b = p?.members.get(name);
        if (!b) throw Error("Missing exact constructed member");
        return new Uint8Array(b);
      },
    );
  const i = intentFixture();
  i.raw = "Constructed structured scene";
  i.requestId = "build-operation";
  i.prohibitions = [];
  i.features = packages
    .filter(
      (p) =>
        p.manifest.kind === "object" && !p.manifest.id.endsWith("-variant"),
    )
    .map((p) => ({
      featureId: p.manifest.category,
      category: p.manifest.category,
      required: true,
      quantity: {
        key: "count",
        value: options.count ?? 1,
        source: "manual",
        span: null,
        strength: "hard",
        negated: false,
      },
      sourceRestriction: "procedural",
      constraints: [],
    }));
  i.terrain = [
    {
      key: "source",
      value: options.patch ? "patch" : "procedural",
      source: "manual",
      span: null,
      strength: "hard",
      negated: false,
    },
  ];
  i.water = {
    mode: options.river ? "river" : "none",
    constraints: options.river
      ? [
          {
            key: "level",
            value: 0,
            source: "manual",
            span: null,
            strength: "hard",
            negated: false,
          },
        ]
      : [],
  };
  const intent = parseIntent(i),
    p = planFixture();
  p.planId = "build-plan";
  p.intentDigest = await documentDigest(intent);
  p.catalogDigest = lib.digest;
  p.generatorVersion = "general-planner-v1";
  p.rulesVersion = "general-rules-v1";
  p.surfaceStyleRef = options.patch
    ? null
    : { id: style.id, contentVersion: style.contentVersion };
  p.terrain.slopeDegrees = options.slope ?? 0;
  if (options.patch) {
    const m = packages.at(-1)!.manifest;
    if (m.kind !== "patch") throw Error("patch");
    p.terrain = {
      source: "patch",
      assetRef: { id: m.id, contentVersion: m.contentVersion },
      transform: m.patch.displayTransform,
    };
  }
  if (options.river)
    p.water = {
      ...waterFixture(),
      controlPoints: [
        [0.50125, 0],
        [0.50125, 1],
      ],
      level: 0,
      levelSource: "manual",
    };
  p.groups = packages
    .filter(
      (p) =>
        p.manifest.kind === "object" && !p.manifest.id.endsWith("-variant"),
    )
    .map(({ manifest: m }) => ({
      groupId: m.category,
      assetRef: { id: m.id, contentVersion: m.contentVersion },
      regionId: "all",
      count: options.count ?? 1,
      countMode: "hard",
      required: true,
      scaleRange: [1, 1],
      orientation: { mode: "upright-yaw", yawDegrees: [0, 360] },
      placementPolicy: {
        maxSlopeDegrees: options.maxPlacementSlope ?? 15,
        spacingMargin: 0.1,
      },
    }));
  p.relations = [];
  const requirementDigest = await documentDigest({
    operationId: intent.requestId,
    prompt: intent.raw,
    baseRevisionId: intent.baseRevisionId,
    manualOverrides: [],
  });
  const selected = [
    ...packages
      .filter(
        (p) =>
          p.manifest.kind === "object" && !p.manifest.id.endsWith("-variant"),
      )
      .map(({ manifest: m }, index) => ({
        slotId: `object:${index}`,
        groupId: m.category,
        assetRef: { id: m.id, contentVersion: m.contentVersion },
        digest: m.contentVersion.slice(7),
      })),
    ...(options.patch
      ? [
          {
            slotId: "patch:terrain",
            groupId: null,
            assetRef: {
              id: packages.at(-1)!.manifest.id,
              contentVersion: packages.at(-1)!.manifest.contentVersion,
            },
            digest: packages.at(-1)!.manifest.contentVersion.slice(7),
          },
        ]
      : [
          {
            slotId: "style:surfaceStyle",
            groupId: null,
            assetRef: { id: style.id, contentVersion: style.contentVersion },
            digest: style.contentVersion.slice(7),
          },
        ]),
  ];
  for (const choice of selected) {
    p.review.manualOverrides.push({
      key: `accept.procedural.${choice.slotId}`,
      value: {
        groupId: choice.groupId,
        requirementDigest,
        catalogDigest: lib.digest,
        assetRef: choice.assetRef,
        digest: choice.digest,
      },
      source: "manual",
      span: null,
      strength: "hard",
      negated: false,
    });
    if (choice.groupId !== null) {
      const substitutionId = `procedural:${choice.slotId}`;
      p.review.substitutions.push({
        substitutionId,
        groupId: choice.groupId,
        requested: `${choice.groupId}/procedural`,
        assetRef: choice.assetRef,
        digest: choice.digest,
        reason: "Explicit constructed software fixture choice",
      });
      p.review.acceptedSubstitutions.push({
        substitutionId,
        planId: p.planId,
        catalogDigest: lib.digest,
        assetRef: choice.assetRef,
        digest: choice.digest,
      });
    }
  }

  const st = stateFixture();
  st.groups = [];
  const state = parseEditableState(st),
    draft = parsePlanDraft(p),
    assets = await Promise.all(
      packages.map((p) =>
        loadAsset(p.manifest, lib, new AbortController().signal),
      ),
    );
  const context: CompileContext = {
    operationId: "build-operation",
    baseRevisionId: null,
    sceneId: "constructed-scene",
    revisionId: "constructed-revision",
    signal: new AbortController().signal,
    intent,
    modelEvidence: [],
    patch: null,
    camera: { position: [4, 3, 5], target: [0, 0, 0] },
    resources: { retainedBytes: 0 },
    baseSnapshot: null,
  };
  return {
    draft,
    state,
    assets,
    library: lib,
    style,
    intent,
    context,
    packages,
  };
}
function admit(m: any) {
  m.gaussian.full.quality = {
    status: "passed",
    report: "docs/constructed-only.md",
  };
  if (m.gaussian.coarse)
    m.gaussian.coarse.quality = {
      status: "passed",
      report: "docs/constructed-only.md",
    };
  m.quality.status = "accepted";
  m.quality.inspectionViews = [{ position: [0, 1, 3], target: [0, 0, 0] }];
  m.quality.humanReview = {
    reviewer: "Constructed fixture — not human admission",
    reviewedAt: "2026-10-13T00:00:00Z",
    asset: { id: m.id, contentVersion: m.contentVersion },
    files: m.files.map(({ path, sha256 }: any) => ({ path, sha256 })),
    operations: m.quality.operations,
  };
}

/** Identity-only adapter for immutable constructed property cases. Geometry and expected invariants stay untouched. */
export async function bindBuildProperty(input: unknown) {
  const original = parsePlanDraft(input),
    categories = original.groups.map((g) => g.groupId),
    f = await buildFixture({ categories });
  const atom = (key: string, value: unknown) => ({
    key,
    value,
    source: "manual",
    span: null,
    strength: "hard",
    negated: false,
  });
  const prefix = "Constructed frozen property " + original.planId,
    levelText =
      "level" in original.water && original.water.level !== null
        ? String(original.water.level)
        : "",
    raw = prefix + (levelText ? " explicit level " + levelText : ""),
    levelSpan = [raw.length - levelText.length, raw.length];
  const i = parseIntent({
    ...f.intent,
    requestId: "property-" + original.planId,
    raw,
    features: original.groups.map((g) => ({
      featureId: g.groupId,
      category: g.groupId,
      required: g.required,
      quantity: {
        ...atom("count", g.count),
        strength: g.countMode === "hard" ? "hard" : "suggestion",
      },
      sourceRestriction: "procedural",
      constraints: [],
    })),
    terrain: [
      atom("source", original.terrain.source),
      atom("width", original.domain.width),
      atom("depth", original.domain.depth),
    ],
    water: {
      mode: original.water.mode,
      constraints:
        "levelStatus" in original.water &&
        original.water.levelStatus === "resolved"
          ? [
              {
                ...atom("level", original.water.level),
                source: original.water.levelSource,
                span: original.water.levelSource === "user" ? levelSpan : null,
              },
            ]
          : [],
    },
    seed: atom("seed", original.seed),
    relations: original.relations.map(({ kind, ...value }) =>
      atom(kind, value),
    ),
  });
  const requirementDigest = await documentDigest({
      operationId: i.requestId,
      prompt: i.raw,
      baseRevisionId: i.baseRevisionId,
      manualOverrides: [],
    }),
    review = structuredClone(f.draft.review);
  for (const a of review.manualOverrides)
    if (a.value && typeof a.value === "object" && !Array.isArray(a.value))
      a.value = { ...a.value, requirementDigest };
  for (const a of review.acceptedSubstitutions) a.planId = original.planId;
  const draft = parsePlanDraft({
    ...original,
    intentDigest: await documentDigest(i),
    catalogDigest: f.library.digest,
    generatorVersion: "general-planner-v1",
    rulesVersion: "general-rules-v1",
    surfaceStyleRef: f.draft.surfaceStyleRef,
    groups: original.groups.map((g) => ({
      ...g,
      assetRef: f.draft.groups.find((x) => x.groupId === g.groupId)!.assetRef,
    })),
    review,
  });
  return {
    ...f,
    draft,
    intent: i,
    context: {
      ...f.context,
      intent: i,
      operationId: i.requestId,
      revisionId: "revision-" + original.planId,
    },
    bindings: {
      originalDigest: await documentDigest(input),
      adaptedDraftDigest: await documentDigest(draft),
      intentDigest: await documentDigest(i),
      catalogDigest: f.library.digest,
      constructedIntentRaw: i.raw,
      waterLevelAtoms: i.water.constraints,
      provenance:
        "constructed; identity bindings and explicit fixture confirmations only; geometry unchanged",
    },
  };
}
