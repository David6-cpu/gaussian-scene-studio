import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as ground from "./splat";
const clean = ground.removeLargeGroundSplats;
test("ground cleanup removes only over-limit scales and preserves full retained records and source", () => {
  const record = (x: number, sigma: number, alpha: number) => [
    x,
    0,
    0,
    sigma,
    0.01,
    0.02,
    0,
    0,
    0,
    1,
    0.2,
    0.3,
    0.4,
    alpha,
  ];
  const b = {
      count: 3,
      data: new Float32Array([
        ...record(-1, 0.0625, 0),
        ...record(0, 0.125, 1),
        ...record(1, 0.04, 0.5),
      ]),
    },
    before = b.data.slice();
  const c = clean(b, 0.0625);
  expect(c.removedIndices).toEqual([1]);
  expect(c.buffer.count).toBe(2);
  expect([...c.buffer.data]).toEqual([
    ...before.slice(0, 14),
    ...before.slice(28),
  ]);
  expect(b.data).toEqual(before);
  expect(() => clean(b, 0)).toThrow(/threshold/);
});
test("one Rock cleanup candidate exactly matches offline removed indices without refitting coordinates", () => {
  const bytes = readFileSync("public/diagnostics/loopce-rock/rock-patch.splat"),
    meta = JSON.parse(
      readFileSync("public/diagnostics/loopce-rock/cleanup-meta.json", "utf8"),
    ),
    base = ground.orientGround(ground.decodeSplat(bytes), [1, 0, 0, 0]).buffer,
    c = clean(base, 0.08);
  expect(c.removedIndices).toEqual(meta.removedIndices);
  expect(c.buffer.count).toBe(197205);
  const removed = new Set<number>(c.removedIndices),
    retained = [];
  let next = 0;
  for (let i = 0; i < base.count; i++)
    if (!removed.has(i)) {
      retained.push(bytes.subarray(i * 32, (i + 1) * 32));
      expect(
        Buffer.from(c.buffer.data.buffer, next * 56, 56).equals(
          Buffer.from(base.data.buffer, i * 56, 56),
        ),
      ).toBe(true);
      next++;
    }
  expect(
    createHash("sha256").update(Buffer.concat(retained)).digest("hex"),
  ).toBe(meta.candidateSha256);
});
