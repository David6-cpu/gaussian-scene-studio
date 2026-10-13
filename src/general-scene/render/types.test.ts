import { expect, test } from "vitest";
import { Quaternion, Vector3 } from "three";
import { worldPoint, sourcePlacement } from "./types";
import type { Transform, Vec3 } from "../core";
const placement: Transform = {
  position: [7, 2, -4],
  quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
  scale: 3,
};
const close = (a: Vec3, b: Vec3) =>
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 10));
test("nonzero landing anchor maps exactly to placement position", () => {
  expect(worldPoint([1, 0, 0], [1, 0, 0], placement)).toEqual(
    placement.position,
  );
  close(worldPoint([2, 0, 0], [1, 0, 0], placement), [7, 2, -7]);
});
test.each([{ anchor: [1, 0.2, -0.3] as Vec3 }, { anchor: [0, 0, 0] as Vec3 }])(
  "raw normalization and canonical support agree including anchorBaked origin %j",
  ({ anchor }) => {
    const normalization: Transform = {
      position: [2, -1, 3],
      quaternion: [Math.sin(0.3), 0, 0, Math.cos(0.3)],
      scale: 1.7,
    };
    const composed = sourcePlacement(anchor, normalization, placement);
    const raw: Vec3 = [0.4, 0.7, -0.2];
    const canonical = new Vector3(...raw)
      .multiplyScalar(normalization.scale)
      .applyQuaternion(new Quaternion(...normalization.quaternion))
      .add(new Vector3(...normalization.position))
      .toArray() as [number, number, number];
    close(
      worldPoint(raw, composed.anchor, composed.transform),
      worldPoint(canonical, anchor, placement),
    );
    close(
      worldPoint(composed.anchor, composed.anchor, composed.transform),
      placement.position,
    );
  },
);
