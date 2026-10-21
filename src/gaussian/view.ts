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
  SceneSwap,
} from "./types";
import {
  loadRiversideArrays,
  validateRiversideArrays,
} from "../assets/riverside";
import {
  parsePreparedDefinition,
  validatePreparedArrays,
  type PreparedGroundAsset,
} from "../io/prepared-ground";
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
import {
  SPARK_BUDGET_OPTIONS,
  sparkRendererBudget,
  sparkSceneCapacity,
} from "./spark-budget";
import type { Residency } from "../general-scene/controller";
type Entry = {
  mesh: SplatMesh;
  buffer: GaussianBuffer | NonNullable<BuiltScene["ground"]>;
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
  options: {
    loadPreparedGround?: (
      ref: { id: string; contentVersion: string },
      signal: AbortSignal,
    ) => Promise<PreparedGroundAsset>;
  } = {},
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
  // These equal Spark 2.3.1's previous defaults with enableLod:false.
  const spark = new SparkRenderer({ renderer, ...SPARK_BUDGET_OPTIONS });
  const disposeSpark = deferredSparkDisposal(spark, () => renderer.dispose());
  scene.add(spark);
  let bank = new Map<GaussianBuffer, PackedSplats>(),
    meshes = new Map<string, Entry>(),
    prototypes = new Map<string, AssetPrototype>();
  let ground:
    | { descriptor: NonNullable<BuiltScene["ground"]>; source: ExtSplats }
    | undefined;
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
  let extents = new Map<string, number>();
  let pending: SceneSwap | undefined;
  type Owner = {
    input?: BuiltScene;
    loadingArrays?: import("./types").GroundArrays;
    sources: Map<GaussianBuffer, PackedSplats>;
    ground?: NonNullable<typeof ground>;
    prototypes: Map<string, AssetPrototype>;
    initializers: number;
    preparing: boolean;
    released: boolean;
    cleanupFailed: boolean;
  };
  const owners = new Map<Map<GaussianBuffer, PackedSplats>, Owner>();
  let preparing = 0,
    rendererDisposed = false,
    rendererReleased = false,
    retainedCapacity = 0,
    releaseFailed = false;
  let releaseError: unknown;
  let resolveReleased!: () => void, rejectReleased!: (e: unknown) => void;
  const released = new Promise<void>((resolve, reject) => {
    resolveReleased = resolve;
    rejectReleased = reject;
  });
  // dispose keeps its existing void signature; observers can attach later.
  void released.catch(() => {});
  let quiet:
    | { promise: Promise<void>; resolve(): void; reject(e: unknown): void }
    | undefined;
  const failRelease = (error: unknown, owner?: Owner) => {
    if (owner) owner.cleanupFailed = true;
    if (!releaseFailed) {
      releaseFailed = true;
      releaseError = error;
      rejectReleased(error);
    }
    quiet?.reject(releaseError);
    quiet = undefined;
  };
  const preparationBusy = () =>
    preparing > 0 || [...owners.values()].some((o) => o.initializers > 0);
  const busy = () =>
    releaseFailed ||
    preparationBusy() ||
    disposeSpark.activity().busy ||
    (disposed && !rendererReleased);
  const finish = () => {
    if (releaseFailed) return;
    try {
      if (rendererDisposed && !rendererReleased && !preparationBusy()) {
        // Spark dispose frees GL objects but retains CPU readback, mappings and
        // uniforms. Drop these closed-only references after sort AND initialization.
        spark.readback32 = new Uint32Array(0);
        for (const a of new Set([
          spark.display,
          spark.current,
          ...spark.accumulators,
        ])) {
          a.mapping = [];
          a.readback = null;
          a.readbackSplats = [];
        }
        for (const uniform of [
          spark.uniforms.ordering,
          spark.uniforms.extSplats,
          spark.uniforms.extSplats2,
        ])
          (uniform as { value: THREE.Texture | null }).value = null;
        rendererReleased = true;
        resolveReleased();
      }
      if (!busy()) {
        const waiting = quiet;
        quiet = undefined;
        waiting?.resolve();
      }
    } catch (error) {
      failRelease(error);
    }
  };
  const finishOwner = (owner: Owner) => {
    if (
      !owner.released ||
      owner.cleanupFailed ||
      owner.preparing ||
      owner.initializers
    )
      return;
    owner.input = undefined;
    owner.loadingArrays = undefined;
    owner.sources.clear();
    owner.ground = undefined;
    owner.prototypes.clear();
    for (const [key, value] of owners) if (value === owner) owners.delete(key);
  };
  const releaseFrame = (
    entries: Map<string, Entry>,
    sources: Map<GaussianBuffer, PackedSplats>,
    g?: ExtSplats,
  ) => {
    const owner = owners.get(sources);
    if (owner) owner.released = true;
    try {
      release(entries, sources, g);
      if (owner) {
        owner.prototypes.clear();
        finishOwner(owner);
      }
    } catch (error) {
      failRelease(error, owner);
      throw error;
    }
  };
  const initialize = (
    owner: Owner,
    work: Promise<unknown>,
    cleanup: () => void,
  ) => {
    owner.initializers++;
    const tracked = work.finally(() => {
      try {
        if (owner.released) cleanup();
      } catch (error) {
        failRelease(error, owner);
        throw error;
      } finally {
        // A cleanup failure is terminal too; retain its owner, not a phantom
        // pending initializer. Every later waiter observes the same failure.
        owner.initializers--;
        finishOwner(owner);
        finish();
      }
    });
    // Promise.all may reject before another initializer reaches its terminal state.
    void tracked.catch(() => {});
    return tracked;
  };
  const residency = (): Residency => {
    const buffers = new Set<ArrayBuffer>(),
      rendererBuffers = new Set<ArrayBuffer>();
    const add = (array: unknown, target = buffers) => {
      if (
        ArrayBuffer.isView(array) &&
        array.buffer instanceof ArrayBuffer &&
        array.buffer.byteLength
      )
        target.add(array.buffer);
    };
    let sourceExtraBytes = 0;
    for (const owner of owners.values()) {
      if (owner.input) {
        add(owner.input.terrain.data);
        if (owner.input.water) add(owner.input.water.data);
        for (const a of owner.input.assets) {
          add(a.lods.full.data);
          add(a.lods.coarse.data);
        }
        if (owner.input.ground?.arrays)
          for (const a of Object.values(owner.input.ground.arrays)) add(a);
      }
      if (owner.loadingArrays)
        for (const a of Object.values(owner.loadingArrays)) add(a);
      for (const [b, p] of owner.sources) {
        add(b.data);
        add(p.packedArray);
        // Source GPU textures plus not-yet-created packed CPU storage. Once
        // storage exists, its actual backing moves into buffers instead.
        const capacityBytes = Math.ceil(b.count / 2048) * 2048 * 16;
        sourceExtraBytes += Math.max(
          capacityBytes,
          p.packedArray?.byteLength ?? 0,
        );
        if (!p.packedArray && !owner.released)
          sourceExtraBytes += capacityBytes;
      }
      for (const a of owner.prototypes.values()) {
        add(a.lods.full.data);
        add(a.lods.coarse.data);
      }
      if (owner.ground) {
        const { descriptor, source } = owner.ground;
        if (descriptor.arrays)
          for (const a of Object.values(descriptor.arrays)) add(a);
        for (const a of source.extArrays) add(a);
        for (const a of Object.values(source.extra)) add(a);
        sourceExtraBytes += Math.ceil(descriptor.count / 2048) * 2048 * 96;
      }
    }
    if (!rendererReleased) {
      add(spark.readback32, rendererBuffers);
      add(spark.orderingTexture?.image.data, rendererBuffers);
      add(spark.uniforms.ordering.value?.image.data, rendererBuffers);
      for (const b of rendererBuffers) buffers.add(b);
    }
    const rendererCpuBytes = [...rendererBuffers].reduce(
      (n, b) => n + b.byteLength,
      0,
    );
    return {
      buffers: [...buffers],
      extraBytes:
        sourceExtraBytes +
        (rendererReleased
          ? 0
          : Math.max(
              0,
              sparkRendererBudget(retainedCapacity).reservedBytes -
                rendererCpuBytes,
            )),
      settled: !busy(),
    };
  };
  return {
    residency,
    whenQuiescent() {
      if (releaseFailed) return Promise.reject(releaseError);
      if (!busy()) return Promise.resolve();
      if (!quiet) {
        let resolve!: () => void, reject!: (e: unknown) => void;
        const promise = new Promise<void>((a, b) => {
          resolve = a;
          reject = b;
        });
        quiet = { promise, resolve, reject };
        void disposeSpark
          .whenQuiescent()
          .then(finish, (error) => failRelease(error));
      }
      return quiet.promise;
    },
    whenReleased: () => released,
    async setScene(this: GaussianView, input: BuiltScene) {
      try {
        const swap = await this.prepareScene(input);
        swap.activate();
        swap.commit();
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError")) throw e;
      }
    },
    async prepareScene(input: BuiltScene): Promise<SceneSwap> {
      if (disposed) throw new Error("Renderer disposed");
      if (releaseFailed) throw releaseError;
      pending?.rollback();
      const ticket = ++generation;
      sourceLoad?.abort();
      const load = new AbortController();
      sourceLoad = load;
      const current = () => {
        if (releaseFailed) throw releaseError;
        if (ticket !== generation || disposed || load.signal.aborted)
          throw new DOMException("Scene superseded", "AbortError");
      };
      assertSceneBudget(input);
      for (const b of sourceBuffers(input)) assertGaussianBuffer(b);
      const nextBank = new Map<GaussianBuffer, PackedSplats>(),
        nextMeshes = new Map<string, Entry>();
      let nextGround: typeof ground;
      const owner: Owner = {
        input,
        sources: new Map(),
        prototypes: new Map(),
        initializers: 0,
        preparing: true,
        released: false,
        cleanupFailed: false,
      };
      owners.set(nextBank, owner);
      preparing++;
      try {
        const capacity = sparkSceneCapacity(
          [
            input.terrain.count,
            input.water?.count ?? 0,
            input.ground?.count ?? 0,
            ...input.instances.map((i) => {
              const a = input.assets.find((a) => a.id === i.assetId)!;
              return Math.max(a.lods.full.count, a.lods.coarse.count);
            }),
          ].filter((n) => n > 0),
        );
        const p = new THREE.Vector3(),
          s = new THREE.Vector3(),
          q = new THREE.Quaternion(),
          c = new THREE.Color();
        for (const b of sourceBuffers(input)) {
          const packed = new PackedSplats({ maxSplats: b.count });
          nextBank.set(b, packed);
          owner.sources.set(b, packed);
          await initialize(owner, packed.initialized, () => packed.dispose());
          current();
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
          let arrays = descriptor.arrays;
          if ("kind" in descriptor) {
            const d = await parsePreparedDefinition(descriptor.definition);
            current();
            if (!arrays) {
              if (!options.loadPreparedGround)
                throw Error("Missing prepared ground resolver");
              const asset = await options.loadPreparedGround(
                {
                  id: d.metadata.id,
                  contentVersion: d.metadata.contentVersion,
                },
                load.signal,
              );
              owner.loadingArrays = asset.arrays;
              current();
              const supplied = await parsePreparedDefinition(asset.definition);
              current();
              if (
                supplied.metadata.id !== d.metadata.id ||
                supplied.metadata.contentVersion !== d.metadata.contentVersion
              )
                throw Error("Prepared resolver identity mismatch");
              arrays = asset.arrays;
            }
            owner.loadingArrays = arrays;
            await validatePreparedArrays(d, arrays);
          } else {
            arrays ??= await loadRiversideArrays(load.signal);
            owner.loadingArrays = arrays;
            await validateRiversideArrays(arrays);
          }
          current();
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
          owner.ground = nextGround;
          await initialize(owner, source.initialized, () => source.dispose());
          current();
          if (source.getNumSh() !== 3)
            throw new Error("Riverside SH3载入不完整");
          const mesh = new SplatMesh({
            extSplats: source,
            enableLod: false,
            editable: false,
            raycastable: false,
          });
          nextMeshes.set("$ground", { mesh, buffer: descriptor });
          await initialize(owner, mesh.initialized, () =>
            disposeBorrower(mesh),
          );
          current();
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
        await Promise.all(
          [...nextMeshes.values()].map((e) =>
            initialize(owner, e.mesh.initialized, () =>
              disposeBorrower(e.mesh),
            ),
          ),
        );
        current();
        const nextPrototypes = new Map(input.assets.map((a) => [a.id, a])),
          nextExtents = new Map<string, number>();
        owner.prototypes = nextPrototypes;
        for (const a of input.assets) {
          let extent = 0;
          const d = a.lods.full.data;
          for (let i = 0; i < d.length; i += 14)
            extent = Math.max(
              extent,
              Math.hypot(d[i], d[i + 1], d[i + 2]) +
                3 * Math.max(d[i + 3], d[i + 4], d[i + 5]),
            );
          nextExtents.set(a.id, extent);
        }
        const old = {
          meshes,
          bank,
          ground,
          prototypes,
          extents,
          lodEnabled,
          guard,
          camera: camera.position.clone(),
          target: controls.target.clone(),
          interactive: controls.enabled,
        };
        let active = false,
          closed = false;
        const swap: SceneSwap = {
          activate() {
            current();
            if (closed)
              throw new DOMException("Scene swap closed", "AbortError");
            if (active) return;
            for (const e of old.meshes.values()) e.mesh.removeFromParent();
            meshes = nextMeshes;
            bank = nextBank;
            ground = nextGround;
            prototypes = nextPrototypes;
            extents = nextExtents;
            for (const e of meshes.values()) scene.add(e.mesh);
            retainedCapacity = Math.max(retainedCapacity, capacity);
            active = true;
          },
          commit() {
            current();
            if (closed || !active || pending !== swap || gl.isContextLost())
              throw Error("Scene swap cannot commit");
            closed = true;
            pending = undefined;
            releaseFrame(old.meshes, old.bank, old.ground?.source);
            old.ground = undefined;
            old.prototypes.clear();
            nextGround = undefined;
          },
          rollback() {
            if (closed) return;
            closed = true;
            if (active && pending === swap) {
              for (const e of nextMeshes.values()) e.mesh.removeFromParent();
              meshes = old.meshes;
              bank = old.bank;
              ground = old.ground;
              prototypes = old.prototypes;
              extents = old.extents;
              lodEnabled = old.lodEnabled;
              guard = old.guard;
              camera.position.copy(old.camera);
              controls.target.copy(old.target);
              camera.lookAt(controls.target);
              camera.updateMatrixWorld();
              controls.enabled = old.interactive;
              for (const e of meshes.values()) scene.add(e.mesh);
            }
            old.ground = undefined;
            if (pending === swap) pending = undefined;
            releaseFrame(nextMeshes, nextBank, nextGround?.source);
            nextGround = undefined;
          },
        };
        pending = swap;
        return swap;
      } catch (e) {
        releaseFrame(nextMeshes, nextBank, nextGround?.source);
        nextGround = undefined;
        throw e;
      } finally {
        owner.preparing = false;
        // Swap closures need only the owned frame, never the full input scene.
        owner.input = undefined;
        owner.loadingArrays = undefined;
        input = undefined!;
        preparing--;
        finishOwner(owner);
        finish();
      }
    },
    cancelPendingScene() {
      pending?.rollback();
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
          owners.get(bank)?.sources.delete(b);
        }
    },
    clearScene() {
      pending?.rollback();
      generation++;
      sourceLoad?.abort();
      releaseFrame(meshes, bank, ground?.source);
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
      if (disposed || releaseFailed) return;
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
          ) +
          (ground
            ? "kind" in ground.descriptor
              ? ground.descriptor.definition.capacity * 96
              : RIVERSIDE_BYTES
            : 0),
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
      // Stop drawing and bind the terminal result before any cleanup may throw.
      disposed = true;
      generation++;
      pendingDisposals.set(canvas, released);
      const attempt = (cleanup: () => void) => {
        try {
          cleanup();
        } catch (error) {
          failRelease(error);
        }
      };
      attempt(() => pending?.rollback());
      attempt(() => sourceLoad?.abort());
      attempt(() => {
        releaseFrame(meshes, bank, ground?.source);
        ground = undefined;
        prototypes.clear();
        extents.clear();
      });
      guard = null;
      attempt(() => controls.dispose());
      // Continue independent renderer teardown after a source/borrower failure;
      // the failed owner's ledger and rejected release result remain retained.
      attempt(() => {
        void disposeSpark()
          .then(() => {
            rendererDisposed = true;
            finish();
          })
          .catch((error) => failRelease(error));
      });
    },
  };
}
