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
  const spark = new SparkRenderer({ renderer, enableLod: false });
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
    disposeEntry(entry);
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
        const tracked = work.then(
          (value) => {
            settled = true;
            return value;
          },
          (error) => {
            settled = true;
            throw error;
          },
        );
        try {
          await Promise.race([tracked, stopped]);
        } catch (error) {
          if (!settled) void tracked.then(cleanup, cleanup).catch(() => {});
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
        const loadingSource = source;
        await initialize(source.initialized, () => loadingSource.dispose());
        check();
        if (
          source.getNumSplats() !== asset.splats.count ||
          source.getNumSh() !== asset.splats.shDegree
        )
          throw Error("实际SPZ解码点数或SH与声明不一致。");
        const mesh = new SplatMesh({
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
        const loadingEntry = entry;
        await initialize(mesh.initialized, () => disposeEntry(loadingEntry));
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
        else source?.dispose();
        throw e;
      } finally {
        loading = false;
        clearTimeout(timeout);
        if (cancelLoading === stop) cancelLoading = undefined;
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
      void disposeSpark().catch((e) => failed(e));
    },
  };
}
