/** Constructed test evidence only. Never import this file into a production library. */
const hash = "a".repeat(64);
const transform = () => ({
  position: [0, 0, 0],
  quaternion: [0, 0, 0, 1],
  scale: 1,
});
const bounds = () => ({ min: [-1, 0, -1], max: [1, 2, 1] });
export function manifestFixture(
  kind: "object" | "patch" | "environment" = "object",
) {
  const base = {
    schemaVersion: 2,
    id: `constructed-${kind}`,
    contentVersion: "constructed-v1",
    kind,
    category:
      kind === "object" ? "rock" : kind === "patch" ? "ground" : "environment",
    tags: ["constructed"],
    environments: ["wetland"],
    origin: "captured",
    files: [{ path: "assets/constructed/data.ply", bytes: 1024, sha256: hash }],
    coordinates: {
      handedness: "right",
      upAxis: "+Y",
      forwardAxis: "+Z",
      sourceToCanonical: transform(),
      normalizationEvidence: "docs/constructed-normalization.md",
      unit: "display-unit",
      scaleEvidence: null,
      fullBounds: bounds(),
      usableBounds: bounds(),
    },
    gaussian: {
      shDegree: 0,
      full: {
        points: 1000,
        sha256: hash,
        quality: { status: "unreviewed", report: null },
      },
      coarse: null,
      bakedLighting: false,
      exposureFamily: "neutral",
      toneFamily: "neutral",
      validatedDistance: [1, 10],
      validatedDirections: [[0, 0, 1]],
      shRotation: "fixed",
    },
    resources: {
      decodedBytes: 56000,
      cpuSourceBytes: 1024,
      uploadBytes: 56000,
    },
    provenance: {
      author: "Constructed fixture author",
      source: "docs/constructed-source.md",
      license: {
        id: "project-internal",
        summary: "Constructed internal-use evidence; no distribution grant.",
        evidence: "docs/constructed-license.md",
        attribution: "Constructed fixture author",
        redistributable: false,
        redistributionBasis: "No redistribution permission.",
      },
      changes: "Constructed test geometry only.",
      derivedFrom: [],
    },
    quality: {
      status: "candidate",
      report: "docs/constructed-review.md",
      limitations: ["Constructed test evidence, not visual acceptance."],
      inspectionViews: [],
      operations:
        kind === "object"
          ? ["place", "rotate", "uniform-scale", "remove"]
          : kind === "patch"
            ? ["browse", "place-on-patch"]
            : ["browse"],
      humanReview: null,
    },
    loader: `gaussian-${kind}-v2`,
  };
  if (kind === "object")
    return {
      ...base,
      object: {
        anchor: [0, 0, 0],
        anchorBaked: false,
        supportPoints: [
          { id: "root", role: "root", position: [0, 0, 0] },
          { id: "edge-a", role: "edge", position: [-1, 0, -1] },
          { id: "edge-b", role: "edge", position: [1, 0, -1] },
          { id: "edge-c", role: "edge", position: [1, 0, 1] },
          { id: "edge-d", role: "edge", position: [-1, 0, 1] },
        ],
        footprint: [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ],
        collisionRadius: 1.5,
        maxSlopeDegrees: 15,
        maxTiltDegrees: 15,
        contactTolerance: { min: -0.02, max: 0.05 },
        allowedBurial: 0.02,
        scaleRange: [1, 1],
        scaleRangeEvidence: null,
        rotation: "surface-normal",
        verifiedYawDegrees: [0],
      },
    };
  const heightProxy = {
    contentVersion: "constructed-proxy-v1",
    heightFile: "assets/constructed/heights.bin",
    normalFile: "assets/constructed/normals.bin",
    maxError: 0.01,
  };
  if (kind === "patch")
    return {
      ...base,
      files: [
        ...base.files,
        { path: heightProxy.heightFile, bytes: 400, sha256: "b".repeat(64) },
        { path: heightProxy.normalFile, bytes: 1200, sha256: "c".repeat(64) },
      ],
      patch: {
        usablePolygon: [
          [-0.8, -0.8],
          [0.8, -0.8],
          [0.8, 0.8],
          [-0.8, 0.8],
        ],
        heightProxy,
        voidMask: [],
        waterMask: [],
        edgeBuffer: 0.2,
        displayTransform: transform(),
      },
    };
  return {
    ...base,
    environment: {
      displayTransform: transform(),
      browseBounds: bounds(),
      heightProxy: null,
      camera: {
        initial: { position: [0, 1, 3], target: [0, 1, 0] },
        near: 0.01,
        far: 100,
        distance: [0.1, 50],
      },
    },
  };
}

/** All following scene/evidence data is constructed; no model or human acceptance is claimed. */
export const sceneHashFixture = "a".repeat(64);
export const sceneTransformFixture = () => ({
  position: [0, 0, 0],
  quaternion: [0, 0, 0, 1],
  scale: 1,
});
export const regionFixture = () => [
  [-2, -2],
  [2, -2],
  [2, 2],
  [-2, 2],
];
export function intentFixture(): any {
  return {
    documentType: "general-scene-intent",
    schemaVersion: 1,
    requestId: "request:constructed",
    raw: "不要程序草，放2组石头，不要水。",
    language: "zh-CN",
    operation: "create",
    baseRevisionId: null,
    terrain: [],
    features: [
      {
        featureId: "rocks",
        category: "rock",
        required: true,
        quantity: {
          key: "count",
          value: 2,
          source: "user",
          span: [7, 8],
          strength: "hard",
          negated: false,
        },
        sourceRestriction: "either",
        constraints: [],
      },
    ],
    sourceConstraints: [],
    relations: [],
    prohibitions: [
      {
        key: "grass.origin",
        value: "procedural",
        source: "user",
        span: [0, 5],
        strength: "hard",
        negated: true,
      },
    ],
    water: { mode: "none", constraints: [] },
    seed: null,
    unspecified: [],
    conflicts: [],
    unsupported: [],
  };
}
export function planFixture(): any {
  return {
    documentType: "general-scene-plan",
    schemaVersion: 1,
    planId: "plan:constructed",
    intentDigest: sceneHashFixture,
    catalogDigest: sceneHashFixture,
    generatorVersion: "constructed-v1",
    rulesVersion: "constructed-v1",
    prngVersion: "fnv1a32-v1",
    seed: 42,
    domain: { width: 4, depth: 4, unit: "display-unit", up: "+Y" },
    terrain: {
      source: "procedural",
      elevation: 0,
      slopeDegrees: 0,
      slopeAzimuthDegrees: 0,
      noiseAmplitude: 0,
      noiseScale: 2,
      noiseOctaves: 1,
      spacing: 0.1,
    },
    water: { mode: "none" },
    surfaceStyleRef: {
      id: "constructed-style",
      contentVersion: "constructed-v1",
    },
    regions: [
      {
        regionId: "all",
        shape: { kind: "rectangle", min: [-2, -2], max: [2, 2] },
      },
    ],
    groups: [
      {
        groupId: "grass",
        assetRef: {
          id: "constructed-object",
          contentVersion: "constructed-v1",
        },
        regionId: "all",
        count: 2,
        countMode: "hard",
        required: true,
        scaleRange: [1, 1],
        orientation: { mode: "upright-yaw", yawDegrees: [0, 360] },
        placementPolicy: { maxSlopeDegrees: 15, spacingMargin: 0.1 },
      },
    ],
    relations: [{ kind: "keepDry", groupId: "grass", distance: 0.1 }],
    budgetProfileId: "general-v1",
    budgetEstimate: null,
    review: {
      assumptions: [],
      unsupported: [],
      missing: [],
      substitutions: [],
      acceptedSubstitutions: [],
      manualOverrides: [],
      fieldSources: [],
    },
  };
}
export function waterFixture(pending = false): any {
  return {
    mode: "river",
    waterId: "water",
    controlPoints: [
      [0.5, 0],
      [0.5, 1],
    ],
    width: 0.6,
    depth: 0.1,
    bankWidth: 0.4,
    level: pending ? null : -0.025,
    levelStatus: pending ? "pending" : "resolved",
    levelSource: pending ? null : "default",
    reshapePolicy: "cut-and-fill",
  };
}
export function stateFixture(): any {
  return {
    documentType: "general-scene-editable-state",
    schemaVersion: 1,
    groups: [{ groupId: "grass", nextSlot: 1, retired: false }],
    tombstones: [],
    lockedInstanceIds: [],
    overrides: [],
    brushes: [],
    affectedRegions: [],
    deduplications: [],
  };
}
export function brushFixture(sequence = 1): any {
  return {
    sequence,
    center: [0, 0],
    radius: 0.5,
    delta: 0.1,
    requestedRegion: regionFixture(),
    effectiveRegion: regionFixture(),
  };
}
export function patchFixture(): any {
  return {
    documentType: "general-scene-patch",
    schemaVersion: 1,
    patchId: "patch:constructed",
    baseRevisionId: "revision:base",
    raw: "移走这块石头",
    requestedRegion: regionFixture(),
    effectiveRegion: regionFixture(),
    targetInstanceIds: ["grass:0"],
    lockedInstanceIds: [],
    affectedInstanceIds: ["grass:0"],
    affectedTileIds: [],
    operations: [{ kind: "remove", instanceId: "grass:0" }],
    review: {
      scopeAccepted: true,
      planDigest: sceneHashFixture,
      catalogDigest: sceneHashFixture,
      assetBindings: [
        ["constructed-object", "constructed-v1", sceneHashFixture],
      ],
    },
  };
}
export function evidenceFixture(): any {
  return {
    stage: "intent",
    provenance: "constructed",
    requestedModel: "constructed-model",
    raw: null,
    model: null,
    promptVersion: "constructed-v1",
    startedAt: "2026-10-11T00:00:00.000Z",
    endedAt: "2026-10-11T00:00:01.000Z",
    failureReason: "Constructed timeout",
  };
}
export function snapshotFixture(): any {
  const manifest = manifestFixture();
  const style = {
    id: "constructed-style",
    contentVersion: "constructed-v1",
    parameters: { opacity: 1 },
    quality: { ...manifest.quality, operations: ["browse", "place-on-patch"] },
    provenance: manifest.provenance,
  };
  const normals = new Float32Array(41 * 41 * 3);
  for (let i = 0; i < 41 * 41; i++) normals[3 * i + 1] = 1;
  const check = () => ({ status: "pending", evidenceRefs: [], issues: [] });
  return {
    documentType: "general-scene-snapshot",
    schemaVersion: 1,
    capability: "editable",
    sceneId: "scene:constructed",
    revisionId: "revision:constructed",
    parentRevisionId: null,
    operationId: "operation:constructed",
    intent: intentFixture(),
    plan: planFixture(),
    state: stateFixture(),
    modelEvidence: [evidenceFixture()],
    patch: null,
    assets: [
      {
        assetRef: { id: manifest.id, contentVersion: manifest.contentVersion },
        digest: sceneHashFixture,
        manifest,
      },
    ],
    surfaceStyle: {
      assetRef: { id: style.id, contentVersion: style.contentVersion },
      digest: sceneHashFixture,
      descriptor: style,
    },
    terrain: {
      space: "world",
      transform: null,
      width: 4,
      depth: 4,
      spacing: 0.1,
      nx: 41,
      nz: 41,
      layout: "row-major-zx",
      heights: new Float32Array(1681),
      normals,
      proxyError: 0,
      digest: sceneHashFixture,
      tiles: [
        {
          id: "tile:0:0",
          bounds: { min: [-2, -2], max: [2, 2] },
          nodeIndices: Uint32Array.from({ length: 1681 }, (_, i) => i),
          outputIndices: Uint32Array.from({ length: 1681 }, (_, i) => i),
          digest: sceneHashFixture,
        },
      ],
    },
    water: { mode: "none" },
    surfaces: [
      {
        role: "terrain",
        waterId: null,
        format: "float14",
        count: 1,
        data: new Float32Array([
          0, 0, 0, 0.1, 0.1, 0.1, 0, 0, 0, 1, 0.5, 0.5, 0.5, 1,
        ]),
        digest: sceneHashFixture,
        tiles: [
          {
            tileId: "tile:0:0",
            outputIndices: new Uint32Array([0]),
            digest: sceneHashFixture,
          },
        ],
      },
    ],
    instances: [
      {
        instanceId: "grass:0",
        groupId: "grass",
        assetRef: { id: manifest.id, contentVersion: manifest.contentVersion },
        transform: sceneTransformFixture(),
        locked: false,
      },
    ],
    geometryDigest: sceneHashFixture,
    camera: { position: [0, 2, 4], target: [0, 0, 0] },
    reviewStatus: "draft",
    quality: {
      geometryDigest: sceneHashFixture,
      semanticMode: "unverified",
      semantic: check(),
      assets: check(),
      geometry: check(),
      visual: check(),
      performance: check(),
    },
    validation: {
      requested: 2,
      accepted: 1,
      shortfall: 1,
      rejections: [
        {
          groupId: "grass",
          instanceId: null,
          reason: {
            code: "constructed",
            path: "groups.grass",
            message: "Constructed placement shortfall",
          },
        },
      ],
      usage: {
        instances: 1,
        worstSplats: 1001,
        candidateCpuBytes: 1000000,
        transitionBytes: 2000000,
      },
      // Constructed 1,000-point float14 object source plus one generated terrain point.
      actualSourceBytes: 56056,
      buildMs: 1,
    },
  };
}

/** T6 constructed grid fixtures. Analytic heights are not surveyed/accepted patch data. */
export function terrainPlanFixture(
  options: {
    width?: number;
    depth?: number;
    terrain?: Record<string, unknown>;
  } = {},
): any {
  const plan = planFixture();
  plan.domain.width = options.width ?? 4;
  plan.domain.depth = options.depth ?? 4;
  plan.regions[0].shape.min = [-plan.domain.width / 2, -plan.domain.depth / 2];
  plan.regions[0].shape.max = [plan.domain.width / 2, plan.domain.depth / 2];
  Object.assign(plan.terrain, options.terrain);
  return plan;
}
export function terrainProxyFixture(): import("./asset-loader.ts").PatchProxy {
  return {
    width: 4,
    depth: 4,
    spacing: 0.1,
    heights: Float32Array.from(
      { length: 1681 },
      (_, i) =>
        0.1 * ((i % 41) * 0.1 - 2) + 0.2 * (Math.floor(i / 41) * 0.1 - 2),
    ),
    validPolygon: [
      [-2, -2],
      [2, -2],
      [2, 2],
      [-2, 2],
    ],
    voidMask: [],
    errorBound: 0.01,
    transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 },
  };
}
