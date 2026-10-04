import { Quaternion, Vector3, Matrix4 } from "three";
import type { AssetPrototype, GaussianBuffer } from "../gaussian/types";
function makeLevel(kind: "rock" | "reed", count: number): GaussianBuffer {
  const data = new Float32Array(count * 14),
    q = new Quaternion(),
    normal = new Vector3(),
    up = new Vector3(0, 0, 1);
  for (let i = 0; i < count; i++) {
    let leafBasis: Matrix4 | undefined;
    let x = 0,
      y = 0,
      z = 0,
      sx = 0.01,
      sy = 0.01,
      sz = 0.004,
      r = 0.15,
      g = 0.18,
      b = 0.12;
    if (kind === "rock") {
      const ny = 1 - (2 * (i + 0.5)) / count,
        phi = i * Math.PI * (3 - Math.sqrt(5)),
        ring = Math.sqrt(1 - ny * ny),
        nx = ring * Math.cos(phi),
        nz = ring * Math.sin(phi);
      x = 0.3 * nx;
      y = 0.15 * (ny + 1);
      z = 0.22 * nz;
      normal.set(nx / 0.3, ny / 0.15, nz / 0.22).normalize();
      sx = sy = 0.017 * Math.sqrt(4096 / count);
      sz = 0.006;
      const shade = 0.16 + 0.055 * (ny + 1);
      r = shade;
      g = shade * 0.94;
      b = shade * 0.8;
    } else if (i < count / 4) {
      const n = count / 4,
        perStem = n / 4,
        stem = Math.floor(i / perStem),
        j = i % perStem,
        rows = perStem / 8,
        theta = (2 * Math.PI * (j % 8)) / 8,
        t = (Math.floor(j / 8) + 0.5) / rows,
        angle = (stem * Math.PI) / 2;
      x = 0.035 * Math.cos(angle) + 0.012 * Math.cos(theta);
      y = 0.95 * t;
      z = 0.035 * Math.sin(angle) + 0.012 * Math.sin(theta);
      normal.set(Math.cos(theta), 0, Math.sin(theta));
      sx = 0.01;
      sy = (0.95 / rows) * 0.7;
      sz = 0.004;
      r = 0.08;
      g = 0.23;
      b = 0.028;
    } else {
      const perLeaf = count / 16,
        n = Math.sqrt(perLeaf),
        j = i - count / 4,
        leaf = Math.floor(j / perLeaf),
        k = j % perLeaf,
        t = (Math.floor(k / n) + 0.5) / n,
        w = (((k % n) + 0.5) / n - 0.5) * 2,
        angle = (leaf * Math.PI * 2) / 12;
      const radius = 0.035 + 0.155 * Math.sin(t * Math.PI * 0.8),
        width = 0.022 * Math.sin(t * Math.PI) * w;
      x = radius * Math.cos(angle) - width * Math.sin(angle);
      z = radius * Math.sin(angle) + width * Math.cos(angle);
      y = 0.18 + (leaf % 3) * 0.22 + 0.26 * t + 0.07 * Math.sin(Math.PI * t);
      const dr = 0.155 * Math.PI * 0.8 * Math.cos(t * Math.PI * 0.8),
        dy = 0.26 + 0.07 * Math.PI * Math.cos(t * Math.PI);
      normal.set(-dy * Math.cos(angle), dr, -dy * Math.sin(angle)).normalize();
      leafBasis = new Matrix4().makeBasis(
        new Vector3(-Math.sin(angle), 0, Math.cos(angle)),
        new Vector3(dr * Math.cos(angle), dy, dr * Math.sin(angle)).normalize(),
        normal,
      );
      sx = (0.04 / n) * 0.8;
      sy = (0.37 / n) * 0.8;
      sz = 0.0025;
      r = 0.06 + 0.025 * t;
      g = 0.24 + 0.1 * t;
      b = 0.025;
    }
    if (leafBasis) q.setFromRotationMatrix(leafBasis).normalize();
    else q.setFromUnitVectors(up, normal).normalize();
    data.set([x, y, z, sx, sy, sz, q.x, q.y, q.z, q.w, r, g, b, 0.95], i * 14);
  }
  return { count, data };
}
export function makeSyntheticAssets(): AssetPrototype[] {
  return (["rock", "reed"] as const).map((id) => ({
    id,
    synthetic: true,
    radius: id === "rock" ? 0.3 : 0.2,
    anchor: [0, 0, 0],
    supportPoints:
      id === "rock"
        ? [
            [0, 0, 0],
            [0.12, 0.0125, 0],
            [-0.12, 0.0125, 0],
            [0, 0.013, 0.09],
            [0, 0.013, -0.09],
          ]
        : [
            [0, 0, 0],
            [0.04, 0, 0],
            [-0.04, 0, 0],
            [0, 0, 0.04],
            [0, 0, -0.04],
          ],
    lods: { full: makeLevel(id, 4096), coarse: makeLevel(id, 1024) },
  }));
}
