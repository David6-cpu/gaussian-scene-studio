import {
  SplatAccumulator,
  type SplatMesh,
  type SparkRenderer,
} from "@sparkjsdev/spark";
import { RawShaderMaterial } from "three";

// Spark 2.3.1 caches a compute material per generator but SplatMesh.dispose()
// does not release it. Our meshes own their generators, even with shared data.
// This placeholder is never rendered or uploaded to a WebGL context.
const emptyComputeMaterial = new RawShaderMaterial({ visible: false });

export function releaseGeneratorMaterial(mesh: SplatMesh) {
  const generator = mesh.generator ?? mesh.covGenerator;
  if (!generator) return;
  const program = SplatAccumulator.generatorProgram.get(generator);
  if (!program) return;
  const material = program.prepareMaterial();
  material.dispose();
  SplatAccumulator.generatorProgram.delete(generator);
  if (SplatAccumulator.fullScreenQuad.material === material)
    SplatAccumulator.fullScreenQuad.material = emptyComputeMaterial;
}

// Version-pinned adapter: Spark 2.3.1 dispose() clears targets while driveSort()
// can still be awaiting readPause, GPU readback or its worker. Track the whole
// promise, including recursively scheduled sorts, before freeing those targets.
// driveSort is private in the declarations but a normal method at runtime.
// Revalidate this adapter and browser regressions when upgrading Spark.
export function deferredSparkDisposal(spark: SparkRenderer, after: () => void) {
  const internal = spark as unknown as { driveSort(): Promise<void> };
  const driveSort = internal.driveSort.bind(spark);
  const pending = new Set<Promise<void>>();
  let resolveDisposed!: () => void;
  let rejectDisposed!: (error: unknown) => void;
  const disposed = new Promise<void>((resolve, reject) => {
    resolveDisposed = resolve;
    rejectDisposed = reject;
  });
  let closing = false,
    released = false,
    finalized = false,
    failed = false;
  let failure: unknown;
  let quiet:
    | { promise: Promise<void>; resolve(): void; reject(e: unknown): void }
    | undefined;
  let probe: ReturnType<typeof setTimeout> | undefined;
  const scheduled = () =>
    spark.updateTimeoutId !== undefined || spark.sortTimeoutId !== undefined;
  const busy = () => pending.size > 0 || scheduled() || (closing && !released);
  const settleQuiet = () => {
    if (!quiet) return;
    if (failed) {
      clearTimeout(probe);
      probe = undefined;
      quiet.reject(failure);
      quiet = undefined;
    } else if (!busy()) {
      clearTimeout(probe);
      probe = undefined;
      quiet.resolve();
      quiet = undefined;
    } else if (!pending.size && scheduled() && probe === undefined) {
      // Observe already scheduled Spark work without cancelling it or drawing.
      // In this app minSortIntervalMs=0/preUpdate=true; this is a timer-boundary guard.
      probe = setTimeout(() => {
        probe = undefined;
        settleQuiet();
      }, 1);
    }
  };
  const finish = () => {
    if (!closing || finalized || pending.size) return;
    finalized = true;
    try {
      spark.dispose();
      after();
      released = true;
      resolveDisposed();
    } catch (error) {
      failed = true;
      failure = error;
      rejectDisposed(error);
    }
    settleQuiet();
  };
  internal.driveSort = () => {
    if (closing) return Promise.resolve();
    const work = driveSort().finally(() => {
      pending.delete(work);
      finish();
      settleQuiet();
    });
    pending.add(work);
    // Return the derived promise: errors must propagate even when Spark calls
    // driveSort without awaiting it (recursive and timer-triggered sorts).
    return work;
  };
  const release = () => {
    if (closing) return disposed;
    closing = true;
    spark.autoUpdate = false;
    spark.sortDirty = false;
    spark.removeFromParent();
    clearTimeout(spark.updateTimeoutId);
    clearTimeout(spark.sortTimeoutId);
    spark.updateTimeoutId = undefined;
    spark.sortTimeoutId = undefined;
    finish();
    settleQuiet();
    return disposed;
  };
  return Object.assign(release, {
    activity: () => ({ busy: busy(), released }),
    whenQuiescent() {
      if (failed) return Promise.reject(failure);
      if (!busy()) return Promise.resolve();
      if (!quiet) {
        let resolve!: () => void, reject!: (e: unknown) => void;
        const promise = new Promise<void>((a, b) => {
          resolve = a;
          reject = b;
        });
        quiet = { promise, resolve, reject };
      }
      const promise = quiet.promise;
      settleQuiet();
      return promise;
    },
  });
}
