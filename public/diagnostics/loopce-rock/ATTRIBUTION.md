# Loop CE Rock — source and crop attribution

- Creator / attribution party: **Loop CE**.
- Title: **Rock**, smartphone photographic capture and Gaussian reconstruction; external material, not this project's own capture or wetland soil.
- Dataset and license declaration: https://loopce.com/gaussian-splats . This page explicitly lists Rock in its dataset, describes smartphone captures, and links its dataset-wide usage terms to **CC BY 4.0**.
- License: Creative Commons Attribution 4.0 International, https://creativecommons.org/licenses/by/4.0/ ; legal code https://creativecommons.org/licenses/by/4.0/legalcode . No endorsement by Loop CE is implied. The license gives no warranties; preserve attribution, license link and changes in reuse.
- Pinned repository revision: `f8c5eeae5ff5410dc537a27762c8927ba2fd29a2`.
- Original supplied SPLAT: https://huggingface.co/datasets/loopce/gaussiansplats/blob/f8c5eeae5ff5410dc537a27762c8927ba2fd29a2/rock/model/point_cloud/iteration_30000/point_cloud.splat
- Original byte size **234,855,616**, **7,339,238** records; SHA-256 `c6999cae22a6da0ccac6a8964af04d4d219266aac075930769557ab13d3603a2`. Downloaded and hash-verified 2026-10-02.

## This derivative

`rock-patch.splat`: **6,312,032 bytes / 197,251 records**, SHA-256 `f3eec340ceae43a6bae8ad60294f5863b90fe78606c81f88ceb7c645df7b967c`.

Continuous frustum crop of the rock's upper surface, located using the author's `rock/images/0001.png`, frame/image ID 1 and PINHOLE intrinsics. Reference camera-space depth is 4…5.3 in non-metric reconstruction units. Core reference-photo pixels: x=320…730, y=720…900; outer crop x=290…760, y=690…930. Exact camera rotation, translation and focal lengths are in `source-meta.json`.

Retained **153,269** core records plus **43,982** margin records; excluded **7,141,987** records outside the selected region. Kept **2.6876%** of the full dataset, including **19,422 zero-opacity** records inside the region. No opacity filtering or random decimation was applied. Every retained 32-byte record is copied unchanged in its original order, including position, sigma, quantized quaternion, display RGB and alpha. This is local original density, not the complete original scene. A finite 30-pixel margin cannot guarantee every Gaussian tail or complete geometry at arbitrary angles.

The full source remains in the local research evidence directory and is never loaded into the browser. The application displays only this bounded crop as one static source, with no scene instances or LOD.

Display transform only: rotate 180 degrees about X, center the rotated horizontal bounds and lower Y bound, then apply one uniform scale to set the largest horizontal center extent to 1. Position and covariance orientation are rotated together; all sigmas receive the same scale. No vertical flattening, recoloring, fog, invented texture, photo overlay or relighting. This is a chosen display orientation consistent with the photographed upper surface, not measured gravity or a metric calibration.

## Format and fidelity limits

The author's supplied `.splat` export has fixed RGB/alpha and 8-bit rotation components; it has no SH coefficients. A 4096-byte HTTP range read of the author's original 1.82 GB PLY header confirms the same 7,339,238 vertices and 45 `f_rest_*` properties. We did not download that PLY, convert it ourselves, or preserve its directional SH appearance through this SPLAT path. Image loss relative to the full PLY is **not measured**. The retained SPLAT records have no additional quantization or thinning introduced by this project.

Lighting/shadows already present in the reconstruction remain baked into its colors. Crop edges, transparency and source reconstruction artifacts remain visible. This asset does not establish full wetland quality, new lighting correctness, ecological facts or reliable collision geometry.

`reference-0001.png` is an unchanged author photo, **4,981,722 bytes**, SHA-256 `73af76687516f12312207ffeaf325e8e2c7ac7f96968eba35762c95df764f77c`, from the same pinned dataset `rock/images/0001.png`. It is credited to Loop CE under the dataset license. It is a source reference, not an exact-camera output-quality score for the normalized diagnostic views.

## Optional cleanup candidate (2026-10-02)

The original `rock-patch.splat` above remains unchanged and is the default. The optional diagnostic cleanup removes exactly 46 records whose maximum sigma, multiplied by the original display scale 0.6345178724708489, exceeds 0.08. It retains 197,205 records, in the original order with retained fields unchanged, using the original crop's display transform rather than fitting new bounds. No color, alpha, anisotropy or semantic filter is used. Source-relative threshold: 0.1260799789428711.

The candidate reduces broad floating color patches but retains fine spikes and crop edges; low-frequency color/occlusion also changes, so it is not lossless restoration. Full original-crop indices, rule and the equivalent retained-record SPLAT SHA-256 `c652f038f7d2f83ac25bbb2d017ec506bd79f57c6e2a4bb4907ff07d1f3f4677` are in `cleanup-meta.json`. The application reads and verifies the original crop, transforms it, then filters a copy; no second full-scene download is made. Continue to credit Rock / Loop CE / CC BY 4.0 and note the crop, display transform and optional removal in reuse.
