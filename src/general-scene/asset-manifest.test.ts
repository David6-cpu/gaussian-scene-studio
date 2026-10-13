import { describe, expect, test } from "vitest";
import { parseAssetManifest, legacyAssetRef } from "./asset-manifest";
import { assertBudget, GENERAL_LIMITS } from "./core";
import { manifestFixture } from "./test-fixtures";
import { assetCatalog } from "../assets/catalog/entries";

// Mutations exercise public rejection behavior, never parser internals.
const copy = (kind: "object" | "patch" | "environment" = "object"): any =>
  manifestFixture(kind);
describe("AssetManifest v2", () => {
  test.each(["object", "patch", "environment"] as const)(
    "parses and freezes a constructed %s without inventing coarse LOD",
    (kind) => {
      const result = parseAssetManifest(manifestFixture(kind));
      expect(result.kind).toBe(kind);
      expect(result.id).toBe(`constructed-${kind}`);
      expect(result.gaussian.coarse).toBeNull();
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.coordinates.fullBounds.min)).toBe(true);
    },
  );
  test.each([
    [
      "old schema",
      (a: any) => {
        a.schemaVersion = 1;
      },
    ],
    [
      "unknown key",
      (a: any) => {
        a.unexpected = true;
      },
    ],
    [
      "nested unknown key",
      (a: any) => {
        a.resources.extra = 1;
      },
    ],
    [
      "missing license",
      (a: any) => {
        delete a.provenance.license;
      },
    ],
    [
      "unknown candidate license",
      (a: any) => {
        a.provenance.license.id = "unknown";
      },
    ],
    [
      "internal license redistribution",
      (a: any) => {
        a.provenance.license.redistributable = true;
      },
    ],
    [
      "incorrect up axis",
      (a: any) => {
        a.coordinates.upAxis = "+Z";
      },
    ],
    [
      "left handed coordinates",
      (a: any) => {
        a.coordinates.handedness = "left";
      },
    ],
    [
      "negative scale",
      (a: any) => {
        a.coordinates.sourceToCanonical.scale = -1;
      },
    ],
    [
      "zero scale",
      (a: any) => {
        a.coordinates.sourceToCanonical.scale = 0;
      },
    ],
    [
      "nonuniform scale",
      (a: any) => {
        a.coordinates.sourceToCanonical.scale = [1, 2, 1];
      },
    ],
    [
      "unnormalized quaternion",
      (a: any) => {
        a.coordinates.sourceToCanonical.quaternion = [0, 0, 0, 2];
      },
    ],
    [
      "nonfinite coordinate",
      (a: any) => {
        a.object.anchor[0] = NaN;
      },
    ],
    [
      "unsubstantiated metre scale",
      (a: any) => {
        a.coordinates.unit = "metre";
      },
    ],
    [
      "usable bounds outside full bounds",
      (a: any) => {
        a.coordinates.usableBounds.max[0] = 2;
      },
    ],
    [
      "fewer than three support points",
      (a: any) => {
        a.object.supportPoints.length = 2;
      },
    ],
    [
      "missing root support",
      (a: any) => {
        a.object.supportPoints.shift();
      },
    ],
    [
      "uncovered footprint",
      (a: any) => {
        a.object.supportPoints.forEach((p: any) => {
          p.position[0] *= 0.1;
          p.position[2] *= 0.1;
        });
      },
    ],
    [
      "duplicate support IDs",
      (a: any) => {
        a.object.supportPoints[1].id = "root";
      },
    ],
    [
      "unsafe radius",
      (a: any) => {
        a.object.collisionRadius = 0.1;
      },
    ],
    [
      "degenerate footprint",
      (a: any) => {
        a.object.footprint = [
          [0, 0],
          [0.5, 0],
          [1, 0],
        ];
      },
    ],
    [
      "self intersecting footprint",
      (a: any) => {
        a.object.footprint = [
          [-1, -1],
          [1, 1],
          [-1, 1],
          [1, -1],
        ];
      },
    ],
    [
      "looser contact tolerance",
      (a: any) => {
        a.object.contactTolerance.min = -0.03;
      },
    ],
    [
      "scale range without report",
      (a: any) => {
        a.object.scaleRange = [0.85, 1.1];
      },
    ],
    [
      "unverified SH3 rotation",
      (a: any) => {
        a.gaussian.shDegree = 3;
      },
    ],
    [
      "unknown admission status",
      (a: any) => {
        a.quality.status = "trial";
      },
    ],
    [
      "implicit accepted status",
      (a: any) => {
        a.quality.status = "accepted";
      },
    ],
    [
      "duplicate file paths",
      (a: any) => {
        a.files.push(a.files[0]);
      },
    ],
    [
      "invalid digest",
      (a: any) => {
        a.files[0].sha256 = "fake";
      },
    ],
    [
      "duplicate tags",
      (a: any) => {
        a.tags.push(a.tags[0]);
      },
    ],
    [
      "executable source",
      (a: any) => {
        a.provenance.source = "javascript:alert(1)";
      },
    ],
    [
      "executable loader",
      (a: any) => {
        a.loader = "https://example.invalid/script.js";
      },
    ],
    [
      "file traversal",
      (a: any) => {
        a.files[0].path = "assets/../private.bin";
      },
    ],
    [
      "executable file",
      (a: any) => {
        a.files[0].path = "assets/run.js";
      },
    ],
    [
      "fabricated coarse LOD",
      (a: any) => {
        a.gaussian.coarse = { points: 100 };
      },
    ],
    [
      "coarse exceeds full",
      (a: any) => {
        a.gaussian.coarse = { ...a.gaussian.full, points: 1001 };
      },
    ],
    [
      "oversized decoded arrays",
      (a: any) => {
        a.resources.decodedBytes = 128 * 1024 ** 2 + 1;
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const a = copy();
    (mutate as (a: any) => void)(a);
    expect(() => parseAssetManifest(a)).toThrow();
  });
  test("a nonzero canonical anchor and its support coordinates survive parsing exactly once", () => {
    const a = copy();
    a.coordinates.fullBounds.min[1] = 1;
    a.coordinates.fullBounds.max[1] = 3;
    a.coordinates.usableBounds.min[1] = 1;
    a.coordinates.usableBounds.max[1] = 3;
    a.object.anchor[1] = 1;
    a.object.supportPoints.forEach((p: any) => {
      p.position[1] = 1;
    });
    const parsed = parseAssetManifest(a);
    if (parsed.kind !== "object") throw Error("Expected object");
    expect(parsed.object.anchor).toEqual([0, 1, 0]);
    expect(parsed.object.supportPoints[0].position).toEqual([0, 1, 0]);
    expect(parsed.object.anchorBaked).toBe(false);
  });
  test.each([Number.MAX_VALUE, 1e200])(
    "rejects overflowing bow-tie patch coordinates of magnitude %s",
    (magnitude) => {
      const a = copy("patch");
      a.coordinates.fullBounds = {
        min: [-magnitude, 0, -magnitude],
        max: [magnitude, 2, magnitude],
      };
      a.coordinates.usableBounds = structuredClone(a.coordinates.fullBounds);
      a.patch.usablePolygon = [
        [-magnitude, -magnitude],
        [magnitude, magnitude],
        [-magnitude, magnitude],
        [magnitude, -magnitude],
      ];
      expect(() => parseAssetManifest(a)).toThrow();
    },
  );
  test("rejects polygon area accumulation that overflows despite finite edge products", () => {
    const a = copy("patch"),
      magnitude = 5e153;
    a.coordinates.fullBounds = {
      min: [-magnitude, 0, -magnitude],
      max: [magnitude, 2, magnitude],
    };
    a.coordinates.usableBounds = structuredClone(a.coordinates.fullBounds);
    a.patch.usablePolygon = [
      [-magnitude, -magnitude],
      [magnitude, -magnitude],
      [magnitude, magnitude],
      [-magnitude, magnitude],
    ];
    expect(() => parseAssetManifest(a)).toThrow();
  });
  test.each(["fullBounds", "browseBounds"])(
    "rejects infinite dimensions derived from finite environment %s",
    (field) => {
      const a = copy("environment");
      const overflowing = {
        min: [-Number.MAX_VALUE, 0, -1],
        max: [Number.MAX_VALUE, 2, 1],
      };
      if (field === "fullBounds") a.coordinates.fullBounds = overflowing;
      else a.environment.browseBounds = overflowing;
      expect(() => parseAssetManifest(a)).toThrow();
    },
  );
  test("finite derived dimensions remain valid without an invented coordinate ceiling", () => {
    const a = copy("environment");
    a.coordinates.fullBounds = { min: [-1e150, 0, -1], max: [1e150, 2, 1] };
    const result = parseAssetManifest(a);
    expect(
      result.coordinates.fullBounds.max[0] -
        result.coordinates.fullBounds.min[0],
    ).toBe(2e150);
  });
  test("uncalibrated assets do not acquire metre scale evidence", () => {
    const a = copy();
    a.coordinates.unit = "uncalibrated";
    expect(parseAssetManifest(a).coordinates.unit).toBe("uncalibrated");
    a.coordinates.scaleEvidence = "docs/fake-scale.md";
    expect(() => parseAssetManifest(a)).toThrow();
  });
  test("valid independent coarse quality and verified SH3 orientation remain explicit", () => {
    const a = copy();
    a.gaussian.coarse = {
      points: 100,
      sha256: "b".repeat(64),
      quality: { status: "failed", report: "docs/constructed-coarse.md" },
    };
    a.gaussian.shDegree = 3;
    a.gaussian.shRotation = "local-view";
    expect(parseAssetManifest(a).gaussian.coarse?.quality.status).toBe(
      "failed",
    );
    a.gaussian.shRotation = "fixed";
    a.object.rotation = "fixed";
    a.quality.operations = ["place", "remove"];
    expect(parseAssetManifest(a).gaussian.shDegree).toBe(3);
  });
  test("accepted is structurally valid only with corresponding human review scope", () => {
    const a = copy();
    a.quality.status = "accepted";
    a.gaussian.full.quality = {
      status: "passed",
      report: "docs/constructed-full-review.md",
    };
    a.quality.inspectionViews = [{ position: [0, 1, 3], target: [0, 1, 0] }];
    a.quality.humanReview = {
      reviewer: "Constructed reviewer",
      reviewedAt: "2026-10-09T12:00:00Z",
      asset: { id: a.id, contentVersion: a.contentVersion },
      files: a.files.map((file: any) => ({
        path: file.path,
        sha256: file.sha256,
      })),
      operations: [...a.quality.operations],
    };
    expect(parseAssetManifest(a).quality.status).toBe("accepted");
    a.quality.humanReview.asset.contentVersion = "different-v2";
    expect(() => parseAssetManifest(a)).toThrow();
    a.quality.humanReview.asset.contentVersion = a.contentVersion;
    a.quality.humanReview.operations = ["place"];
    expect(() => parseAssetManifest(a)).toThrow();
  });
  test.each([
    { reviewedAt: "2026-02-29T12:00:00Z", valid: false },
    { reviewedAt: "2026-02-30T12:00:00Z", valid: false },
    { reviewedAt: "2026-04-31T12:00:00Z", valid: false },
    { reviewedAt: "2026-10-09T24:00:00Z", valid: false },
    { reviewedAt: "2024-02-29T12:00:00Z", valid: true },
    { reviewedAt: "2024-02-29T12:00:00.000Z", valid: true },
    { reviewedAt: "2024-02-29T12:00:00.123Z", valid: true },
  ])(
    "review timestamp $reviewedAt has calendar validity $valid",
    ({ reviewedAt, valid }) => {
      const a = copy();
      a.quality.status = "accepted";
      a.gaussian.full.quality = {
        status: "passed",
        report: "docs/constructed-full-review.md",
      };
      a.quality.inspectionViews = [{ position: [0, 1, 3], target: [0, 1, 0] }];
      a.quality.humanReview = {
        reviewer: "Constructed reviewer",
        reviewedAt,
        asset: { id: a.id, contentVersion: a.contentVersion },
        files: a.files.map((file: any) => ({
          path: file.path,
          sha256: file.sha256,
        })),
        operations: [...a.quality.operations],
      };
      if (valid)
        expect(parseAssetManifest(a).quality.humanReview?.reviewedAt).toBe(
          reviewedAt,
        );
      else expect(() => parseAssetManifest(a)).toThrow();
    },
  );
  test.each([
    [
      "unknown proxy error",
      (a: any) => {
        a.patch.heightProxy.maxError = null;
      },
    ],
    [
      "missing proxy error",
      (a: any) => {
        delete a.patch.heightProxy.maxError;
      },
    ],
    [
      "unlisted proxy source",
      (a: any) => {
        a.patch.heightProxy.heightFile = "assets/other.bin";
      },
    ],
    [
      "unsupported patch transform",
      (a: any) => {
        a.patch.displayTransform.scale = [1, 2, 1];
      },
    ],
    [
      "invalid void mask",
      (a: any) => {
        a.patch.voidMask = [
          [
            [0, 0],
            [1, 0],
          ],
        ];
      },
    ],
  ])("rejects patch with %s", (_name, mutate) => {
    const a = copy("patch");
    (mutate as (a: any) => void)(a);
    expect(() => parseAssetManifest(a)).toThrow();
  });
  test.each(["gaussian-object-v2", "gaussian-patch-v2"])(
    "environment cannot use %s",
    (loader) => {
      expect(() =>
        parseAssetManifest({ ...manifestFixture("environment"), loader }),
      ).toThrow();
    },
  );
  test("environment cannot claim independent placement operations", () => {
    const a = copy("environment");
    a.quality.operations.push("place");
    expect(() => parseAssetManifest(a)).toThrow();
  });
  test("JSON input rejects accessors and non-plain executable objects without running them", () => {
    let ran = false;
    const a = copy();
    Object.defineProperty(a, "id", {
      enumerable: true,
      get() {
        ran = true;
        return "bad";
      },
    });
    expect(() => parseAssetManifest(a)).toThrow();
    expect(ran).toBe(false);
    expect(() => parseAssetManifest(new Date())).toThrow();
  });
  test("procedural source-code evidence is a reference, never a loadable data member", () => {
    const a = copy();
    a.origin = "procedural";
    a.provenance.source = "src/general-scene/surfaces.ts";
    expect(parseAssetManifest(a).provenance.source).toBe(
      "src/general-scene/surfaces.ts",
    );
    a.files[0].path = a.provenance.source;
    expect(() => parseAssetManifest(a)).toThrow();
  });
  test("verified headings do not contain the duplicate full-turn orientation", () => {
    const a = copy();
    a.object.verifiedYawDegrees = [0, 360];
    expect(() => parseAssetManifest(a)).toThrow();
  });
  test.each(["positions.f32", "rotations.u32"])(
    "declared SH3 array member %s is supported",
    (path) => {
      const a = copy();
      a.files[0].path = path;
      expect(parseAssetManifest(a).files[0].path).toBe(path);
    },
  );
  test.each(["script.js", "module.wasm", "program.exe", "unknown.xyz"])(
    "data member %s is not an allowed asset format",
    (path) => {
      const a = copy();
      a.files[0].path = path;
      expect(() => parseAssetManifest(a)).toThrow();
    },
  );
  test("flat package members preserve separate original source evidence", () => {
    const a = copy("patch");
    a.files.forEach((file: any) => {
      file.path = file.path.split("/").at(-1);
    });
    a.patch.heightProxy.heightFile = "heights.bin";
    a.patch.heightProxy.normalFile = "normals.bin";
    const parsed = parseAssetManifest(a);
    expect(parsed.files.map((file) => file.path)).toEqual([
      "data.ply",
      "heights.bin",
      "normals.bin",
    ]);
    expect(parsed.provenance.source).toBe("docs/constructed-source.md");
  });
  test("declared memory cannot exceed the combined transition ceiling", () => {
    const a = copy();
    a.resources = {
      decodedBytes: 64 * 1024 ** 2,
      cpuSourceBytes: 64 * 1024 ** 2,
      uploadBytes: 129 * 1024 ** 2,
    };
    expect(() => parseAssetManifest(a)).toThrow();
  });
  test("review binds every declared file digest to the asset version", () => {
    const a = copy();
    a.quality.status = "accepted";
    a.gaussian.full.quality = {
      status: "passed",
      report: "docs/constructed-full-review.md",
    };
    a.quality.inspectionViews = [{ position: [0, 1, 3], target: [0, 1, 0] }];
    a.quality.humanReview = {
      reviewer: "Constructed reviewer",
      reviewedAt: "2026-10-09T12:00:00Z",
      asset: { id: a.id, contentVersion: a.contentVersion },
      files: [{ path: a.files[0].path, sha256: a.files[0].sha256 }],
      operations: [...a.quality.operations],
    };
    expect(parseAssetManifest(a).quality.status).toBe("accepted");
    a.quality.humanReview.files[0].sha256 = "b".repeat(64);
    expect(() => parseAssetManifest(a)).toThrow();
    a.quality.humanReview.files = [];
    expect(() => parseAssetManifest(a)).toThrow();
  });
  test("legacy references retain identity and metadata without upgrading trial to accepted", () => {
    for (const old of assetCatalog) {
      const reference = legacyAssetRef(old);
      expect(reference).toMatchObject({
        id: old.id,
        contentVersion: old.contentVersion,
        status: old.quality.status === "trial" ? "candidate" : "legacy",
      });
      expect(reference.metadata).toBe(old);
    }
  });
});

describe("hard resource budgets", () => {
  const usage = {
    instances: 20,
    worstSplats: 250000,
    candidateCpuBytes: 128 * 1024 ** 2,
    transitionBytes: 256 * 1024 ** 2,
  };
  test("allows every exact upper boundary", () =>
    expect(() => assertBudget(usage, GENERAL_LIMITS)).not.toThrow());
  test.each([
    { instances: 21 },
    { worstSplats: 250001 },
    { candidateCpuBytes: 128 * 1024 ** 2 + 1 },
    { transitionBytes: 256 * 1024 ** 2 + 1 },
    { instances: -1 },
    { worstSplats: 0.5 },
    { candidateCpuBytes: NaN },
    { transitionBytes: Infinity },
  ])("rejects resource excess or invalid count %j", (change) =>
    expect(() =>
      assertBudget({ ...usage, ...change }, GENERAL_LIMITS),
    ).toThrow(),
  );
  test("requests cannot replace fixed ceilings", () => {
    expect(() =>
      assertBudget({ ...usage, instances: 21 }, {
        ...GENERAL_LIMITS,
        maxInstances: 100,
      } as any),
    ).toThrow();
    expect(() => {
      (GENERAL_LIMITS as any).maxInstances = 100;
    }).toThrow();
  });
});

// Surface styles have no Gaussian files: review binds the reproducible identity JSON.
describe("SurfaceStyle strict metadata", () => {
  test("parses candidate parameters without inventing points or acceptance", async () => {
    const { parseSurfaceStyle } = await import("./asset-manifest.ts");
    const m = manifestFixture("patch");
    const style = parseSurfaceStyle({
      id: "constructed-style",
      contentVersion: "pending",
      parameters: { color: [0.1, 0.2, 0.3], roughness: 0.5 },
      quality: m.quality,
      provenance: m.provenance,
    });
    expect(style.quality.status).toBe("candidate");
    expect(Object.isFrozen(style.parameters.color)).toBe(true);
  });
  test("rejects unsafe parameters, unknown license and unmatched style review", async () => {
    const { parseSurfaceStyle } = await import("./asset-manifest.ts");
    const m: any = manifestFixture("patch");
    const s: any = {
      id: "constructed-style",
      contentVersion: "sha256-" + "a".repeat(64),
      parameters: { roughness: Infinity },
      quality: m.quality,
      provenance: m.provenance,
    };
    expect(() => parseSurfaceStyle(s)).toThrow();
    s.parameters = { roughness: 0.5 };
    s.provenance.license.id = "unknown";
    expect(() => parseSurfaceStyle(s)).toThrow();
    s.provenance.license.id = "project-internal";
    s.quality.humanReview = {
      reviewer: "Constructed test reviewer",
      reviewedAt: "2026-10-10T12:00:00Z",
      asset: { id: s.id, contentVersion: s.contentVersion },
      files: [{ path: "wrong.json", sha256: "a".repeat(64) }],
      operations: s.quality.operations,
    };
    expect(() => parseSurfaceStyle(s)).toThrow();
  });
});

test("candidate can honestly leave distance, directions and headings unvalidated", () => {
  const m: any = manifestFixture();
  m.gaussian.validatedDistance = null;
  m.gaussian.validatedDirections = [];
  m.object.verifiedYawDegrees = [];
  m.quality.operations = [];
  const a = parseAssetManifest(m);
  expect(a.gaussian.validatedDistance).toBeNull();
  expect(a.gaussian.validatedDirections).toEqual([]);
  expect(a.kind === "object" && a.object.verifiedYawDegrees).toEqual([]);
});
test.each(["distance", "directions", "headings"])(
  "accepted cannot have unknown %s",
  (which) => {
    const m: any = manifestFixture();
    m.quality.status = "accepted";
    m.gaussian.full.quality = {
      status: "passed",
      report: "docs/constructed-full.md",
    };
    m.quality.inspectionViews = [{ position: [0, 1, 3], target: [0, 1, 0] }];
    m.quality.humanReview = {
      reviewer: "Constructed review only",
      reviewedAt: "2026-10-10T12:00:00Z",
      asset: { id: m.id, contentVersion: m.contentVersion },
      files: m.files.map((f: any) => ({ path: f.path, sha256: f.sha256 })),
      operations: m.quality.operations,
    };
    if (which === "distance") m.gaussian.validatedDistance = null;
    if (which === "directions") m.gaussian.validatedDirections = [];
    if (which === "headings") m.object.verifiedYawDegrees = [];
    expect(() => parseAssetManifest(m)).toThrow();
  },
);
