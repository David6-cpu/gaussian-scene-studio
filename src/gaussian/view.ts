import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  ExtSplats,
  PackedSplats,
  SplatMesh,
  SparkRenderer,
} from "@sparkjsdev/spark";
import type {
  GaussianView,
  GaussianBuffer,
  BuiltScene,
  Vec3,
  AssetPrototype,
  Instance,
  RiversideGround,
} from "./types";
import {
  loadRiversideArrays,
  validateRiversideArrays,
} from "../assets/riverside";
import { RIVERSIDE_BYTES } from "../terrain/riverside";
import {
  assertGaussianBuffer,
  assertSceneBudget,
  sourceBuffers,
} from "./validate";
import { chooseLod } from "../assets/lod";
import {
  deferredSparkDisposal,
  releaseGeneratorMaterial,
} from "./spark-lifecycle";
type Entry = {
  mesh: SplatMesh;
  buffer: GaussianBuffer | RiversideGround;
  assetId?: string;
  lod?: Instance["lod"];
};
// A replacement renderer on the same canvas shares its WebGL context. Wait
// for the old sort and renderer cleanup before creating new GL state caches.
const pendingDisposals = new WeakMap<HTMLCanvasElement, Promise<void>>();
// Spark 2.3.1 dispose owns packedSplats: detach borrowed sources first.
function disposeBorrower(mesh: SplatMesh) {
  mesh.removeFromParent();
  releaseGeneratorMaterial(mesh);
  mesh.splats = undefined;
  mesh.packedSplats = undefined;
  mesh.extSplats = undefined;
  mesh.dispose();
}
function release(
  meshes: Map<string, Entry>,
  bank: Map<GaussianBuffer, PackedSplats>,
  ground?: ExtSplats,
) {
  for (const { mesh } of meshes.values()) disposeBorrower(mesh);
  meshes.clear();
  for (const p of bank.values()) p.dispose();
  bank.clear();
  ground?.dispose();
}
export async function createGaussianView(
  canvas: HTMLCanvasElement,
): Promise<GaussianView> {
  const previous = pendingDisposals.get(canvas);
  if (previous) {
    await previous;
    if (pendingDisposals.get(canvas) === previous)
      pendingDisposals.delete(canvas);
  }
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: "high-performance",
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0, 0, 0);
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.05, 150);
  camera.position.set(0, 0, 8);
  const controls = new OrbitControls(camera, canvas);
  controls.enabled = false;
  controls.enableDamping = false;
  controls.minDistance = 0.5;
  controls.maxDistance = 90;
  controls.maxPolarAngle = Math.PI * 0.49;
  const spark = new SparkRenderer({ renderer, enableLod: false });
  const disposeSpark = deferredSparkDisposal(spark, () => renderer.dispose());
  scene.add(spark);
  let bank = new Map<GaussianBuffer, PackedSplats>(),
    meshes = new Map<string, Entry>(),
    prototypes = new Map<string, AssetPrototype>();
  let ground: { descriptor: RiversideGround; source: ExtSplats } | undefined;
  let sourceLoad: AbortController | undefined;
  let lodEnabled = false,
    viewportHeight = 720,
    disposed = false,
    generation = 0,
    guard: ((p: Vec3) => Vec3) | null = null;
  const gl = renderer.getContext(),
    ext = gl.getExtension("WEBGL_debug_renderer_info");
  const gpuRenderer = ext
    ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
    : null;
  const gpu = {
    renderer: gpuRenderer,
    software: gpuRenderer
      ? /SwiftShader|Software|llvmpipe|lavapipe/i.test(gpuRenderer)
        ? true
        : /Apple|NVIDIA|AMD|Intel|Adreno|Mali/i.test(gpuRenderer)
          ? false
          : null
      : null,
  };
  const extents = new Map<string, number>();
  return {
    async setScene(input: BuiltScene) {
      if (disposed) throw new Error("Renderer disposed");
      const ticket = ++generation;
      sourceLoad?.abort();
      const load = new AbortController();
      sourceLoad = load;
      assertSceneBudget(input);
      for (const b of sourceBuffers(input)) assertGaussianBuffer(b);
      const nextBank = new Map<GaussianBuffer, PackedSplats>(),
        nextMeshes = new Map<string, Entry>();
      let nextGround: typeof ground;
      try {
        const p = new THREE.Vector3(),
          s = new THREE.Vector3(),
          q = new THREE.Quaternion(),
          c = new THREE.Color();
        for (const b of sourceBuffers(input)) {
          const packed = new PackedSplats({ maxSplats: b.count });
          nextBank.set(b, packed);
          await packed.initialized;
          if (ticket !== generation || disposed) {
            release(nextMeshes, nextBank);
            return;
          }
          for (let i = 0; i < b.data.length; i += 14) {
            const d = b.data;
            p.fromArray(d, i);
            s.fromArray(d, i + 3);
            q.fromArray(d, i + 6);
            c.setRGB(d[i + 10], d[i + 11], d[i + 12]).convertLinearToSRGB();
            packed.pushSplat(p, s, q, d[i + 13], c);
          }
          packed.needsUpdate = true;
        }
        const add = (id: string, b: GaussianBuffer, instance?: Instance) => {
          if (!b.count) return;
          const mesh = new SplatMesh({
            packedSplats: nextBank.get(b)!,
            enableLod: false,
            editable: false,
            raycastable: false,
          });
          if (instance) {
            mesh.position.fromArray(instance.position);
            mesh.quaternion.fromArray(instance.rotation);
            mesh.scale.setScalar(instance.scale);
          }
          nextMeshes.set(id, {
            mesh,
            buffer: b,
            assetId: instance?.assetId,
            lod: instance?.lod,
          });
        };
        if (input.ground) {
          const descriptor = input.ground;
          const arrays =
            descriptor.arrays ?? (await loadRiversideArrays(load.signal));
          await validateRiversideArrays(arrays);
          if (ticket !== generation || disposed) {
            release(nextMeshes, nextBank);
            return;
          }
          descriptor.arrays = arrays;
          const source = new ExtSplats({
            numSplats: descriptor.count,
            extArrays: [arrays.ext0, arrays.ext1],
            extra: {
              sh1: arrays.sh1,
              sh2: arrays.sh2,
              sh3a: arrays.sh3a,
              sh3b: arrays.sh3b,
            },
          });
          nextGround = { descriptor, source };
          await source.initialized;
          if (source.getNumSh() !== 3)
            throw new Error("Riverside SH3载入不完整");
          const mesh = new SplatMesh({
            extSplats: source,
            enableLod: false,
            editable: false,
            raycastable: false,
          });
          nextMeshes.set("$ground", { mesh, buffer: descriptor });
          await mesh.initialized;
          mesh.position.fromArray(descriptor.position);
          mesh.quaternion.fromArray(descriptor.rotation);
          mesh.scale.setScalar(descriptor.scale);
        }
        add("$terrain", input.terrain);
        if (input.water) add("$water", input.water);
        for (const i of input.instances) {
          const a = input.assets.find((a) => a.id === i.assetId)!;
          add(i.id, a.lods[i.lod], i);
        }
        if (ticket !== generation || disposed) {
          release(nextMeshes, nextBank, nextGround?.source);
          return;
        }
        release(meshes, bank, ground?.source);
        ground = nextGround;
        bank = nextBank;
        meshes = nextMeshes;
        prototypes = new Map(input.assets.map((a) => [a.id, a]));
        extents.clear();
        for (const a of input.assets) {
          let extent = 0;
          const d = a.lods.full.data;
          for (let i = 0; i < d.length; i += 14)
            extent = Math.max(
              extent,
              Math.hypot(d[i], d[i + 1], d[i + 2]) +
                3 * Math.max(d[i + 3], d[i + 4], d[i + 5]),
            );
          extents.set(a.id, extent);
        }
        for (const e of meshes.values()) scene.add(e.mesh);
      } catch (e) {
        release(nextMeshes, nextBank, nextGround?.source);
        throw e;
      }
    },
    cancelPendingScene() {
      generation++;
      sourceLoad?.abort();
    },
    removeInstance(id) {
      const entry = meshes.get(id);
      if (!entry) return;
      disposeBorrower(entry.mesh);
      meshes.delete(id);
      if (
        entry.assetId &&
        ![...meshes.values()].some((m) => m.assetId === entry.assetId)
      )
        prototypes.delete(entry.assetId);
      const needed = new Set(
        [...prototypes.values()].flatMap((a) => [a.lods.full, a.lods.coarse]),
      );
      for (const m of meshes.values())
        if ("data" in m.buffer) needed.add(m.buffer);
      for (const [b, p] of bank)
        if (!needed.has(b)) {
          p.dispose();
          bank.delete(b);
        }
    },
    clearScene() {
      generation++;
      sourceLoad?.abort();
      release(meshes, bank, ground?.source);
      ground = undefined;
      prototypes.clear();
      extents.clear();
      guard = null;
    },
    isCurrentSceneDisplayed() {
      const mapping = spark.display.mapping;
      return (
        mapping.length === meshes.size &&
        [...meshes.values()].every(({ mesh, buffer }) =>
          mapping.some((m) => m.node === mesh && m.count === buffer.count),
        )
      );
    },
    setLodEnabled(enabled) {
      lodEnabled = enabled;
    },
    setInteractive(enabled) {
      controls.enabled = enabled;
    },
    setCameraGuard(next) {
      guard = next;
    },
    setBackground(hex) {
      scene.background = new THREE.Color(hex);
    },
    setCamera(position, target) {
      camera.position.fromArray(guard ? guard(position) : position);
      controls.target.fromArray(target);
      camera.lookAt(controls.target);
      camera.updateMatrixWorld();
    },
    getCamera() {
      return {
        position: camera.position.toArray() as [number, number, number],
        target: controls.target.toArray() as [number, number, number],
      };
    },
    gpuInfo() {
      return { ...gpu };
    },
    resize(w, h, dpr) {
      viewportHeight = h * dpr;
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    },
    render() {
      if (disposed) return;
      if (controls.enabled) controls.update();
      if (guard)
        camera.position.fromArray(
          guard(camera.position.toArray() as [number, number, number]),
        );
      for (const entry of meshes.values())
        if (entry.assetId) {
          const asset = prototypes.get(entry.assetId)!,
            distance = Math.max(
              0.1,
              camera.position.distanceTo(entry.mesh.position),
            ),
            px =
              (2 *
                (extents.get(entry.assetId) ?? asset.radius) *
                entry.mesh.scale.x *
                viewportHeight) /
              (2 * Math.tan((camera.fov * Math.PI) / 360) * distance),
            lod = lodEnabled ? chooseLod(px, entry.lod ?? "full") : "full";
          if (lod !== entry.lod) {
            releaseGeneratorMaterial(entry.mesh);
            const b = asset.lods[lod],
              packed = bank.get(b)!;
            entry.mesh.packedSplats = packed;
            entry.mesh.splats = packed;
            entry.mesh.numSplats = b.count;
            entry.mesh.updateGenerator();
            entry.buffer = b;
            entry.lod = lod;
          }
        }
      renderer.render(scene, camera);
    },
    stats() {
      return {
        sourceBuffers: bank.size + (ground ? 1 : 0),
        instanceCount: [...meshes.values()].filter((m) => m.assetId).length,
        uniqueSourceSplats:
          [...bank.keys()].reduce((s, b) => s + b.count, 0) +
          (ground?.descriptor.count ?? 0),
        activeSplats: [...meshes.values()].reduce(
          (s, m) => s + m.buffer.count,
          0,
        ),
        ownedBytes:
          [...bank].reduce(
            (s, [b, p]) =>
              s + b.data.byteLength + (p.packedArray?.byteLength ?? 0),
            0,
          ) + (ground ? RIVERSIDE_BYTES : 0),
        ...(ground
          ? {
              ground: {
                id: ground.descriptor.id,
                count: ground.source.numSplats,
                shBands: ground.source.getNumSh(),
              },
            }
          : {}),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      sourceLoad?.abort();
      release(meshes, bank, ground?.source);
      ground = undefined;
      prototypes.clear();
      extents.clear();
      guard = null;
      controls.dispose();
      pendingDisposals.set(canvas, disposeSpark());
    },
  };
}
