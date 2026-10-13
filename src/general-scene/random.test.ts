import { expect, test } from "vitest";
import { deriveSeed, randomSample, allocateSlot } from "./random";
import { parseEditableState } from "./contracts";
import { stateFixture } from "./test-fixtures";
test("FNV-1a length-prefixed UTF-8 streams have fixed independent vectors", () => {
  expect(deriveSeed(42, "grass:0", "placement", 0)).toBe(2385316644);
  expect(deriveSeed(42, "草:0", "placement", 0)).toBe(338065750);
  expect(deriveSeed(42, "grass:0", "placement", 1)).toBe(2402094263);
  expect(randomSample(42, "grass:0", "placement", 0)).toBe(
    2385316644 / 4294967296,
  );
  expect(deriveSeed(0, "ab", "c", 0)).not.toBe(deriveSeed(0, "a", "bc", 0));
});
test("invalid numeric seed/attempt cannot alias a valid uint32", () => {
  expect(() => deriveSeed(-1, "grass", "place", 0)).toThrow();
  expect(() => deriveSeed(2 ** 32, "grass", "place", 0)).toThrow();
  expect(() => deriveSeed(1, "grass", "place", 0.5)).toThrow();
});
test("persistent slots never reuse tombstones after reopen", () => {
  const deletedId = "grass:0",
    raw = stateFixture();
  raw.tombstones = [deletedId];
  const reopened = parseEditableState(JSON.parse(JSON.stringify(raw))),
    next = allocateSlot(reopened, "grass");
  expect(next.instanceId).toBe("grass:1");
  expect(next.instanceId).not.toBe(deletedId);
  expect(allocateSlot(next.state, "grass").instanceId).toBe("grass:2");
  expect(reopened.groups[0].nextSlot).toBe(1);
  expect(next.state.tombstones).toEqual([deletedId]);
});
test("group IDs cannot collide with delimiters, retire, or overflow", () => {
  const s = stateFixture();
  s.groups = [{ groupId: "a:b", nextSlot: 0, retired: false }];
  expect(allocateSlot(parseEditableState(s), "a:b").instanceId).toBe("a%3Ab:0");
  s.groups[0].retired = true;
  expect(() => allocateSlot(parseEditableState(s), "a:b")).toThrow();
  s.groups[0].retired = false;
  s.groups[0].nextSlot = Number.MAX_SAFE_INTEGER;
  expect(() => allocateSlot(parseEditableState(s), "a:b")).toThrow();
});

test.each([
  "草".repeat(23),
  "a".repeat(199),
  "a".repeat(200),
  "草".repeat(200),
  "🌿".repeat(100),
])(
  "allocated expanded identity survives the entire persisted lifecycle (%#)",
  async (groupId) => {
    const { parseSnapshot, parsePatch } = await import("./contracts.ts");
    const { snapshotFixture, patchFixture, regionFixture } =
      await import("./test-fixtures.ts");
    for (const start of [0, Number.MAX_SAFE_INTEGER - 1]) {
      const s = snapshotFixture();
      s.plan.groups[0].groupId = groupId;
      s.plan.relations[0].groupId = groupId;
      s.state.groups = [{ groupId, nextSlot: start, retired: false }];
      const allocated = allocateSlot(parseEditableState(s.state), groupId),
        instanceId = allocated.instanceId;
      expect(instanceId).toBe(`${encodeURIComponent(groupId)}:${start}`);
      s.state = structuredClone(allocated.state);
      s.instances[0].groupId = groupId;
      s.instances[0].instanceId = instanceId;
      s.instances[0].locked = true;
      s.state.lockedInstanceIds = [instanceId];
      s.state.overrides = [
        {
          instanceId,
          groupId,
          kind: "move",
          assetRef: s.instances[0].assetRef,
          transform: s.instances[0].transform,
        },
      ];
      s.state.affectedRegions = [
        {
          requestedRegion: regionFixture(),
          effectiveRegion: regionFixture(),
          tileIds: ["tile:0:0"],
          instanceIds: [instanceId],
        },
      ];
      s.validation.rejections[0].groupId = groupId;
      s.validation.rejections[0].instanceId = instanceId;
      expect(parseSnapshot(s).instances[0].instanceId).toBe(instanceId);
      const patch = patchFixture();
      patch.targetInstanceIds = [instanceId];
      patch.affectedInstanceIds = [instanceId];
      patch.operations = [{ kind: "remove", instanceId }];
      expect(parsePatch(patch).targetInstanceIds).toEqual([instanceId]);
      patch.affectedInstanceIds = [];
      patch.lockedInstanceIds = [instanceId];
      patch.operations = [{ kind: "set-count", groupId, count: 2 }];
      expect(parsePatch(patch).lockedInstanceIds).toEqual([instanceId]);
      s.instances = [];
      s.state.lockedInstanceIds = [];
      s.state.tombstones = [instanceId];
      s.state.overrides = [
        {
          instanceId,
          groupId,
          kind: "remove",
          assetRef: null,
          transform: null,
        },
      ];
      s.validation.accepted = 0;
      s.validation.shortfall = 2;
      s.validation.usage.instances = 0;
      s.validation.usage.worstSplats = 1;
      const removed = parseSnapshot(s);
      expect(removed.capability).toBe("editable");
      const reopened = parseEditableState(
        JSON.parse(JSON.stringify(removed.state)),
      );
      expect(reopened.tombstones).toEqual([instanceId]);
      if (start === 0)
        expect(allocateSlot(reopened, groupId).instanceId).toBe(
          `${encodeURIComponent(groupId)}:1`,
        );
      else expect(() => allocateSlot(reopened, groupId)).toThrow(/exhausted/);
    }
  },
);

test.each([
  "%67rass:0",
  "grass:00",
  "grass:-1",
  "grass:9007199254740992",
  "%FF:0",
])("rejects noncanonical instance identity %s", async (instanceId) => {
  const { parsePatch } = await import("./contracts.ts"),
    { patchFixture } = await import("./test-fixtures.ts"),
    p = patchFixture();
  p.targetInstanceIds = [instanceId];
  p.affectedInstanceIds = [instanceId];
  p.operations = [{ kind: "remove", instanceId }];
  expect(() => parsePatch(p)).toThrow();
});
