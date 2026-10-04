// Browser-test observations only; never included in the application entry points.
import { SparkRenderer } from "@sparkjsdev/spark";

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

export const sparkProbe = {
  snapshot() {
    return {
      sorting: spark?.sorting,
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
