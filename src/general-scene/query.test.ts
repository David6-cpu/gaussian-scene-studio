import { expect, test } from "vitest";
import { queryCandidates } from "./query.ts";
import {
  asset,
  atom,
  intent,
  library,
} from "../../tests/support/general-planning-fixture.ts";

test("query uses authoritative versions, stable ordering and real required slots", async () => {
  const lib = await library([
    asset("rock-z"),
    asset("rock-a"),
    asset("test-ground", "ground", "patch"),
  ]);
  const q = queryCandidates(intent(), lib);
  expect(q.catalogDigest).toBe(lib.digest);
  expect(
    q.slots
      .find((s: any) => s.key === "rocks")!
      .candidates.map((c: any) => c.assetRef.id),
  ).toEqual(["rock-a", "rock-z"]);
  expect(
    q.slots.find((s: any) => s.key === "terrain")!.candidates[0].assetRef.id,
  ).toBe("test-ground");
  expect(q.missing).toEqual([]);
});
test("query reports forest without trees rather than substituting grass", async () => {
  const i = structuredClone(intent());
  i.raw = "森林";
  i.features[0].category = "tree";
  i.features[0].quantity = null;
  const q = queryCandidates(
    i,
    await library([
      asset("grass", "grass"),
      asset("test-ground", "ground", "patch"),
    ]),
  );
  expect(q.slots.find((s: any) => s.key === "rocks")).toMatchObject({
    status: "missing",
    candidates: [],
  });
  expect(q.missing.some((m: any) => m.required)).toBe(true);
  // Missing reasons are shown to users: name the category in Chinese, not by ID.
  const reasons = q.missing.map((m: any) => m.reason).join("\n");
  expect(reasons).toContain("树");
  expect(reasons).not.toMatch(/符合tree|tree及/);
});
test.each(["candidate", "legacy", "rejected"])(
  "%s assets cannot satisfy a generation slot",
  async (status) => {
    const m = structuredClone(asset());
    m.quality.status = status;
    const q = queryCandidates(
      intent(),
      await library([m, asset("test-ground", "ground", "patch")]),
    );
    expect(q.slots.find((s: any) => s.key === "rocks")!.candidates).toEqual([]);
    expect(q.rejected.some((r: any) => r.reason.includes("admission"))).toBe(
      true,
    );
  },
);
test.each([
  "source",
  "units",
  "license",
  "operation",
  "slope",
  "points",
  "memory",
])("query excludes an asset violating %s", async (field) => {
  const m = structuredClone(asset()),
    i = structuredClone(intent());
  if (field === "source") {
    m.origin = "procedural";
    i.features[0].sourceRestriction = "captured";
  }
  if (field === "units") m.coordinates.unit = "metre";
  if (field === "license") m.provenance.license.evidence = null;
  if (field === "operation") m.quality.operations = [];
  if (field === "slope") {
    m.object.maxSlopeDegrees = 2;
    i.features[0].constraints = [atom("maxSlopeDegrees", 10)];
  }
  if (field === "points") m.gaussian.full.points = 130000;
  if (field === "memory") m.resources.decodedBytes = 129 * 1024 ** 2;
  // Deliberately invalid boundary data models revoked/changed metadata; no asset is registered.
  const lib = await library();
  const q = queryCandidates(i, {
    ...lib,
    manifests: [m, lib.manifests.find((m) => m.kind === "patch")!],
  });
  expect(q.slots.find((s: any) => s.key === "rocks")!.candidates).toEqual([]);
  expect(q.missing.some((m: any) => m.key === "object:0")).toBe(true);
});
test("candidate clipping preserves one candidate for every slot before extra choices", async () => {
  const i = structuredClone(intent());
  i.features = Array.from({ length: 8 }, (_, n) => ({
    ...i.features[0],
    featureId: `g${n}`,
    category: `c${n}`,
    quantity: atom("count", 1),
  }));
  const manifests = i.features.flatMap((f: any) =>
    Array.from({ length: 5 }, (_, n) =>
      asset(`${f.category}-${n}`, f.category),
    ),
  );
  const q = queryCandidates(
    i,
    await library([...manifests, asset("test-ground", "ground", "patch")]),
  );
  expect(
    q.slots.every(
      (s: any) => s.candidates.length >= 1 && s.candidates.length <= 3,
    ),
  ).toBe(true);
  expect(
    q.slots.reduce((n: number, s: any) => n + s.candidates.length, 0),
  ).toBe(12);
  expect(q.trimmed.length).toBeGreaterThan(0);
  expect(q.missing).toEqual([]);
});
test("explicit counts and defaults are not silently reduced to fit the scene", async () => {
  const i = structuredClone(intent());
  i.features[0].quantity = atom("count", 21, "manual");
  expect(
    queryCandidates(i, await library()).issues.some(
      (x: any) => x.code === "count-budget",
    ),
  ).toBe(true);
  i.features[0].quantity = null;
  expect(
    queryCandidates(i, await library()).slots.find(
      (s: any) => s.key === "rocks",
    ),
  ).toMatchObject({ count: 4, countSource: "default" });
  i.features[0].quantity = atom("density", "sparse");
  expect(
    queryCandidates(i, await library()).slots.find(
      (s: any) => s.key === "rocks",
    ),
  ).toMatchObject({ count: 2, countSource: "model" });
});

test.each(["terrain", "surfaceStyle"])(
  "legal feature %s cannot mix candidate roles or exceed ceilings",
  async (key) => {
    const i = structuredClone(intent());
    i.features = [key, "other-a", "other-b", "other-c"].map((featureId) => ({
      ...i.features[0],
      featureId,
    }));
    const lib = {
      ...(await library([
        ...Array.from({ length: 5 }, (_, n) => asset(`rock-${n}`)),
        asset("test-ground", "ground", "patch"),
      ])),
    };
    if (key === "surfaceStyle") {
      i.terrain = [atom("source", "procedural")];
      const { style } =
        await import("../../tests/support/general-planning-fixture.ts");
      Object.assign(lib, { styles: [await style()] });
    }
    const q = queryCandidates(i, lib);
    for (const slot of q.slots) {
      expect(slot.candidates.length).toBeGreaterThan(0);
      expect(slot.candidates.length).toBeLessThanOrEqual(3);
      expect(
        slot.candidates.every(
          (c) => c.kind === slot.kind && c.category === slot.category,
        ),
      ).toBe(true);
    }
    expect(
      q.slots.reduce((n, s) => n + s.candidates.length, 0),
    ).toBeLessThanOrEqual(12);
    expect(new Set(q.slots.map((s: any) => s.slotId)).size).toBe(
      q.slots.length,
    );
    expect(
      q.slots.find((s) => s.kind === "object" && s.key === key),
    ).toMatchObject({ groupId: key });
  },
);

test("explicit scaling without admitted uniform-scale is excluded before selection", async () => {
  const m = structuredClone(asset()),
    i = structuredClone(intent());
  m.object.scaleRange = [0.5, 1];
  m.object.scaleRangeEvidence = "docs/test.md";
  m.quality.operations = ["place"];
  m.quality.humanReview.operations = ["place"];
  i.features[0].constraints = [atom("scale", 0.5)];
  const q = queryCandidates(
    i,
    await library([m, asset("test-ground", "ground", "patch")]),
  );
  expect(q.slots.find((s) => s.kind === "object")!.candidates).toEqual([]);
  expect(q.rejected.some((r) => r.reason.includes("operation"))).toBe(true);
});
