import { test, expect } from "vitest";
import { preparedSceneFixture } from "../../tests/support/prepared-scene";
import { BUILTIN_CONTEXT } from "../assets/catalog/context";
function storage() {
  const m = new Map<string, string>([
    ["wetland.assetPlans.v1", "existing v1 bytes"],
  ]);
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
  };
}
test("new records require an installed identical catalog and do not touch v1", async () => {
  const h = await import("./prepared-history"),
    f = await preparedSceneFixture(),
    s = storage();
  const r = await h.confirmPreparedAssetPlan(
    null,
    f.selection,
    f.ids,
    f.context,
  );
  expect(r.schemaVersion).toBe(2);
  expect(s.getItem(h.PREPARED_HISTORY_KEY)).toBe(null);
  expect(
    (await h.importPreparedAssetPlan(JSON.stringify(r), f.context)).recipe,
  ).toEqual(f.result.recipe);
  await expect(
    h.importPreparedAssetPlan(JSON.stringify(r), BUILTIN_CONTEXT),
  ).rejects.toThrow();
  await expect(
    h.importPreparedAssetPlan(JSON.stringify(r), {
      ...f.context,
      catalogVersion: "changed",
    }),
  ).rejects.toThrow();
  expect((await h.savePreparedHistory(s, [r])).error).toBe(null);
  expect((await h.loadPreparedHistory(s, f.context)).records).toHaveLength(1);
  expect(s.getItem("wetland.assetPlans.v1")).toBe("existing v1 bytes");
});
test("corrupt storage and quota failure preserve both prior keys", async () => {
  const h = await import("./prepared-history"),
    f = await preparedSceneFixture(),
    r = await h.confirmPreparedAssetPlan(null, f.selection, f.ids, f.context),
    s = storage();
  for (const corrupt of ["bad json", "[{}]"]) {
    s.setItem(h.PREPARED_HISTORY_KEY, corrupt);
    expect((await h.loadPreparedHistory(s, f.context)).error).toBeTruthy();
    expect((await h.savePreparedHistory(s, [r])).error).toBeTruthy();
    expect(s.getItem(h.PREPARED_HISTORY_KEY)).toBe(corrupt);
  }
  s.setItem(h.PREPARED_HISTORY_KEY, "[]");
  expect(
    (
      await h.savePreparedHistory(
        {
          ...s,
          setItem: () => {
            throw Error("quota");
          },
        },
        [r],
      )
    ).error,
  ).toContain("quota");
  expect(s.getItem(h.PREPARED_HISTORY_KEY)).toBe("[]");
  expect(s.getItem("wetland.assetPlans.v1")).toBe("existing v1 bytes");
});
