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
    released = false;
  const finish = () => {
    if (!closing || released || pending.size) return;
    released = true;
    try {
      spark.dispose();
      after();
      resolveDisposed();
    } catch (error) {
      rejectDisposed(error);
    }
  };
  internal.driveSort = () => {
    if (closing) return Promise.resolve();
    const work = driveSort().finally(() => {
      pending.delete(work);
      finish();
    });
    pending.add(work);
    // Return the derived promise: errors must propagate even when Spark calls
    // driveSort without awaiting it (recursive and timer-triggered sorts).
    return work;
  };
  return () => {
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
    return disposed;
  };
}
