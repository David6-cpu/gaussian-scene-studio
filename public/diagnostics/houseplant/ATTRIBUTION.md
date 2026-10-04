# Houseplant — attribution and diagnostic changes

- Title: Houseplant
- Creator: Marcel Padilla
- Source: https://github.com/marcelpadilla/splats/tree/c3e5ec0a8ddb3ab26f28a067a29d272fe1a23411/data/plant
- Author's visual gallery: https://marcelpadilla.com/Gaussian_Splat_Object_Dataset/
- License: Creative Commons Attribution 4.0 International (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/
- Pinned source commit: `c3e5ec0a8ddb3ab26f28a067a29d272fe1a23411`
- Downloaded and verified: 2026-10-02
- The repository's license explicitly covers the author's `plant` photographic capture and reconstruction. The unmodified license text is included as `SOURCE-LICENSE.txt`, with its disclaimer of warranties. Per-object metadata is retained as `source-meta.json`.

`plant.splat` is an unmodified copy: 3,636,736 bytes, 113,648 records of 32 bytes each.
SHA-256: `ce9d490b18f16d6730d832227bf541431b8b1a5d167c5a3fe89af4f324c0d8fd`.

This is an external licensed indoor houseplant scan. It is not a wetland species identification, not a scan captured by this project, and not an endorsement by the creator.

Diagnostic rendering changes: decode positions/scales and RGBA; reorder and normalize the quantized wxyz rotation to xyzw; convert display RGB into the existing renderer's linear-RGB input convention (the renderer converts it back once); rotate 180 degrees about X to change source -Y up to +Y up; shift the centered height interval [-0.5,0.5] to [0,1]. The general diagnostic centering/height normalization has scale **1** for this specific asset. All source primitives, opacity and colors are retained; no pruning, recoloring, fog or geometry synthesis is performed. Screenshots and orbit video show these display transforms with a neutral background and annotations. The original binary is not rewritten.

Source limitations retained: SH degree 0 / no view-dependent shading; COLMAP reconstruction scale is not metric. Source metadata gives no PSNR/SSIM quality score. Fine close-up detail and unseen surfaces remain limited by the supplied asset.

Format reference (read for implementation, not downloaded or executed): https://github.com/antimatter15/splat/blob/main/convert.py . The diagnostic adapter is separate from the project's deterministic F0 scene-bundle importer.
