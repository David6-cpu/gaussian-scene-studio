# Gaussian Scene Studio

### From a scene idea to a reviewable, explorable wetland

An undergraduate research prototype for ecological education: natural-language requirements, an attributed asset catalog, procedural placement and Gaussian Splatting, with inspectable choices and reproducible results.

[中文](README.md) · [Local models](docs/LOCAL_MODELS.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)

![Concept diagram: catalog-based construction and local environment import lead to browsing; educational interaction remains planned](docs/images/project-concept.svg)

> **Research prototype.** Catalog selection, reviewable layouts and local SPZ import are implemented. External whole-world generation is not integrated. Real riverbank visual quality, knowledge hotspots and learning outcomes remain unverified. The diagram is a research concept, not generated output.

## Research questions

A request such as “a riverbank with low grasses and stones” raises concrete questions: is the river present, do plants obscure it, are stones scanned or procedural, and can the terrain support the layout?

- **Reviewable intent:** editable requirements, visible conflicts and missing resources, followed by human confirmation.
- **Reproducible results:** asset identity, seeds, versions and camera state retained through local saves.
- **Educational interaction:** future knowledge hotspots and exploration tasks on manually reviewed scenes, followed by learning evaluation.

Our work concerns constraints, knowledge organization, interaction and evaluation. Foundation models, world-generation backends and scans come from existing third-party work.

## Actual browser previews

![Actual Riverside scan crop with procedural static water](docs/images/riverbank-preview.png)

**Riverbank candidate — actual screenshot.** Riverside is by [VeryOS](https://superspl.at/scene/8f52baf1), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), used as an attributed continuous crop. Water is procedural Gaussian data. This controlled preview is not evidence of successful prompt-to-world generation. Scan softness, flat water and clipped boundaries still fail visual acceptance. [Results](docs/validation/riverbank-review-preview-results.md)

| Local environment import | Original scene restored |
|---|---|
| ![Three-point coordinate fixture, not a real riverbank](docs/images/environment-fixture.png) | ![Procedural wetland baseline restored after leaving the imported environment](docs/images/current-workbench.png) |
| World JSON + SPZ → preview → save → reload/reopen. These points are a **self-authored fixture**, not a generated riverbank. | Cancel/return preserves the scene and camera. This image shows the **procedural baseline**. |

[Import evidence](docs/validation/environment-import-results.md) · [Image provenance](docs/images/README.md)

## Current progress

Documentation updated **2026-10-08**; engineering checks below were completed on 2026-10-07.

| Area | Implemented | Remaining limits |
|---|---|---|
| Catalog and local AI | Seven entries: four trial assets and three compatibility entries; editable requirements, candidate IDs, source confirmation and missing-asset feedback | Small catalog; arbitrary language and cross-environment behavior unverified |
| Procedural placement | Seeded layouts with boundary, water-level, slope, spacing and support checks; shortfalls reported | Height proxies are not exact collision or ecological validation |
| Riverbank review / water intent v2 | Cancellable previews and save-on-use; required water separated from a known numeric level | Unknown geometry stays pending; the original request has not produced an accepted scene end to end |
| Local environment import | World JSON + SPZ; preview/cancel, IndexedDB save/reopen and `.wetenv` backups | No integrated paid generation; real-asset quality and large-scene performance unverified |
| Versioned assets | Legacy archives, controlled ground admission and optional offline SH3 range correction | No silent replacement; color corrections do not repair geometry |
| Ecological education | Wetland theme and interaction direction selected | Hotspots, exploration tasks and teaching evaluation are future work |

Import supports **gzip SPZ v2/v3, SH0–3**, up to 250,000 points, 64MiB source bytes and 32MiB streamed expansion. SPZ v4 is rejected. Start with a 100k asset. Storage permits eight environments / 128MiB total source bytes. A successful save does not establish visual quality.

Catalog scenes allow 20 instances and 250,000 active Gaussians. The Riverside crop has 64,949 SH3 Gaussians; its 4×4 extent uses display units, not surveyed meters. Whole-environment splats do not automatically provide editable objects, species labels or collision.

## Run locally

Requires Node.js, npm and a WebGL2 desktop browser. Tested on Node 25.7.0, npm 11.10.1, macOS / Apple M5 16GB and Google Chrome. Other platforms have not received equivalent validation.

```sh
npm ci
npm run dev
```

Open <http://127.0.0.1:4173/>. Use manual controls or the offline planning example without a model. Drag to orbit, right-drag to pan and scroll to zoom. Scene ZIPs can be saved and reopened locally.

The environment panel accepts a local World JSON and SPZ. Preview before saving or downloading a `.wetenv` backup. Scene ZIPs and environment backups are different formats. Importing SPZ does not call a generation service.

### Optional local AI

The tested setup is **Qwen2.5-3B-Instruct Q4_K_M + llama.cpp**. Follow [setup instructions](docs/LOCAL_MODELS.md), then use `/?planner=3b`. The riverbank review candidate is at `/?review=1&planner=3b`. Prompts and UI are primarily Chinese; equivalent English behavior is not validated.

No weights or provider keys are bundled. A default-fallback message means the request was not interpreted by a model. Procedural grasses, reeds and added stones cannot silently satisfy a request for scanned assets.

Mac `.command` shortcuts require the original machine's existing runtime and verified weights. They do not install a runtime or download models. Configure a new machine manually.

**Qwen 3B uses the Qwen Research License for non-commercial research/evaluation.** Do not apply the 7B model's Apache-2.0 license to it. [Notices](THIRD_PARTY_NOTICES.md)

## Structure and validation

| Path | Responsibility |
|---|---|
| `src/selection/`, `src/planner/` | Requirements, catalog selection and local model adapters |
| `src/review-v2/` | Water intent and versioned review contracts |
| `src/environment/` | SPZ validation, preview lifecycle, storage and backups |
| `src/assets/`, `src/terrain/` | Catalog, procedural assets, placement and terrain proxies |
| `src/gaussian/`, `src/io/` | Spark rendering, lifecycle and versioned archives |
| `scripts/`, `tests/` | Local tooling, browser checks and fixtures |

TypeScript, Vite, Three.js, Spark, Vitest and Playwright form the stack, with versions pinned in the lockfile. The planning API runs with Vite's development/preview server; static hosting alone does not provide inference.

Checks on 2026-10-07: **514 unit + eight launcher tests, type checking and production build passed; Chrome functional checks: 110 passed / 15 conditional skips.** Eight legacy visual cases were excluded. This does not claim that all browser tests or visual quality pass. Independent review found an initialization timeout/cancellation issue, fixed with regressions observed failing before the fix and passing afterward.

```sh
npm test
npm run typecheck
npm run build
# The functional scope reported above:
npx playwright test --project=functional --grep-invert 'offline river visibility'
```

Browser checks use installed Google Chrome and local port 4173. `npm run test:e2e` includes additional visual cases. A large-chunk build warning remains.

[Environment import](docs/validation/environment-import-results.md) · [Water intent v2](docs/validation/water-semantics-v2-results.md) · [Riverbank review](docs/validation/riverbank-review-preview-results.md) · [Controlled ground admission](docs/validation/controlled-ground-admission-results.md) · [SH3 import](docs/SH_IMPORT.md)

## Next research steps

- Validate a real whole-scene SPZ for river, grass and rock appearance and device resource use.
- Compare raw prompts, ordinary expansion and structured constraints with the same backend and budget, using human checks or blinded ratings.
- Add three to five manually curated knowledge hotspots and one exploration task to an accepted scene.
- Extend to wetland plant zones, food relationships and water-quality scenarios.

These are research goals, not shipped features or quality guarantees. Team size, external budget and teaching evaluation remain open.

## Licensing and acknowledgements

Original code has **no selected project-wide open-source license**. Public visibility does not grant blanket MIT terms. Dependencies, models and assets retain their own licenses.

Thanks to Spark, Three.js, Qwen, VeryOS, Marcel Padilla and Loop CE. Distributed assets retain source, CC BY 4.0 attribution and modification notices. Weights, personal saves, provider keys, large raw scans and private logs are excluded. [Third-party notices](THIRD_PARTY_NOTICES.md)
