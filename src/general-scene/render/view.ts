import * as THREE from "three";
import type { SplatSource } from "../asset-loader";
import { SplatMesh, SparkRenderer } from "@sparkjsdev/spark";
import {
  SPARK_BUDGET_OPTIONS,
  sparkRendererBudget,
  sparkSceneCapacity,
} from "../../gaussian/spark-budget";
import {
  releaseGeneratorMaterial,
  deferredSparkDisposal,
} from "../../gaussian/spark-lifecycle";
import { GENERAL_LIMITS, type CameraState, type Vec3 } from "../core";
import {
  createSourceBank,
  sourceBytes,
  sourceOwnedBytes,
  type SourceLease,
} from "./source-bank";
import {
  worldPoint,
  type GeneralSwap,
  type GeneralView,
  type RenderPacket,
  type RenderInstance,
} from "./types";
// Approved first release: 1×1 terrain tiles, 20 placed objects, one water node.
// RenderPacket has no roles; the independent placement validator owns the 20-object cap.
const MAX_RENDER_NODES =
  GENERAL_LIMITS.maxExtent ** 2 +
  GENERAL_LIMITS.maxInstances +
  GENERAL_LIMITS.maxWaterBodies;
const pendingDisposals = new WeakMap<HTMLCanvasElement, Promise<void>>();
const abortError = () =>
  new DOMException("General preview cancelled or superseded", "AbortError");
function disposeBorrower(mesh: SplatMesh) {
  mesh.removeFromParent();
  releaseGeneratorMaterial(mesh);
  mesh.splats = undefined;
  mesh.packedSplats = undefined;
  mesh.extSplats = undefined;
  mesh.dispose();
}
function validVector(v: readonly number[], n: number) {
  return Array.isArray(v) && v.length === n && v.every(Number.isFinite);
}
function snapshotPacket(
  input: RenderPacket,
  ownedBytes: number,
  retainedCapacity: number,
) {
  const available = new Map(input.sources),
    sources = new Map<string, SplatSource>();
  const ids = new Set<string>();
  let worstSplats = 0;
  const worstCounts: number[] = [];
  if (
    !Array.isArray(input.instances) ||
    input.instances.length > MAX_RENDER_NODES
  )
    throw Error("Render node budget exceeded");
  const instances = input.instances.map((i) => {
    if (typeof i.id !== "string" || !i.id || ids.has(i.id))
      throw Error("Invalid or duplicate instance ID");
    ids.add(i.id);
    const t = i.transform;
    if (
      !validVector(i.anchor, 3) ||
      !validVector(t.position, 3) ||
      !validVector(t.quaternion, 4) ||
      Math.abs(Math.hypot(...t.quaternion) - 1) > 1e-5 ||
      !Number.isFinite(t.scale) ||
      t.scale <= 0
    )
      throw Error("Invalid instance transform/quaternion");
    let worst = 0;
    for (const key of [i.sourceKey, i.coarseSourceKey])
      if (key !== null) {
        let source = sources.get(key);
        if (!source) {
          const inputSource = available.get(key);
          if (!inputSource) throw Error("Missing source key");
          // Freeze descriptor fields/array references, not caller objects or bytes.
          // The bank owns the single byte snapshot, acquired below before any await.
          source =
            inputSource.kind === "float14"
              ? {
                  kind: inputSource.kind,
                  count: inputSource.count,
                  data: inputSource.data,
                }
              : {
                  kind: inputSource.kind,
                  count: inputSource.count,
                  capacity: inputSource.capacity,
                  arrays: { ...inputSource.arrays },
                };
          sourceBytes(source);
          sources.set(key, source);
        }
        worst = Math.max(worst, source.count);
      }
    worstSplats += worst;
    worstCounts.push(worst);
    return {
      ...i,
      anchor: [...i.anchor] as Vec3,
      transform: {
        position: [...t.position] as Vec3,
        quaternion: [...t.quaternion] as typeof t.quaternion,
        scale: t.scale,
      },
    };
  });
  const capacity = sparkSceneCapacity(worstCounts);
  const incoming = [...sources.values()].reduce(
      (n, s) => n + sourceBytes(s),
      0,
    ),
    allocated = [...sources.values()].reduce(
      (n, s) => n + sourceOwnedBytes(s),
      0,
    );
  const candidateCpuBytes = incoming * 2 + allocated;
  const transitionBytes =
    ownedBytes +
    incoming +
    allocated +
    sparkRendererBudget(Math.max(retainedCapacity, capacity)).reservedBytes;
  // Do not fabricate an object count for core.assertBudget: these are renderer nodes.
  for (const [name, value, ceiling] of [
    ["worstSplats", worstSplats, GENERAL_LIMITS.maxWorstSplats],
    [
      "candidateCpuBytes",
      candidateCpuBytes,
      GENERAL_LIMITS.maxCandidateCpuBytes,
    ],
    ["transitionBytes", transitionBytes, GENERAL_LIMITS.maxTransitionBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0 || value > ceiling)
      throw Error(`Render resource budget exceeded: ${name}`);
  }
  return { sources, instances, capacity };
}
export async function createGeneralView(
  canvas: HTMLCanvasElement,
): Promise<GeneralView> {
  await pendingDisposals.get(canvas);
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: "high-performance",
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0, 0, 0);
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.01, 150);
  camera.position.set(0, 0, 5);
  const target = new THREE.Vector3();
  const spark = new SparkRenderer({ renderer, ...SPARK_BUDGET_OPTIONS });
  const disposeSpark = deferredSparkDisposal(spark, () => renderer.dispose());
  scene.add(spark);
  const bank = createSourceBank();
  type Frame = {
    meshes: SplatMesh[];
    leases: SourceLease[];
    instances: RenderInstance[];
    splats: number;
    released: boolean;
  };
  const empty = (): Frame => ({
    meshes: [],
    leases: [],
    instances: [],
    splats: 0,
    released: false,
  });
  let frame = empty(),
    pending: GeneralSwap | undefined,
    stopLoading: ((error?: unknown) => void) | undefined;
  let rendererDisposed = false,
    rendererReleased = false,
    preparing = 0,
    closed = false,
    broken = false,
    revision = 0,
    lastDraw:
      | {
          frame: Frame;
          revision: number;
          mapping: { node: THREE.Object3D; count: number }[];
        }
      | undefined,
    // Spark can retain accumulator/sort capacity after a smaller or empty scene.
    retainedCapacity = 0,
    disposePromise: Promise<void> | undefined;
  const initializers = new Set<Promise<unknown>>();
  const finishRendererRelease = () => {
    if (!rendererDisposed || rendererReleased || preparing || initializers.size)
      return;
    // Spark 2.3.1 dispose() frees GPU objects, but retains readback and mapping
    // arrays. Only clear these references after sorting AND late initialization
    // cleanup have settled; a caller may keep the closed view alive indefinitely.
    spark.readback32 = new Uint32Array(0);
    for (const accumulator of new Set([
      spark.display,
      spark.current,
      ...spark.accumulators,
    ]))
      accumulator.mapping = [];
    // Declarations assume a live renderer. This closed-only adapter removes the
    // last references to disposed textures; no later draw may consume null.
    for (const uniform of [
      spark.uniforms.ordering,
      spark.uniforms.extSplats,
      spark.uniforms.extSplats2,
    ])
      (uniform as { value: THREE.Texture | null }).value = null;
    rendererReleased = true;
  };
  const trackInitializer = (work: Promise<unknown>) => {
    initializers.add(work);
    const settled = () => {
      initializers.delete(work);
      finishRendererRelease();
    };
    void work.then(settled, settled);
  };
  const release = (f: Frame) => {
    if (f.released) return;
    f.released = true;
    f.meshes.forEach(disposeBorrower);
    f.leases.forEach((l) => l.release());
    f.meshes = [];
    f.leases = [];
    f.instances = [];
    f.splats = 0;
  };
  const getCamera = (): CameraState => ({
    position: camera.position.toArray() as [number, number, number],
    target: target.toArray() as [number, number, number],
  });
  const setCamera = (c: CameraState) => {
    if (!validVector(c.position, 3) || !validVector(c.target, 3))
      throw Error("Invalid camera");
    camera.position.fromArray(c.position);
    target.fromArray(c.target);
    camera.lookAt(target);
    camera.updateMatrixWorld();
  };
  const lost = (event: Event) => {
    event.preventDefault();
    broken = true;
    stopLoading?.();
    pending?.rollback();
  };
  canvas.addEventListener("webglcontextlost", lost);
  const view: GeneralView = {
    async prepare(input, signal) {
      if (closed || broken) throw abortError();
      stopLoading?.();
      pending?.rollback();
      const ticket = ++revision;
      signal.throwIfAborted();
      const packet = snapshotPacket(
          input,
          bank.stats().ownedBytes,
          retainedCapacity,
        ),
        next = empty();
      next.instances = packet.instances;
      let interruption: unknown,
        swap: GeneralSwap | undefined,
        rejectStopped!: (e: unknown) => void;
      const stopped = new Promise<never>((_resolve, reject) => {
        rejectStopped = reject;
      });
      stopped.catch(() => {});
      const stop = (error: unknown = abortError()) => {
        if (interruption) return;
        interruption = error;
        rejectStopped(error);
        swap?.rollback();
      };
      stopLoading = stop;
      const aborted = () => stop();
      signal.addEventListener("abort", aborted, { once: true });
      const timeout = setTimeout(
        () => stop(Error("General preview initialization timed out")),
        GENERAL_LIMITS.maxCpuBuildMs,
      );
      const check = () => {
        if (interruption) throw interruption;
        if (closed || broken || signal.aborted || ticket !== revision)
          throw abortError();
      };
      const cleanup = () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", aborted);
        if (stopLoading === stop) stopLoading = undefined;
      };
      const leases = new Map<string, SourceLease>();
      preparing++;
      try {
        for (const [key, source] of packet.sources) {
          check();
          const lease = bank.acquire(key, source);
          leases.set(key, lease);
          next.leases.push(lease);
          trackInitializer(lease.ready);
        }
        // Capture every source's bytes synchronously under the preflight budget.
        // Waiting inside the acquire loop would expose later sources to caller mutation.
        for (const lease of leases.values()) {
          await Promise.race([lease.ready, stopped]);
          check();
        }
        for (const i of packet.instances) {
          check();
          const source = leases.get(i.sourceKey)!.source;
          const mesh = new SplatMesh({
            ...(packet.sources.get(i.sourceKey)!.kind === "float14"
              ? {
                  packedSplats:
                    source as import("@sparkjsdev/spark").PackedSplats,
                }
              : { extSplats: source as import("@sparkjsdev/spark").ExtSplats }),
            enableLod: false,
            editable: false,
            raycastable: false,
          });
          next.meshes.push(mesh);
          next.splats += packet.sources.get(i.sourceKey)!.count;
          // Object translation is the transformed source origin, not the landing anchor.
          mesh.position.fromArray(worldPoint([0, 0, 0], i.anchor, i.transform));
          mesh.quaternion.fromArray(i.transform.quaternion);
          mesh.scale.setScalar(i.transform.scale);
          const initialized = mesh.initialized.finally(() => {
            // A cancelled prepare may already have released its frame while
            // Spark was still initializing. Clean any late-created generator.
            if (next.released) disposeBorrower(mesh);
          });
          trackInitializer(initialized);
          await Promise.race([initialized, stopped]);
          check();
        }
        clearTimeout(timeout);
        check();
        const old = frame,
          oldCamera = getCamera();
        let active = false,
          finished = false;
        swap = {
          activate() {
            check();
            if (finished) throw abortError();
            if (active) return;
            old.meshes.forEach((m) => m.removeFromParent());
            frame = next;
            retainedCapacity = Math.max(retainedCapacity, packet.capacity);
            next.meshes.forEach((m) => scene.add(m));
            active = true;
            lastDraw = undefined;
          },
          isUsable() {
            if (
              finished ||
              !active ||
              closed ||
              broken ||
              signal.aborted ||
              ticket !== revision ||
              renderer.getContext().isContextLost() ||
              lastDraw?.frame !== next ||
              lastDraw.revision !== ticket
            )
              return false;
            // Consume only a completed draw's immutable mapping snapshot. Spark may
            // replace its live display asynchronously between render() calls.
            return (
              lastDraw.mapping.length === next.meshes.length &&
              next.meshes.every((mesh) =>
                lastDraw!.mapping.some(
                  (m) => m.node === mesh && m.count === mesh.numSplats,
                ),
              )
            );
          },
          commit() {
            check();
            if (!swap!.isUsable() || pending !== swap)
              throw Error("General swap has no usable rendered frame");
            finished = true;
            pending = undefined;
            cleanup();
            release(old);
          },
          rollback() {
            if (finished) return;
            finished = true;
            if (active && pending === swap) {
              next.meshes.forEach((m) => m.removeFromParent());
              frame = old;
              lastDraw = undefined;
              old.meshes.forEach((m) => scene.add(m));
              setCamera(oldCamera);
            }
            if (pending === swap) pending = undefined;
            cleanup();
            release(next);
          },
        };
        pending = swap;
        return swap;
      } catch (error) {
        cleanup();
        release(next);
        throw error;
      } finally {
        // Returned swap callbacks do not need source descriptors or lease maps.
        packet.sources.clear();
        leases.clear();
        preparing--;
        finishRendererRelease();
      }
    },
    getCamera,
    setCamera,
    stats() {
      return {
        ...bank.stats(),
        ownedBytes:
          bank.stats().ownedBytes +
          (rendererReleased
            ? 0
            : sparkRendererBudget(retainedCapacity).reservedBytes),
        instanceCount: frame.released ? 0 : frame.instances.length,
        activeSplats: frame.released ? 0 : frame.splats,
      };
    },
    render() {
      if (closed || broken) return;
      const width = Math.max(1, canvas.clientWidth || canvas.width),
        height = Math.max(1, canvas.clientHeight || canvas.height);
      renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      camera.lookAt(target);
      const drawingFrame = frame,
        drawRevision = revision;
      lastDraw = undefined; // A failed draw cannot retain earlier usable evidence.
      renderer.render(scene, camera);
      // renderer.render is synchronous; no sort promise can resume between the
      // completed WebGL draw and this copy. Empty scenes require an empty mapping.
      const mapping = spark.display?.mapping;
      if (mapping)
        lastDraw = {
          frame: drawingFrame,
          revision: drawRevision,
          mapping: mapping.map(({ node, count }) => ({ node, count })),
        };
    },
    dispose() {
      if (disposePromise) return disposePromise;
      closed = true;
      revision++;
      stopLoading?.();
      pending?.rollback();
      release(frame);
      lastDraw = undefined;
      canvas.removeEventListener("webglcontextlost", lost);
      disposePromise = disposeSpark().then(() => {
        rendererDisposed = true;
        finishRendererRelease();
      });
      pendingDisposals.set(canvas, disposePromise);
      return disposePromise;
    },
  };
  return view;
}
