# Starter library — admission record (2026-10-19)

`starter-library/` is the bundled general-scene library. The planner server
loads it automatically when `GENERAL_SCENE_CATALOG` is not set, so a fresh
install can plan, preview and save a scene without the private `.local`
library or the local model. A configured catalog always takes precedence.

## Decision

On 2026-10-19 the project owner reviewed the candidate inspection captures
(`.local/general-asset-reviews/2026-10-10T14-27-18.718Z/`, front views shown in
the session) and approved:

- admitting rock, low grass, reed and the surface style as **starter examples**;
- labelling them as procedural examples, not captures;
- redistributing them together with this project.

The review records in `starter-library/index.json` carry
`evidenceKind: "human"`, reviewer `Project owner`, timestamp
`2026-10-19T14:00:00.000Z`, and bind the exact member hashes.

## Contents

| ID | Category | Content version | Derived from candidate |
| --- | --- | --- | --- |
| `starter-rock-v1` | rock | `sha256-91d27dc7db59c092c623a91ed87a06f2c2bfc89d1e7b1d4c6c65ca5403cdfc3a` | `river-props-rock-seed20261010` |
| `starter-low-grass-v1` | grass | `sha256-fc1fbc30c618061ccbf47c15947694151e4d400f1d750e6af10a49163df82d84` | `river-props-low-grass-seed20261010` |
| `starter-reed-v1` | reed | `sha256-590ed93b907b9ab3fe172f1041cefaa782635e96d58fbf6d843b07e8f234afae` | `river-props-reed-seed20261010` |
| `starter-surface-v1` | surface style | `sha256-5ee7dfadf6a5b45b597e9ac89653910aeb7ee2d4ece4fe272a162c61baa9bc1f` | `general-surface-inspection-v1` parameters |

Point data is regenerated from `src/assets/river-props.ts` (seed `20261010`)
and is byte-identical to the reviewed candidates; the build script refuses to
run otherwise. The surface style uses exactly the parameters of the
2026-10-13 surface inspection run. New IDs and content versions follow from
the new license and admission metadata; the original candidates in `.local`
are unchanged.

## What admission enables

- Objects: `place`, `rotate` (upright yaw; SH degree 0, so rotation is
  colour-safe) and `remove`; fixed scale 1; slopes up to 10°.
- Viewing distance: from the recorded minimum-distance camera up to 15 display
  units; directions are the front/back/top/low review cameras.
- Both LODs are marked `passed` on the basis of this approval.
- Style: `browse`; inspection views are the flat, slope and mild-river captures.

## Limits

- These are stylised procedural stand-ins. Admission makes the end-to-end flow
  usable; it is not a photographic-quality or realism pass.
- Only the inspection cameras were reviewed. Contact error on uneven terrain,
  large scenes and other viewing angles were not separately measured.
- No trees and no captured assets are included. Requests for them still show
  the missing-asset hint.

## Rebuild

```sh
rm -rf starter-library
node scripts/build-starter-library.ts --from .local/general-scene-library --out starter-library
```

The script needs the candidate manifests and review captures in `.local`;
it validates the result with the same strict loader the server uses.

## Verification

- `src/general-scene/server.test.ts`: fallback to the starter library, and the
  shipped library loads with accepted, redistributable entries.
- Manual run on a fresh dev server without `GENERAL_SCENE_CATALOG`: 手工设置
  with no water, 3 rocks and 5 low grass → 设置检查通过 → 预览已显示 → 已保存.
