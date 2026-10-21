import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  ExtSplats,
  SplatMesh,
  SplatFileType,
  SparkRenderer,
} from "@sparkjsdev/spark";
import {
  deferredSparkDisposal,
  releaseGeneratorMaterial,
} from "../gaussian/spark-lifecycle";
import { parseCamera, type Camera, type EnvironmentAsset } from "./asset";
import type { EnvironmentStage } from "./controller";
import type { Residency } from "../general-scene/controller";
import {
  SPARK_BUDGET_OPTIONS,
  sparkSceneCapacity,
  sparkRendererBudget,
} from "../gaussian/spark-budget";

export function createEnvironmentView(
  canvas: HTMLCanvasElement,
  failed: (error: unknown) => void,
) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101c1b);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  const spark = new SparkRenderer({ renderer, ...SPARK_BUDGET_OPTIONS });
  scene.add(spark);
  const disposeSpark = deferredSparkDisposal(spark, () => renderer.dispose());
  type Entry = {
    source: ExtSplats;
    mesh: SplatMesh;
    asset: EnvironmentAsset;
    home: Camera;
  };
  let current: Entry | null = null,
    pending: EnvironmentStage | undefined,
    cancelLoading: ((error?: unknown) => void) | undefined,
    revision = 0,
    closed = false,
    broken = false,
    raf = 0;
  const released = new WeakSet<Entry>();
  type Owner = {
    asset: EnvironmentAsset | null;
    source?: ExtSplats;
    entry?: Entry;
    pending: number;
    released: boolean;
    cleanupFailed?: boolean;
    capacity: number;
  };
  const owners = new Set<Owner>();
  const initializers = new Set<Promise<unknown>>();
  const stages = new Set<Promise<void>>();
  let capacity = 0,
    rendererReleased = false;
  let resolveReleased!: () => void, rejectReleased!: (error: unknown) => void;
  let releaseError: unknown;
  let releaseFailed = false;
  const releasedPromise = new Promise<void>((resolve, reject) => {
    resolveReleased = resolve;
    rejectReleased = reject;
  });
  void releasedPromise.catch(() => {});
  function failRelease(error: unknown, owner?: Owner) {
    if (owner) owner.cleanupFailed = true;
    if (releaseFailed) return;
    releaseFailed = true;
    releaseError = error;
    rejectReleased(error);
    failed(error);
  }
  function finishOwner(owner: Owner) {
    if (!owner.released || owner.pending || owner.cleanupFailed) return;
    owner.asset = null;
    owner.source = undefined;
    if (owner.entry) {
      // Finished swap closures can remain in the controller; drop their heavy roots.
      owner.entry.asset = null as unknown as EnvironmentAsset;
      owner.entry.source = null as unknown as ExtSplats;
      owner.entry.mesh = null as unknown as SplatMesh;
      owner.entry = undefined;
    }
    owners.delete(owner);
  }
  async function whenQuiescent() {
    do {
      if (releaseFailed) throw releaseError;
      await Promise.allSettled([...stages, ...initializers]);
      await disposeSpark.whenQuiescent();
      if (releaseFailed) throw releaseError;
    } while (stages.size || initializers.size || disposeSpark.activity().busy);
  }
  const addBuffer = (set: Set<ArrayBuffer>, value: unknown) => {
    if (
      ArrayBuffer.isView(value) &&
      value.buffer instanceof ArrayBuffer &&
      value.buffer.byteLength
    )
      set.add(value.buffer);
  };
  function residency(): Residency {
    const buffers = new Set<ArrayBuffer>();
    let extraBytes = 0;
    for (const owner of owners) {
      if (owner.asset) addBuffer(buffers, owner.asset.spz);
      const arrays = new Set<ArrayBuffer>();
      for (const array of owner.source?.extArrays ?? [])
        addBuffer(arrays, array);
      for (const value of Object.values(owner.source?.extra ?? {}))
        addBuffer(arrays, value);
      for (const array of arrays) buffers.add(array);
      const actual = [...arrays].reduce((n, b) => n + b.byteLength, 0);
      const sourceBytes =
        owner.capacity * [32, 48, 64, 96][owner.asset?.splats.shDegree ?? 3];
      // Padded Ext/SH GPU textures; pending loader owns its sliced input and decoded output.
      if (!owner.released || owner.pending || owner.cleanupFailed)
        extraBytes += sourceBytes;
      if (owner.pending)
        extraBytes +=
          Math.max(0, sourceBytes - actual) +
          (owner.asset?.spz.byteLength ?? 0);
    }
    if (!rendererReleased) {
      const rendererBuffers = new Set<ArrayBuffer>();
      addBuffer(rendererBuffers, spark.readback32);
      addBuffer(rendererBuffers, spark.orderingTexture?.image.data);
      for (const buffer of rendererBuffers) buffers.add(buffer);
      extraBytes += Math.max(
        0,
        sparkRendererBudget(capacity).reservedBytes -
          [...rendererBuffers].reduce((n, b) => n + b.byteLength, 0),
      );
    }
    return {
      buffers: [...buffers],
      extraBytes,
      settled:
        !releaseFailed &&
        !stages.size &&
        !initializers.size &&
        !disposeSpark.activity().busy,
    };
  }
  const disposeEntry = (entry: Entry) => {
    entry.mesh.removeFromParent();
    releaseGeneratorMaterial(entry.mesh);
    entry.mesh.splats = undefined;
    entry.mesh.extSplats = undefined;
    entry.mesh.packedSplats = undefined;
    entry.mesh.dispose();
    entry.source.dispose();
  };
  const release = (entry: Entry | null) => {
    if (!entry || released.has(entry)) return;
    released.add(entry);
    const owner = [...owners].find((value) => value.entry === entry);
    try {
      disposeEntry(entry);
    } catch (error) {
      failRelease(error, owner);
    } finally {
      if (owner) {
        owner.released = true;
        finishOwner(owner);
      }
    }
  };
  const getCamera = (): Camera => ({
    position: camera.position.toArray() as Camera["position"],
    target: controls.target.toArray() as Camera["target"],
  });
  const setCamera = (value: Camera) => {
    const c = parseCamera(value);
    camera.position.fromArray(c.position);
    controls.target.fromArray(c.target);
    camera.lookAt(controls.target);
    camera.updateMatrixWorld();
  };
  function draw() {
    if (closed || broken) return;
    const bounds = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(bounds.width)),
      h = Math.max(1, Math.round(bounds.height)),
      dpr = Math.min(2, devicePixelRatio || 1);
    if (
      canvas.width !== Math.round(w * dpr) ||
      canvas.height !== Math.round(h * dpr)
    ) {
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    controls.update();
    renderer.render(scene, camera);
  }
  function fault(error: unknown) {
    if (closed || broken) return;
    broken = true;
    cancelLoading?.(error);
    controls.enabled = false;
    failed(error);
  }
  function tick() {
    if (closed) return;
    try {
      draw();
    } catch (e) {
      fault(e);
    }
    raf = requestAnimationFrame(tick);
  }
  const lost = (e: Event) => {
    e.preventDefault();
    fault(Error("WebGL环境显示中断，请返回原场景后重新打开。"));
  };
  canvas.addEventListener("webglcontextlost", lost);
  raf = requestAnimationFrame(tick);
  return {
    residency,
    whenQuiescent,
    whenReleased: () => releasedPromise,
    camera: getCamera,
    reset() {
      if (current) setCamera(current.home);
    },
    diagnostics() {
      const first = current?.source.getSplat(0).center.clone();
      current?.mesh.updateMatrixWorld(true);
      return {
        sources: current ? 1 : 0,
        count: current?.source.getNumSplats() ?? 0,
        shDegree: current?.source.getNumSh() ?? 0,
        rawFirst: first?.toArray() ?? null,
        worldFirst:
          first?.applyMatrix4(current!.mesh.matrixWorld).toArray() ?? null,
        camera: getCamera(),
      };
    },
    async stage(
      asset: EnvironmentAsset,
      signal: AbortSignal,
      savedCamera?: Camera,
    ): Promise<EnvironmentStage> {
      cancelLoading?.();
      pending?.rollback();
      const ticket = ++revision;
      const deadline = performance.now() + 10000;
      let loading = true;
      let interruption: unknown;
      const check = () => {
        if (interruption) throw interruption;
        if (closed || broken || signal.aborted || ticket !== revision)
          throw new DOMException("环境显示已取消或中断。", "AbortError");
        if (loading && performance.now() >= deadline)
          throw Error("环境加载或实际显示超时。");
      };
      check();
      const sourceCapacity = sparkSceneCapacity([asset.splats.count]);
      let settleStage!: () => void;
      const stageWork = new Promise<void>((resolve) => {
        settleStage = resolve;
      });
      stages.add(stageWork);
      const owner: Owner = {
        asset,
        pending: 0,
        released: false,
        capacity: sourceCapacity,
      };
      owners.add(owner);
      let mesh!: SplatMesh;
      let source: ExtSplats | undefined,
        entry: Entry | undefined,
        swap: EnvironmentStage | undefined;
      let rejectStopped!: (error: unknown) => void;
      const stopped = new Promise<never>((_resolve, reject) => {
        rejectStopped = reject;
      });
      const stop = (
        error: unknown = new DOMException(
          "环境显示已取消或中断。",
          "AbortError",
        ),
      ) => {
        if (interruption) return;
        interruption = error;
        rejectStopped(error);
        swap?.rollback();
      };
      const abort = () => stop();
      cancelLoading = stop;
      signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(
        () => stop(Error("环境加载或实际显示超时。")),
        10000,
      );
      // Spark's worker has no cancellation API. Release current allocations on
      // interruption, then release any allocations created by a late result too.
      const initialize = async (
        work: Promise<unknown>,
        cleanup: () => void,
      ) => {
        let settled = false;
        owner.pending++;
        const tracked = work
          .then(
            (value) => {
              settled = true;
              return value;
            },
            (error) => {
              settled = true;
              throw error;
            },
          )
          .finally(() => {
            try {
              if (owner.released) cleanup();
            } catch (error) {
              failRelease(error, owner);
            } finally {
              owner.pending--;
              initializers.delete(tracked);
              finishOwner(owner);
            }
          });
        initializers.add(tracked);
        try {
          await Promise.race([tracked, stopped]);
        } catch (error) {
          if (!settled) void tracked.catch(() => {});
          throw error;
        }
      };
      try {
        if (Math.ceil(asset.splats.count / 2048) * 2048 * 96 > 64 * 1024 ** 2)
          throw Error("环境解码缓冲超过64MiB。");
        source = new ExtSplats({
          fileBytes: asset.spz,
          fileType: SplatFileType.SPZ,
          maxSplats: asset.splats.count,
          lod: false,
          nonLod: true,
        });
        owner.source = source;
        await initialize(source.initialized, () => owner.source?.dispose());
        check();
        if (
          source.getNumSplats() !== asset.splats.count ||
          source.getNumSh() !== asset.splats.shDegree
        )
          throw Error("实际SPZ解码点数或SH与声明不一致。");
        mesh = new SplatMesh({
          extSplats: source,
          enableLod: false,
          editable: false,
          raycastable: false,
        });
        entry = {
          mesh,
          source,
          asset,
          home: { position: [1, 1, 1], target: [0, 0, 0] },
        };
        owner.entry = entry;
        await initialize(mesh.initialized, () => {
          if (owner.entry) disposeEntry(owner.entry);
        });
        check();
        // Spark v2/v3 SPZ decoding preserves the supplied coordinates (verified
        // with an asymmetric fixture). Apply the provider transform once here.
        mesh.scale.setScalar(asset.transform.scale);
        mesh.rotation.x = asset.transform.flipY ? Math.PI : 0;
        mesh.position.y = asset.transform.flipY
          ? asset.transform.offset
          : -asset.transform.offset;
        mesh.updateMatrixWorld(true);
        const bounds = new THREE.Box3(),
          p = new THREE.Vector3();
        source.forEachSplat((_i, center, scales, q, opacity, color) => {
          if (
            [
              ...center.toArray(),
              ...scales.toArray(),
              ...q.toArray(),
              opacity,
              ...color.toArray(),
            ].some((n) => !Number.isFinite(n)) ||
            Math.min(scales.x, scales.y, scales.z) <= 0
          )
            throw Error("SPZ含无效高斯参数。");
          p.copy(center).applyMatrix4(mesh.matrixWorld);
          const radius =
            3 * Math.max(scales.x, scales.y, scales.z) * asset.transform.scale;
          if (p.length() + radius > 90000)
            throw Error("环境坐标超出当前查看范围。");
          bounds.expandByPoint(p.clone().addScalar(radius));
          bounds.expandByPoint(p.clone().addScalar(-radius));
        });
        const target = bounds.getCenter(new THREE.Vector3()),
          radius = Math.max(
            0.2,
            bounds.getSize(new THREE.Vector3()).length() / 2,
          );
        entry.home = {
          position: target
            .clone()
            .add(
              new THREE.Vector3(0.5, 0.35, 1)
                .normalize()
                .multiplyScalar(radius * 3),
            )
            .toArray() as Camera["position"],
          target: target.toArray() as Camera["target"],
        };
        const previous = current,
          previousCamera = current ? getCamera() : null,
          next = entry;
        let finished = false;
        swap = {
          usable: () =>
            !closed &&
            !broken &&
            !signal.aborted &&
            !finished &&
            current === next &&
            ticket === revision,
          camera: getCamera,
          commit() {
            check();
            if (finished || current !== next) throw Error("环境预览已过期。");
            finished = true;
            pending = undefined;
            signal.removeEventListener("abort", abort);
            release(previous);
          },
          rollback() {
            if (finished) return;
            finished = true;
            signal.removeEventListener("abort", abort);
            if (current === next) {
              next.mesh.removeFromParent();
              current = previous;
              if (previous) {
                scene.add(previous.mesh);
                if (previousCamera) setCamera(previousCamera);
              }
            }
            if (pending === swap) pending = undefined;
            release(next);
          },
        };
        capacity = Math.max(capacity, owner.capacity);
        previous?.mesh.removeFromParent();
        scene.add(mesh);
        current = next;
        pending = swap;
        setCamera(savedCamera ?? entry.home);
        while (true) {
          check();
          draw();
          if (
            spark.display.mapping.some(
              (m) => m.node === mesh && m.count === asset.splats.count,
            )
          ) {
            draw();
            break;
          }
          await Promise.race([new Promise(requestAnimationFrame), stopped]);
        }
        check();
        return swap;
      } catch (e) {
        signal.removeEventListener("abort", abort);
        if (swap) swap.rollback();
        else if (entry) release(entry);
        else {
          try {
            source?.dispose();
          } catch (error) {
            failRelease(error, owner);
          } finally {
            owner.released = true;
            finishOwner(owner);
          }
        }
        throw e;
      } finally {
        loading = false;
        clearTimeout(timeout);
        if (cancelLoading === stop) cancelLoading = undefined;
        stages.delete(stageWork);
        settleStage();
        // The returned swap keeps only next/previous owners. Do not retain the
        // completed async call's input/source locals through its closure context.
        asset = null as unknown as EnvironmentAsset;
        source = undefined;
        entry = undefined;
        mesh = undefined as unknown as SplatMesh;
      }
    },
    dispose() {
      if (closed) return;
      closed = true;
      revision++;
      cancelLoading?.();
      cancelAnimationFrame(raf);
      pending?.rollback();
      release(current);
      current = null;
      canvas.removeEventListener("webglcontextlost", lost);
      controls.dispose();
      void (async () => {
        try {
          await disposeSpark();
          await whenQuiescent();
          // Spark 2.3.1 retains these public CPU/texture references after dispose.
          spark.readback32 = new Uint32Array(0);
          for (const accumulator of new Set([
            spark.display,
            spark.current,
            ...spark.accumulators,
          ])) {
            accumulator.mapping = [];
            accumulator.readback = null;
            accumulator.readbackSplats = [];
          }
          for (const name of ["ordering", "extSplats", "extSplats2"] as const)
            if (spark.uniforms[name])
              (spark.uniforms[name] as { value: unknown }).value = null;
          scene.clear();
          rendererReleased = true;
          resolveReleased();
        } catch (e) {
          failRelease(e);
        }
      })();
    },
  };
}
