import { expect, test } from "vitest";
import { Quaternion, Vector3 } from "three";
import * as ground from "./splat";
import type { GaussianBuffer } from "../gaussian/types";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const orient = ground.orientGround;
function patch(): GaussianBuffer {
  return {
    count: 4,
    data: new Float32Array(
      [
        [-2, 0, -1],
        [2, 0, -1],
        [-2, 0, 1],
        [2, 0, 1],
      ].flatMap((p) => [
        ...p,
        0.02,
        0.01,
        0.005,
        0,
        0,
        0,
        1,
        0.2,
        0.3,
        0.4,
        0.8,
      ]),
    ),
  };
}
test("flat ground is fitted by horizontal extent without dividing by zero height", () => {
  const source = patch(),
    before = source.data.slice(),
    next = orient(source, [0, 0, 0, 1]);
  expect(next.scale).toBe(0.25);
  expect([...next.buffer.data.slice(0, 3)]).toEqual([-0.5, 0, -0.25]);
  expect(next.buffer.data[3]).toBeCloseTo(0.005);
  expect(next.buffer.data[5]).toBeCloseTo(0.00125);
  expect(source.data).toEqual(before);
  for (let i = 0; i < source.count; i++)
    expect(next.buffer.data.slice(i * 14 + 10, i * 14 + 14)).toEqual(
      source.data.slice(i * 14 + 10, i * 14 + 14),
    );
});
test("rigid ground rotation transforms positions and anisotropic covariance axes consistently", () => {
  const source = patch(),
    r = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI);
  const local = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.3);
  local.toArray(source.data, 6);
  source.data[1] = -1;
  const next = orient(source, r.toArray());
  expect(next.buffer.data[1]).toBeCloseTo(0.25);
  expect(next.buffer.data[2]).toBeCloseTo(0.25);
  const actual = new Quaternion().fromArray(next.buffer.data, 6);
  for (const axis of [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]) {
    const expected = new Vector3(...axis)
      .applyQuaternion(local)
      .applyQuaternion(r);
    expect(
      new Vector3(...axis).applyQuaternion(actual).distanceTo(expected),
    ).toBeLessThan(1e-6);
  }
});
test("ground transform rejects invalid rotation and a collapsed footprint", () => {
  expect(() => orient(patch(), [0, 0, 0, 2])).toThrow(/rotation/);
  const p = patch();
  for (let i = 0; i < p.data.length; i += 14) {
    p.data[i] = 0;
    p.data[i + 2] = 0;
  }
  expect(() => orient(p, [0, 0, 0, 1])).toThrow(/extent/);
});
test("the attributed local Rock crop retains its pinned records and fits without flattening", () => {
  const bytes = readFileSync("public/diagnostics/loopce-rock/rock-patch.splat");
  const meta = JSON.parse(
    readFileSync("public/diagnostics/loopce-rock/source-meta.json", "utf8"),
  );
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(meta.sha256);
  const b = ground.decodeSplat(bytes),
    result = ground.orientGround(b, [1, 0, 0, 0]);
  expect(b.count).toBe(197251);
  expect(b.count).toBe(meta.coreCount + meta.marginCount);
  expect(result.scale).toBeCloseTo(0.6345178724708489, 10);
  let min = Infinity,
    max = -Infinity;
  for (let i = 0; i < result.buffer.data.length; i += 14) {
    min = Math.min(min, result.buffer.data[i + 1]);
    max = Math.max(max, result.buffer.data[i + 1]);
  }
  expect(max - min).toBeGreaterThan(0.45);
});
