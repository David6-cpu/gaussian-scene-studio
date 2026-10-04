export function record(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected object");
  const r = value as Record<string, unknown>;
  if (
    Object.keys(r).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(r, k))
  )
    throw new Error("Unknown or missing fields");
  return r;
}
export function finite(
  value: unknown,
  min = -Infinity,
  max = Infinity,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new Error("Number out of range");
  return value;
}
export function integer(value: unknown, min: number, max: number): number {
  const n = finite(value, min, max);
  if (!Number.isInteger(n)) throw new Error("Expected integer");
  return n;
}
export function oneOf<T>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) throw new Error("Invalid enum");
  return value as T;
}
export function vector(value: unknown, length: number): number[] {
  if (!Array.isArray(value) || value.length !== length)
    throw new Error("Invalid vector");
  return value.map((x) => finite(x));
}
