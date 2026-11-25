# StageForge Graphics Pipeline, Measurement Probe & Preview Safety

StageForge renders exclusively on Three.js (`0.187.0`) and WebGL2 with zero additional rendering engines or required WebGPU paths.

## Output Pipeline & Controls (Device-Local)

Display quality controls live under **Display & safety** in the top bar (editor and Pitch Viewer) and are stored only on the current device under `localStorage["stageforge.render.v1"]`. They are never serialized into `.stageforge.show.json` files or `.stageforge.zip` bundles.

The post-processing chain preserves `NeutralToneMapping` (exposure `0.96`) and a single sRGB conversion via `OutputPass`:

| Antialiasing (`aa`) | Pass chain | Composer RT samples | Notes |
|---|---|---:|---|
| `auto` / `msaa` | `RenderPass` → optional `ScaledBloomPass` → `OutputPass` | 2 (clamped to `MAX_SAMPLES`) | Default behaviour; default canvas MSAA (`antialias: false`) is off because `OutputPass` draws a single fullscreen quad |
| `fxaa` | `RenderPass` → optional `ScaledBloomPass` → `OutputPass` → `FXAAPass` | 0 | Mutually exclusive with MSAA; `FXAAShader` runs after `OutputPass` on display-referred sRGB values (+1 draw call) |
| `none` | `RenderPass` → optional `ScaledBloomPass` → `OutputPass` | 0 | Lowest offscreen memory and fill rate |

Bloom controls (`bloom`):
- **`auto` / `full`**: full-resolution `UnrealBloomPass` (bright target at 1/2 drawing buffer). Automatically bypassed (`enabled = false`) whenever `bloomStrength <= 0.001` with zero bloom passes executed.
- **`half`**: `ScaledBloomPass` scaling bloom's internal bright and 5 mip targets by `0.5` (bright target at 1/4 drawing buffer; produces wider halos at lower fill cost — not a pixel-parity mode).
- **`off`**: removes and disposes `ScaledBloomPass`, releasing all 11 internal RGBA16F bloom render targets.

## Scenery LOD, Seeded Particles & Falling CO2

- **Scenery LOD (`src/engine/scenicProps.ts`)**: High tier keeps the full original inflatable and star tessellation (`arch` 16,320 tube tris, `tentacle` 19,968 decorative tris, `star` 12,600 tris). Low tier reduces tube subdivisions to `20` sides (preserving 5-rib symmetry) × `6` rows/panel, `6 × 10` suction cups, and `18 × 60` star sectors with zero high-frequency wrinkle (~69–83% triangle reduction). GLB export always reconstructs canonical high-detail scenery regardless of preview tier.
- **Seeded Fixed-Step Particles (`src/engine/ParticleSystem.ts`)**: Smoke, cryo, and haze each draw from independent `mulberry32` streams with a fixed `1/60 s` simulation step (capped at 6 substeps per frame so tab resumes never emit bursts) and sub-frame position interpolation. Capacities are tiered (`high`: 260 smoke / 420 cryo / 36 haze; `low`: 120 / 180 / 18).
- **Falling CO2 (`fallingCo2`, default off)**: A **stylised dense-vapour approximation** (not a fluid simulation) using a two-component exponential jet + cold-sink integrator that arcs up ~2.1–3.1 m, stalls around 0.6 s, sinks back toward the stage deck, and spreads outward along the floor clamp.
- **Video sRGB Decode (`videoSrgbDecode`, default off)**: Three.js `0.187.0` uploads `VideoTexture` linearly and decodes sRGB only in built-in materials, not in custom `ShaderMaterial`s like `LED_WALL_FRAG`. Enabling `videoSrgbDecode` applies `sRGB` EOTF decoding only to video textures on main and secondary LED walls without altering still image textures.

## Preview Flash Limiter & Scoped Safety Claims

By default, StageForge runs a preview-only flash governor (`src/engine/previewFlash.ts`) alongside the shared strobe gates (`src/engine/audioModulation.ts`):
- Caps manual/audio beam, wash, and strobe-bar strobing, procedural laser shader blanking (single shared phase across all projectors), ILDA low-kpps refresh shimmer (steady time-average intensity; scan-rate diagnostics stay unchanged), LED wall `strobe_bars` / beat flashes, rapid blinder taps, blackout recovery, and rapid cue/colour flips at **≤ 3 transitions per second** (holding rapid rises and colour flips across the shared 380 ms refractory window while keeping downward/blackout drops immediate).
- **Physical DMX isolation**: The **Full-rate strobe preview** opt-in is session-only (never persisted), requires an explicit confirmation dialog focused on Cancel, displays an always-visible `FULL-RATE STROBE` badge, is disabled (and cleared if previously enabled) under `prefers-reduced-motion: reduce` and in Pitch Viewer, and **never alters `dmxUniverse1/2` or `physicalDmxU1/U2`**.
- **Scope and limitations**: Automated tests verify bounded behaviour on StageForge's rendered output across the tested strobe, laser, ILDA, LED-wall, blinder, blackout, and cue-change scenarios. **These checks show bounded behaviour, not universal photosensitivity safety.** Uploaded user video, animated ILDA frame geometry, and rapid manual camera movement are outside source-event rate limiting.

## Graphics Measurement Probe (`?probe`)

Loading with `?probe` exposes measurement hooks and `?probe`-only test harness controls (never exposed to normal sessions or the AI bridge):
- `renderStats()`: preserves all existing whole-frame counters (`calls`, `triangles`, `geometries`, `textures`, `programs`, `objects`, `meshes`, `visibleMeshes`, `autoUpdating`, `batching`) with `visibleMeshes` counting ancestor-visible meshes whose layers intersect `camera.layers`.
- `graphicsProbe()`: reports `drawingBufferSize`, `cssSize`, DPR, `tier`, `backend`, `contextAntialias`, `composerSamplesEffective`, `activePasses`, bloom allocation/activity, particle counts/caps, ILDA segment counts, `submittedMeshes` (draw-submitted `Mesh` objects, counting an `InstancedMesh` as one submitted mesh), and `renderTargetBytesEstimate`.
- `measureFrames({ warmupFrames, sampleFrames, gpu })`: collects zero-allocation preallocated CPU sub-phase timings (`simMs`, `crowdMs`, `particlesMs`, `batchSyncMs` subtracted from `renderSubmitMs` so nothing is double-counted), upload byte estimates, and optional asynchronous non-blocking WebGL2 `EXT_disjoint_timer_query_webgl2` timings (started only after warm-up frames complete, rejecting disjoint epochs, never calling `gl.finish()`).
- `?probe`-only test controls (`setRenderSettings` in-memory without writing `localStorage`, `setFullRateStrobePreview`, `resetParticles`, `stepAndReadLuminance`, `patchShowState`, `setProbeBump`, `loadIldaClip`) drive automated regression benchmarks without altering persisted device preferences.

Keep SwiftShader correctness runs, 4× CPU-throttled desktop runs, laptop hardware runs, and real phone measurements separate; CPU throttling in headless Chrome does not emulate a phone GPU.
