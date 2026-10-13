/** Spark 2.3.1 standard renderer allocation model; re-audit on dependency upgrades. */
export const SPARK_BUDGET_VERSION = "2.3.1";
export const SPARK_BUDGET_OPTIONS = Object.freeze({
  accumExtSplats: false,
  covSplats: false,
  enableLod: false,
  enableDriveLod: false,
  pagedExtSplats: false,
});
type BudgetOptions = {
  [K in keyof typeof SPARK_BUDGET_OPTIONS]: boolean;
} & { target?: unknown };
const ROW = 2048;
const ORDERING_ROW = 16384;
// The current app stays below one texture layer. Larger scenes need a new model
// for getTextureSize's layer padding, rather than silently using this estimate.
const MAX_CAPACITY = ROW * ROW;
const WORKSPACE_BYTES = 8 * 1024 ** 2;
function safe(value: number) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw Error("Invalid Spark capacity or unsafe byte arithmetic");
  return value;
}
function round(value: number, alignment: number) {
  return safe(Math.ceil(safe(value) / alignment) * alignment);
}
/** Each generator has its own 2048-wide rows, even when sources are shared. */
export function sparkSceneCapacity(worstCounts: readonly number[]): number {
  let capacity = 0;
  for (const count of worstCounts) {
    if (safe(count) === 0)
      throw Error("Spark generator count must be positive");
    capacity = safe(capacity + round(count, ROW));
  }
  if (capacity > MAX_CAPACITY) throw Error("Unsupported Spark capacity");
  return capacity;
}
/** Known application allocations and a conservative reservation, not a process/VRAM cap. */
export function sparkRendererBudget(
  capacity: number,
  options: BudgetOptions = SPARK_BUDGET_OPTIONS,
) {
  if (
    Object.keys(SPARK_BUDGET_OPTIONS).some(
      (key) => options[key as keyof typeof SPARK_BUDGET_OPTIONS] !== false,
    ) ||
    options.target != null
  )
    throw Error("Unsupported Spark budget configuration");
  safe(capacity);
  if (capacity % ROW || capacity > MAX_CAPACITY)
    throw Error("Unsupported Spark padded capacity");
  const orderingCapacity = round(Math.max(1, capacity), ORDERING_ROW);
  const accumulatorBytes = safe(3 * 20 * capacity);
  // Empty logical scenes still have minimum readback and ordering arrays.
  const readbackBytes = safe(4 * Math.max(ROW, capacity));
  const pixelPackBytes = safe(4 * capacity);
  // Old CPU image, new CPU/worker ordering, and GPU ordering. Transferring one
  // ArrayBuffer moves ownership; it is not a second persistent CPU allocation.
  const orderingBytes = safe(12 * orderingCapacity);
  const knownBytes = safe(
    accumulatorBytes + readbackBytes + pixelPackBytes + orderingBytes,
  );
  // Nonempty: 68C+12O < 80C+196608 <= 128C+8MiB. For C=0 the
  // 8192-byte readback and minimum ordering also fit the fixed reserve.
  const reservedBytes = safe(WORKSPACE_BYTES + 128 * capacity);
  return {
    capacity,
    orderingCapacity,
    accumulatorBytes,
    readbackBytes,
    pixelPackBytes,
    orderingBytes,
    knownBytes,
    reservedBytes,
    unmeasured: ["private-wasm-runtime", "driver"] as const,
  };
}
