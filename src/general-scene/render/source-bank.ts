import { ExtSplats, PackedSplats } from "@sparkjsdev/spark";
import { Color, Quaternion, Vector3 } from "three";
import { assertGaussianBuffer } from "../../gaussian/validate";
import { SH3_KEYS } from "../../io/sh3-variant";
import type { SplatSource } from "../asset-loader";
import { GENERAL_LIMITS } from "../core";
import { arraysOf, sourceBytes, sourceOwnedBytes } from "./source-bytes";
export { sourceBytes, sourceOwnedBytes };
export type SourceLease = {
  source: PackedSplats | ExtSplats;
  ready: Promise<void>;
  release(): void;
};
function snapshot(s: SplatSource): SplatSource {
  if (s.kind === "float14") {
    assertGaussianBuffer(s);
    return { ...s, data: new Float32Array(s.data) };
  }
  return {
    ...s,
    arrays: Object.fromEntries(
      SH3_KEYS.map((k) => [k, new Uint32Array(s.arrays[k])]),
    ) as typeof s.arrays,
  };
}
function same(a: SplatSource, b: SplatSource) {
  if (
    a.kind !== b.kind ||
    a.count !== b.count ||
    sourceBytes(a) !== sourceBytes(b)
  )
    return false;
  const aa = arraysOf(a),
    bb = arraysOf(b);
  return aa.every((arr, k) => {
    const x = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength),
      y = new Uint8Array(bb[k].buffer, bb[k].byteOffset, bb[k].byteLength);
    return x.every((v, i) => v === y[i]);
  });
}
export function createSourceBank() {
  type Entry = {
    key: string;
    snapshot: SplatSource;
    source: PackedSplats | ExtSplats;
    refs: number;
    settled: boolean;
    bytes: number;
    ready: Promise<void>;
  };
  const active = new Map<string, Entry>(),
    retained = new Set<Entry>();
  return {
    acquire(key: string, input: SplatSource): SourceLease {
      if (typeof key !== "string" || !key) throw Error("Invalid source key");
      const bytes = sourceOwnedBytes(input);
      let entry = active.get(key);
      if (entry) {
        if (!same(input, entry.snapshot))
          throw Error("Source key identity changed while retained");
        entry.refs++;
      } else {
        if (
          [...retained].reduce((n, e) => n + e.bytes, 0) + bytes >
          GENERAL_LIMITS.maxTransitionBytes
        )
          throw Error("Source bank budget exceeded");
        const copy = snapshot(input),
          source =
            copy.kind === "float14"
              ? new PackedSplats({ maxSplats: copy.count })
              : new ExtSplats({
                  numSplats: copy.count,
                  extArrays: [copy.arrays.ext0, copy.arrays.ext1],
                  extra: {
                    sh1: copy.arrays.sh1,
                    sh2: copy.arrays.sh2,
                    sh3a: copy.arrays.sh3a,
                    sh3b: copy.arrays.sh3b,
                  },
                });
        entry = {
          key,
          snapshot: copy,
          source,
          refs: 1,
          settled: false,
          bytes,
          ready: Promise.resolve(),
        };
        const e = entry;
        active.set(key, e);
        retained.add(e);
        e.ready = (async () => {
          try {
            await source.initialized;
            if (!e.refs) return;
            if (copy.kind === "float14") {
              const packed = source as PackedSplats,
                p = new Vector3(),
                s = new Vector3(),
                q = new Quaternion(),
                c = new Color(),
                d = copy.data;
              for (let i = 0; i < copy.count; i++) {
                if (i > 0 && i % 1024 === 0) {
                  await new Promise<void>((r) => setTimeout(r, 0));
                  if (!e.refs) return;
                }
                const j = i * 14;
                p.fromArray(d, j);
                s.fromArray(d, j + 3);
                q.fromArray(d, j + 6);
                c.setRGB(d[j + 10], d[j + 11], d[j + 12]).convertLinearToSRGB();
                packed.pushSplat(p, s, q, d[j + 13], c);
              }
              packed.needsUpdate = true;
            }
            if (
              source.getNumSplats() !== copy.count ||
              (copy.kind === "ext-sh3" &&
                (source as ExtSplats).getNumSh() !== 3)
            )
              throw Error("Spark source count/SH mismatch");
          } finally {
            e.settled = true;
            if (!e.refs) {
              source.dispose();
              retained.delete(e);
            }
          }
        })();
        // Lease caller observes rejection; this prevents an orphaned rejection after cancellation.
        e.ready.catch(() => {});
      }
      const e = entry;
      let held: Entry | undefined = e;
      return {
        source: e.source,
        ready: e.ready,
        release() {
          const owner = held;
          if (!owner) return;
          held = undefined;
          if (--owner.refs) return;
          active.delete(owner.key);
          owner.source.dispose();
          if (owner.settled) retained.delete(owner);
        },
      };
    },
    stats() {
      return {
        sourceCount: retained.size,
        ownedBytes: [...retained].reduce((n, e) => n + e.bytes, 0),
      };
    },
  };
}
