import { Matrix4, Quaternion, Vector3 } from "three";
import type { AssetPrototype, GaussianBuffer } from "../gaussian/types";

/** Original procedural Gaussian assets. No capture, mesh, or species claim. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function plants(
  seed: number,
  kind: "grass" | "reed",
  coarse: boolean,
): GaussianBuffer {
  const count = coarse ? 1024 : 4096,
    data = new Float32Array(count * 14),
    rand = random(seed ^ 0x73a921);
  const side = new Vector3(),
    tangent = new Vector3(),
    normal = new Vector3(),
    q = new Quaternion(),
    basis = new Matrix4();
  let offset = 0;
  const put = (
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    r: number,
    g: number,
    b: number,
  ) => {
    data.set([x, y, z, sx, sy, sz, q.x, q.y, q.z, q.w, r, g, b, 0.96], offset);
    offset += 14;
  };
  const orient = (angle: number, dr: number, dy: number) => {
    side.set(-Math.sin(angle), 0, Math.cos(angle));
    tangent.set(dr * Math.cos(angle), dy, dr * Math.sin(angle)).normalize();
    normal.crossVectors(side, tangent).normalize();
    q.setFromRotationMatrix(basis.makeBasis(side, tangent, normal)).normalize();
  };
  const blade = (
    x: number,
    y: number,
    z: number,
    angle: number,
    height: number,
    bend: number,
    width: number,
    rows: number,
    shade: number,
  ) => {
    for (let j = 0; j < rows; j++) {
      const t = (j + 0.5) / rows,
        radius = bend * t * t,
        dy = height * (1 - 0.36 * t),
        dr = 2 * bend * t;
      orient(angle, dr, dy);
      const taper = Math.max(0.07, Math.sin(Math.PI * (0.04 + 0.96 * t)));
      for (const across of [-0.5, 0.5]) {
        const w = width * taper * across;
        const lit = shade * (0.85 + 0.15 * t);
        put(
          x + Math.cos(angle) * radius - Math.sin(angle) * w,
          y + height * (t - 0.18 * t * t),
          z + Math.sin(angle) * radius + Math.cos(angle) * w,
          Math.max(0.0007, width * taper * 0.48),
          (Math.hypot(dr, dy) / rows) * 0.7,
          0.0008,
          (0.027 + 0.01 * t) * lit,
          (0.07 + 0.024 * t) * lit,
          (0.009 + 0.006 * t) * lit,
        );
      }
    }
  };
  if (kind === "grass") {
    for (let i = 0; i < 64; i++) {
      const angle = i * 2.399963 + rand() * 0.5,
        radius = 0.065 * Math.sqrt(rand()),
        height = 0.18 + 0.24 * rand();
      blade(
        Math.cos(angle) * radius,
        0,
        Math.sin(angle) * radius,
        angle,
        height,
        0.065 + 0.14 * rand(),
        0.006 + 0.006 * rand(),
        coarse ? 8 : 32,
        0.75 + 0.5 * rand(),
      );
    }
  } else {
    for (let stem = 0; stem < 8; stem++) {
      const angle = stem * 2.399963 + rand() * 0.4,
        radius = 0.07 * Math.sqrt(rand()),
        x = Math.cos(angle) * radius,
        z = Math.sin(angle) * radius;
      const height = 0.5 + 0.23 * rand(),
        lean = 0.015 + 0.035 * rand(),
        shade = 0.8 + 0.4 * rand(),
        rows = coarse ? 8 : 32;
      // Four narrow Gaussian strips follow a gently leaning stem.
      for (let j = 0; j < rows; j++) {
        const t = (j + 0.5) / rows;
        for (let k = 0; k < 4; k++) {
          const a = (k * Math.PI) / 2;
          orient(a, 0, 1);
          put(
            x + Math.cos(angle) * lean * t * t + Math.cos(a) * 0.003,
            height * t,
            z + Math.sin(angle) * lean * t * t + Math.sin(a) * 0.003,
            0.003,
            (height / rows) * 0.7,
            0.001,
            0.065 * shade,
            0.112 * shade,
            0.024 * shade,
          );
        }
      }
      for (let leaf = 0; leaf < 4; leaf++) {
        const t = 0.15 + leaf * 0.17,
          leafAngle = angle + leaf * 2.4 + rand() * 0.35;
        blade(
          x + Math.cos(angle) * lean * t * t,
          height * t,
          z + Math.sin(angle) * lean * t * t,
          leafAngle,
          0.13 + 0.06 * rand(),
          0.11 + 0.09 * rand(),
          0.009 + 0.007 * rand(),
          coarse ? 10 : 40,
          shade,
        );
      }
      // Small straw-colored seed heads; they stay attached to the stems.
      const n = coarse ? 16 : 64;
      for (let j = 0; j < n; j++) {
        const t = (j + 0.5) / n,
          a = j * 2.399963,
          spread = 0.009 * Math.sin(Math.PI * t);
        orient(a, 0.01, 0.08);
        put(
          x + Math.cos(angle) * lean + Math.cos(a) * spread,
          height + 0.065 * t,
          z + Math.sin(angle) * lean + Math.sin(a) * spread,
          0.003,
          (0.065 / n) * 0.9 + 0.001,
          0.0017,
          0.16 * shade,
          0.12 * shade,
          0.047 * shade,
        );
      }
    }
  }
  if (offset !== data.length) throw Error("PCG plant buffer count mismatch");
  return { count, data };
}

/** Low, broken patches of blades; legacy grass/reed buffers stay versioned above. */
function lowGrass(seed: number, coarse: boolean): GaussianBuffer {
  const count = coarse ? 1024 : 4096,
    rows = coarse ? 8 : 32,
    data = new Float32Array(count * 14),
    rand = random(seed ^ 0x51a73b),
    wind = rand() * Math.PI * 2;
  const patches = Array.from({ length: 4 }, () => {
    const angle = rand() * Math.PI * 2,
      radius = 0.015 + 0.045 * rand();
    return {
      x: Math.cos(angle) * radius,
      z: Math.sin(angle) * radius,
      direction: wind + (rand() - 0.5) * 2.5,
      height: 0.65 + 0.35 * rand(),
    };
  });
  const tangent = new Vector3(),
    side = new Vector3(),
    normal = new Vector3(),
    q = new Quaternion(),
    basis = new Matrix4();
  let offset = 0;
  for (let i = 0; i < 64; i++) {
    // Unequal patch populations leave gaps instead of filling a radial rosette.
    const pick = rand(),
      patch = patches[pick < 0.48 ? 0 : pick < 0.76 ? 1 : pick < 0.92 ? 2 : 3],
      rootAngle = rand() * Math.PI * 2,
      rootRadius = 0.008 + 0.023 * Math.sqrt(rand()),
      x = patch.x + Math.cos(rootAngle) * rootRadius,
      z = patch.z + Math.sin(rootAngle) * rootRadius,
      angle = patch.direction + (rand() - 0.5) * 4.8,
      height = (0.028 + 0.075 * rand() ** 1.6) * patch.height,
      bend = 0.025 + 0.085 * rand(),
      arch = 1.15 + 1.5 * rand(),
      curl = (rand() - 0.5) * 1.4,
      width = 0.0012 + 0.002 * rand(),
      dry = rand() < 0.18,
      hue = rand(),
      shade = 0.75 + 0.5 * rand();
    const color = dry
      ? [0.105 + 0.035 * hue, 0.083 + 0.025 * hue, 0.035 + 0.015 * hue]
      : [0.036 + 0.025 * hue, 0.065 + 0.03 * hue, 0.017 + 0.018 * hue];
    for (let j = 0; j < rows; j++) {
      const t = (j + 0.5) / rows,
        a = angle + curl * t,
        radius = bend * t ** 1.5,
        dr = 1.5 * bend * Math.sqrt(t),
        dx = Math.cos(a) * dr - Math.sin(a) * radius * curl,
        dz = Math.sin(a) * dr + Math.cos(a) * radius * curl,
        dy = height * arch * Math.cos(arch * t),
        speed = Math.hypot(dx, dy, dz);
      tangent.set(dx, dy, dz).normalize();
      side.set(-dz, 0, dx).normalize();
      normal.crossVectors(side, tangent).normalize();
      q.setFromRotationMatrix(
        basis.makeBasis(side, tangent, normal),
      ).normalize();
      const taper = Math.max(0.025, (1 - t) ** 0.8),
        light = shade * (0.72 + 0.28 * t),
        tip = Math.max(0, (t - 0.78) / 0.22) * 0.25;
      for (const across of [-0.5, 0.5]) {
        const w = width * taper * across;
        data.set(
          [
            x + Math.cos(a) * radius + side.x * w,
            height * Math.sin(arch * t),
            z + Math.sin(a) * radius + side.z * w,
            Math.max(0.00012, width * taper * 0.4),
            (speed / rows) * 0.7,
            0.00025,
            q.x,
            q.y,
            q.z,
            q.w,
            (color[0] + tip * 0.05) * light,
            (color[1] + tip * 0.025) * light,
            (color[2] + tip * 0.008) * light,
            0.93,
          ],
          offset,
        );
        offset += 14;
      }
    }
  }
  return { count, data };
}

function stones(seed: number, coarse: boolean): GaussianBuffer {
  const count = coarse ? 1024 : 4096,
    data = new Float32Array(count * 14),
    q = new Quaternion(),
    n = new Vector3(),
    rand = random(seed ^ 0x9e3779b9);
  const phase = rand() * Math.PI * 2,
    parts = [
      { x: -0.075, z: 0, r: 0.17, h: 0.23, n: count / 2 },
      { x: 0.13, z: 0.055, r: 0.105, h: 0.135, n: count / 4 },
      { x: 0.065, z: -0.13, r: 0.082, h: 0.1, n: count / 4 },
    ];
  let index = 0;
  for (const p of parts)
    for (let j = 0; j < p.n; j++) {
      const ny = 1 - (2 * (j + 0.5)) / p.n,
        phi = j * Math.PI * (3 - Math.sqrt(5)),
        ring = Math.sqrt(1 - ny * ny),
        nx = ring * Math.cos(phi),
        nz = ring * Math.sin(phi);
      const shape =
        1 +
        0.1 * Math.sin(5 * phi + phase) * (1 - ny * ny) +
        0.055 * Math.sin(7 * ny + phase);
      const x = p.x + p.r * nx * shape,
        y = p.h * 0.5 * (ny + 1) * shape,
        z = p.z + p.r * 0.86 * nz * shape;
      n.set(nx / p.r, ny / (p.h * 0.5), nz / (p.r * 0.86)).normalize();
      q.setFromUnitVectors(new Vector3(0, 0, 1), n);
      const mottling =
        0.86 +
        0.12 * Math.sin(83 * x + 52 * z + phase) * Math.sin(67 * y - 39 * z) +
        0.035 * Math.sin(311 * x + 197 * y);
      const light =
          0.65 +
          0.35 * Math.max(0, n.dot(new Vector3(-0.4, 0.8, 0.45).normalize())),
        v = mottling * light;
      const size = 0.01 * Math.sqrt(4096 / count) * (p.r / 0.17);
      data.set(
        [
          x,
          y,
          z,
          size,
          size,
          0.003,
          q.x,
          q.y,
          q.z,
          q.w,
          0.23 * v,
          0.211 * v,
          0.178 * v,
          0.98,
        ],
        index++ * 14,
      );
    }
  return { count, data };
}

export function makeRiverProps(
  seed: number,
  kind: "grass" | "reed" | "low-grass",
): AssetPrototype[] {
  return [
    {
      id: "rock",
      synthetic: true,
      // Leave room for the footprint after alignment to an allowed 15° slope.
      radius: 0.32,
      anchor: [0, 0, 0],
      supportPoints: [
        [0, 0, 0],
        [-0.07, 0, 0],
        [0.13, 0, 0.055],
        [0.065, 0, -0.13],
      ],
      lods: { full: stones(seed, false), coarse: stones(seed, true) },
    },
    {
      id: "reed",
      synthetic: true,
      radius: 0.34,
      anchor: [0, 0, 0],
      supportPoints: [
        [0, 0, 0],
        [0.04, 0, 0],
        [-0.04, 0, 0],
        [0, 0, 0.04],
        [0, 0, -0.04],
      ],
      lods: {
        full:
          kind === "low-grass"
            ? lowGrass(seed, false)
            : plants(seed, kind, false),
        coarse:
          kind === "low-grass"
            ? lowGrass(seed, true)
            : plants(seed, kind, true),
      },
    },
  ];
}
