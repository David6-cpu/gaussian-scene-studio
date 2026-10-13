import { integer } from "../data-validation.ts";
import {
  instanceIdFor,
  parseEditableState,
  type EditableState,
} from "./contracts.ts";
export const PRNG_VERSION = "fnv1a32-v1" as const;
/** FNV-1a-32 over [version, decimal seed, stableId, purpose, decimal attempt].
 * Every field is UTF-8 prefixed by its unsigned 32-bit LITTLE-ENDIAN byte length.
 * Numeric fields have canonical decimal spelling; no implicit normalization of text.
 */
export function deriveSeed(
  seed: number,
  stableId: string,
  purpose: string,
  attempt: number,
): number {
  integer(seed, 0, 0xffffffff);
  integer(attempt, 0, 0xffffffff);
  if (
    typeof stableId !== "string" ||
    !stableId ||
    typeof purpose !== "string" ||
    !purpose
  )
    throw Error("Random stream needs stable identity and purpose");
  let hash = 2166136261;
  const byte = (b: number) => {
    hash = Math.imul(hash ^ b, 16777619) >>> 0;
  };
  for (const field of [
    PRNG_VERSION,
    String(seed),
    stableId,
    purpose,
    String(attempt),
  ]) {
    // UTF-8 replacement of lone surrogates would alias distinct stream identities.
    if (
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        field,
      )
    )
      throw Error("Invalid UTF-8 stream identity");
    const bytes = new TextEncoder().encode(field);
    integer(bytes.length, 0, 0xffffffff);
    for (let shift = 0; shift < 32; shift += 8)
      byte((bytes.length >>> shift) & 255);
    for (const b of bytes) byte(b);
  }
  return hash;
}
export const randomSample = (
  seed: number,
  stableId: string,
  purpose: string,
  attempt: number,
): number => deriveSeed(seed, stableId, purpose, attempt) / 4294967296;
/** Allocation never infers state from accepted instance count; deleted groups stay retired. */
export function allocateSlot(
  value: EditableState,
  groupId: string,
): { state: EditableState; instanceId: string } {
  const current = parseEditableState(value),
    groups = current.groups.map((g) => ({ ...g }));
  let group = groups.find((g) => g.groupId === groupId);
  if (!group) {
    group = { groupId, nextSlot: 0, retired: false };
    groups.push(group);
  }
  if (group.retired || group.nextSlot === Number.MAX_SAFE_INTEGER)
    throw Error("Retired/exhausted group allocator");
  const instanceId = instanceIdFor(groupId, group.nextSlot++);
  return { state: parseEditableState({ ...current, groups }), instanceId };
}
