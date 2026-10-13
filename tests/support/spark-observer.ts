// Browser-test observations only; never included in the application entry points.
import {
  SparkRenderer,
  ExtSplats,
  SplatMesh,
  PackedSplats,
} from "@sparkjsdev/spark";
import { UnsignedByteType, UnsignedIntType } from "three";

let spark: SparkRenderer | undefined;
let disposals = 0;
let workerReturned = false;
const before = SparkRenderer.prototype.onBeforeRender;
SparkRenderer.prototype.onBeforeRender = function (...args) {
  spark = this;
  return before.apply(this, args);
};
const dispose = SparkRenderer.prototype.dispose;
SparkRenderer.prototype.dispose = function () {
  disposals++;
  return dispose.call(this);
};

type Kind = "packed" | "ext" | "mesh";
const live = {
  packed: new Set<object>(),
  ext: new Set<object>(),
  mesh: new Set<object>(),
};
let injection:
  { kind: Kind; mode: "fail" | "pause"; target?: object } | undefined;
let releaseInitialization: ((error?: string) => void) | undefined;
let held = false;
for (const [kind, Class] of [
  ["packed", PackedSplats],
  ["ext", ExtSplats],
  ["mesh", SplatMesh],
] as const) {
  const values = new WeakMap<object, Promise<unknown>>();
  Object.defineProperty(Class.prototype, "initialized", {
    configurable: true,
    get() {
      return values.get(this);
    },
    set(value: Promise<unknown>) {
      live[kind].add(this);
      let next = value;
      if (injection?.kind === kind) {
        injection.target ??= this;
        if (injection.target === this) {
          if (injection.mode === "fail")
            next = Promise.resolve(value).then(() => {
              throw Error("injected " + kind + " initialization failure");
            });
          else {
            held = true;
            let release!: (error?: string) => void;
            const gate = new Promise<void>((resolve, reject) => {
              release = (error) => (error ? reject(Error(error)) : resolve());
            });
            const prior = releaseInitialization;
            releaseInitialization = (error) => {
              prior?.(error);
              release(error);
            };
            next = Promise.resolve(value).then(() => gate);
          }
        }
      }
      next.catch(() => {});
      values.set(this, next);
    },
  });
  const dispose = Class.prototype.dispose;
  Class.prototype.dispose = function () {
    live[kind].delete(this);
    return dispose.call(this);
  };
}
export const sparkProbe = {
  failInitialization(kind: Kind) {
    injection = { kind, mode: "fail" };
  },
  pauseInitialization(kind: Kind) {
    held = false;
    injection = { kind, mode: "pause" };
  },
  resumeInitialization(error?: string) {
    injection = undefined;
    releaseInitialization?.(error);
    releaseInitialization = undefined;
    held = false;
  },
  snapshot() {
    return {
      sorting: spark?.sorting,
      initializationHeld: held,
      live: {
        packed: live.packed.size,
        ext: live.ext.size,
        mesh: live.mesh.size,
      },
      disposals,
      textures: spark?.renderer.info.memory.textures,
      programReferences: spark?.renderer.info.programs?.reduce(
        (sum, program) => sum + program.usedTimes,
        0,
      ),
      worker: Boolean(spark?.sortWorker),
      workerReturned,
    };
  },
  resources() {
    if (!spark) throw Error("Spark has not rendered");
    const accumulators = [
      ...new Set([spark.display, spark.current, ...spark.accumulators]),
    ].map((accumulator) => {
      const target = accumulator.target;
      const textures =
        target?.textures.map((texture) => ({
          type: texture.type,
          format: texture.format,
          bytesPerSlot:
            texture.type === UnsignedIntType
              ? 16
              : texture.type === UnsignedByteType
                ? 4
                : null,
        })) ?? [];
      if (textures.some((texture) => texture.bytesPerSlot === null))
        throw Error("Unobserved accumulator texture type");
      return {
        maxSplats: accumulator.maxSplats,
        mappingNodes: accumulator.mapping.length,
        target: target
          ? {
              width: target.width,
              height: target.height,
              depth: target.depth,
              textures,
            }
          : null,
        targetBytes: target
          ? target.width *
            target.height *
            target.depth *
            textures.reduce((n, texture) => n + texture.bytesPerSlot!, 0)
          : 0,
      };
    });
    const ordering = spark.uniforms.ordering.value as {
      image?: { data?: { byteLength: number } };
    } | null;
    return {
      configuration: {
        accumExtSplats: spark.accumExtSplats,
        covSplats: spark.covSplats,
        enableLod: spark.enableLod,
        enableDriveLod: spark.enableDriveLod,
        pagedExtSplats: spark.pagedExtSplats,
        hasTarget: Boolean(spark.target),
      },
      accumulators,
      targetBytes: accumulators.reduce(
        (n, accumulator) => n + accumulator.targetBytes,
        0,
      ),
      orderingHighWater: spark.maxSplats,
      orderingCpuBytes: spark.orderingTexture?.image.data?.byteLength ?? 0,
      uniformOrderingBytes: ordering?.image?.data?.byteLength ?? 0,
      readbackBytes: spark.readback32.byteLength,
    };
  },
  pauseReadback(ms: number) {
    if (!spark) throw new Error("Spark has not rendered");
    spark.readPause = ms;
  },
  pauseAfterWorker() {
    if (!spark?.sortWorker) throw new Error("Sort worker is not ready");
    spark.sortDelay = 150;
    workerReturned = false;
    const worker = spark.sortWorker as unknown as {
      call(...args: unknown[]): Promise<unknown>;
    };
    const call = worker.call.bind(worker);
    worker.call = async (...args) => {
      const result = await call(...args);
      workerReturned = true;
      return result;
    };
  },
  failNextReadback() {
    if (!spark) throw new Error("Spark has not rendered");
    const internal = spark as unknown as {
      readbackDepth(...args: unknown[]): Promise<void>;
    };
    const original = internal.readbackDepth;
    internal.readbackDepth = () => {
      internal.readbackDepth = original;
      return Promise.reject(new Error("injected readback failure"));
    };
  },
  scheduleSort() {
    if (!spark) throw new Error("Spark has not rendered");
    spark.autoUpdate = false;
    spark.minSortIntervalMs = 50;
    spark.lastSortTime = performance.now();
    spark.sortDirty = true;
    const internal = spark as unknown as { driveSort(): Promise<void> };
    void internal.driveSort();
  },
};
