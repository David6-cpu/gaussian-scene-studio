# Gaussian Scene Studio

**Asset-guided AI selection, reproducible procedural placement, and unified Gaussian splat rendering.**

[中文](README.md) · [Local models](docs/LOCAL_MODELS.md) · [Third-party notices](THIRD_PARTY_NOTICES.md) · [SH import option](docs/SH_IMPORT.md)

An undergraduate research prototype that turns natural-language requirements into reviewable asset choices and scene recipes. Procedural rules place the assets, and a browser renders, explores and saves the result. **A small wetland scene is the currently validated use case.**

The research focuses on constraints, selection from a real catalog, missing-asset handling and reproducible layout. It uses existing language models and third-party scans; it does not train a foundation model or reconstruct an arbitrary new 3D world directly from a prompt.

## Workflow

Natural-language request → editable requirements → catalog candidates → LLM selects candidate IDs → independent validation → human approval → deterministic PCG → Gaussian rendering → local records and scene archive.

Missing resources are reported. Procedural substitutes are identified and require confirmation. Valid JSON alone does not establish that the model understood the request.

## What works today

- A catalog with seven entries: four trial assets and three compatibility entries, including provenance, licensing, source type and point budgets.
- Two-stage local AI selection: editable requirements, candidate retrieval, selection of existing IDs and explicit approval.
- Seeded placement with boundary, water-level, slope, spacing and support checks, including shortfall reporting.
- One Spark rendering pipeline for a scanned Riverside surface and procedural grass/reeds, stones and static water.
- Local selection/plan records and self-contained scene ZIPs with version-specific validation.
- An explicit offline SH3 range-correction option that preserves the native path and does not replace default assets.

The Riverside crop contains 64,949 SH3 Gaussians. Its 4×4 area uses display units, not a surveyed metric scale. Scenes are limited to 20 instances and 250,000 active Gaussians.

## Run without a model

From the project root:

```sh
npm ci
npm run dev
```

Open <http://127.0.0.1:4173/> in a WebGL2-capable desktop browser. Use manual controls or the offline planning example. Drag to orbit, right-drag to pan, and scroll to zoom. Save a scene ZIP and reopen it locally.

Validated development environment: Node 25.7.0, npm 11.10.1, macOS / Apple M5 with 16 GB memory, and Google Chrome. Other platforms have not received equivalent validation.

No model weights are bundled. A message that the app used a default fallback means the input was not interpreted by a model.

## Enable local AI

The tested setup uses **Qwen2.5-3B-Instruct Q4_K_M with llama.cpp**. Follow the [local model instructions](docs/LOCAL_MODELS.md), start the local service, and open <http://127.0.0.1:4173/?planner=3b>. The current prompts and UI are primarily Chinese; equivalent English-language behavior has not been validated.

The Mac `.command` shortcuts depend on the original development machine's existing Homebrew runtime and verified weights. They do not install dependencies or download a model. Use manual setup on another machine.

The 3B model uses the **Qwen Research License for non-commercial research/evaluation**. The 7B configuration has a different license and must not be treated as interchangeable. See [third-party notices](THIRD_PARTY_NOTICES.md).

## Structure

| Path | Responsibility |
|---|---|
| `src/selection/` | Two-stage requirements and candidate selection |
| `src/planner/` | Local model adapters, planning and version records |
| `src/assets/` | Catalog, procedural assets and placement |
| `src/terrain/` | Terrain, water and height proxies |
| `src/gaussian/` | Spark rendering, resource lifecycle and point budgets |
| `src/io/` | Scene archives, hashes and SH3 variant packages |
| `scripts/` | Local launchers and offline asset preparation |
| `public/` | Attributed runtime and diagnostic assets |
| `tests/` | Browser checks and repeatable fixtures |

TypeScript, Vite, Three.js, Spark, Vitest and Playwright form the main stack. Versions are pinned in the lockfile. The local planning API runs with the Vite development/preview server; a static host alone does not provide model inference.

## Checks

```sh
npm test
npm run typecheck
npm run build
npm run test:e2e
```

Browser tests require installed Google Chrome and exclusive use of local port 4173. Stop any manual development server first.

Latest code-baseline checks, 2026-10-04: 327 unit tests, eight launcher tests, type checking and build passed. The optional SH3 import also passed real-browser save/reopen comparisons. These are bounded engineering results, not general language, final image quality or long-term performance guarantees. The build still reports a large-chunk warning.

## Limits and next steps

Only the wetland flow is validated. Snow mountains, rainforests and arbitrary multi-environment composition are not available. The catalog is small, and model interpretation of negation, source preferences and water levels can fail.

Scans retain softness, crop boundaries and coverage gaps. SH correction mostly changes color/tone. Height proxies are engineering approximations: splats do not automatically provide physics, editable objects or species labels.

Next steps are qualified assets, a second environment with explicit content/version handling, fixed-budget selection/layout experiments, and educational hotspots with learning evaluation. These are research goals, not delivery commitments.

Weights, personal scene saves, large raw scans, private experiment records and machine logs are excluded from source distribution. The offline SH3 variant package is separate from the app's main scene ZIP format.

## Licensing

No project-wide open-source license has been selected for original code. Dependencies, models and assets retain their own licenses; this is not a blanket MIT-licensed asset collection.

Thanks to Spark, Three.js, Qwen, VeryOS, Marcel Padilla and Loop CE. Runtime and diagnostic scans retain source, CC BY 4.0 attribution and modification notices. See [third-party notices](THIRD_PARTY_NOTICES.md).
