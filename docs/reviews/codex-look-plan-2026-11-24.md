# Codex look plan: a much better default look (gpt-6-astra), 2026-11-24

A read-only consult (Codex, model `gpt-6-astra`). It read the code and ran nothing, so every budget below is a proposed acceptance ceiling, not a measurement. `T/` in its references means the Three.js 0.187.0 package in `node_modules`.

**Spot-checked by Claude Code against the repo on 2026-11-24:** the legacy strobe runs at `3.5 + 24 x strobe` Hz (`src/engine/StageEngine.ts:2339`) and the laser blanking flicker at `4 + 26 x strobe` Hz (`src/engine/shaders.ts:162`), with the audio flash limiter (`audioModulation.ts`, 334 ms refractory) covering only audio-triggered flashes; the deck is a `MeshStandardMaterial`; the fog update each frame sets density; `StageScreens.ts` sets the video and image colour space to sRGB. **Not verified:** the Three.js internals it cites, the video-decoding mismatch, the mip-chain and PMREM memory figures, and whether anything upstream already clamps `effectiveStrobe`. The implementing agent must verify those before relying on them.

---

Build the look around **neon architecture, broken wet-floor highlights and coloured depth**, with dark space between them. Post-processing should support that composition.

This was an offline, read-only source audit; no rendering or tests were run. **All budgets below are proposed acceptance ceilings.** Engine references are relative to `src/engine`. `T/` denotes the locally verified Three.js 0.187.0 installation.

1. **Ranking.**

| Rank | Effect | Return per millisecond / implementation effort |
|---|---|---|
| 1 | Bloom and emitter brightness hierarchy | Excellent / very small: retain coloured cores, controlled halos and readable blacks. |
| 2 | Continuous architectural neon framing | Excellent / medium: stage lip, side wings and screen frames provide the strongest immediate cyberpunk silhouette. |
| 3 | Broken glossy deck highlights | High / small after Sprint 18: broad reflections interrupted by puddle/scuff roughness. |
| 4 | Restrained coloured atmospheric depth | Good / small globally; expensive if extended into local volumetric lighting. |

Cut chromatic aberration, animated grain, beat-reactive decorative brightness, a global teal/magenta grade, rain and scanning grids. These spend clarity, safety margin or implementation effort without strengthening the central composition.

2. **Check the draft.**

- **Output and grading:** the renderer selects Neutral tone mapping, exposure `0.96` and sRGB output; the chain is render → bloom → OutputPass (`StageEngine.ts:421`, `StageEngine.ts:482`). Ordinary offscreen rendering skips renderer tone mapping (`T/src/renderers/WebGLRenderer.js:2414`); OutputShader performs Neutral mapping followed by sRGB encoding (`T/examples/jsm/shaders/OutputShader.js:81`, `:91`). **A grade can merge into a locally extended OutputPass**, between those operations. It does not require another draw. A separate pass after unmodified OutputPass receives encoded display colour and must handle that explicitly.

- **Colour accuracy:** a fullscreen luminance mask cannot reliably distinguish dim authored emitters from shadows. Split toning therefore conflicts with “never remap authored colours.” Prefer neutral output and colour the environment/materials instead. True colour must bypass cosmetic tinting and bloom, while retaining a documented exposure/tone-map pipeline. Neutral itself compresses and desaturates bright values, so “RGBW retains exact authored colour” is an invalid acceptance rule (`T/src/renderers/shaders/ShaderChunk/tonemapping_pars_fragment.glsl.js:170`).

- **PMREM:** feasible—and substantially already present. Blue/purple planes and an HDR softbox generate the existing environment (`StageEngine.ts:435`). The deck already uses `MeshStandardMaterial`, metalness `0.08`, roughness `0.55` (`geometryBuilders.ts:127`). Replace that environment’s composition rather than adding another. It produces distant lighting reflections, **not position-correct reflected fixtures or video**. This Three version enforces at least 256-pixel cube faces; its half-float filtered target is approximately **4 MiB**, excluding generation scratch resources (`T/src/extras/PMREMGenerator.js:22`, `:271`, `:472`). A second PMREM breaks the draft’s 1 MiB allowance.

- **Neon batching:** instancing does not mean zero additional draws. Groups require compatible materials and identical geometry; each group creates an InstancedMesh (`renderBatcher.ts:369`, `:416`). The registered shader proxy specifically matches beams (`beamProxy.ts:8`; `StageEngine.ts:431`). A deck strip already exists, but only outside the authored-platform branch (`StageEngine.ts:1279`, `:1295`). Tune existing strips or explicitly budget **one shared neon batch**; do not promise free universal tubes.

- **Video floor spill:** VideoTexture defaults to linear filtering and **no mipmaps** (`T/src/textures/VideoTexture.js:36`, `:57`); neither loading path enables them (`StageScreens.ts:137`; `StageEngine.ts:1103`). GPU low-mip sampling requires generating those levels first. A 1080p RGBA8 mip chain adds approximately **2.64 MiB** beyond its base texture. Reusing video avoids additional spill-specific uploads/readback, not existing video-frame uploads. Independent wall textures also need bounded sampler selection or an atlas. The proposed spill batch plus separate grade already exceeds one added draw. Existing spill instead uses primary/accent colours (`StageEngine.ts:2901`).

- **Important missing correction:** video/image colour equivalence is suspect at source level. Three stores sRGB video without hardware sRGB decoding (`T/src/renderers/webgl/WebGLTextures.js:233`, `:1002`), while the custom wall shader samples directly (`shaders.ts:459`). Add conditional video decoding; ordinary sRGB images must not be decoded twice. Verify with intermediate greys and colours, not only RGBW.

- **Fog/haze:** fog starts as `FogExp2`; its dark-blue colour is overwritten every frame, while density follows haze (`StageEngine.ts:433`, `:2317`, `:2955`). Particle haze already receives primary/accent tint (`StageEngine.ts:2950`; `ParticleSystem.ts:170`). Fog colour can follow an intensity-weighted fixture palette with zero draws, but it remains global—not locally beam-lit. Keep it dark, filter independently of strobe gates, and preserve original beam colours.

- **Scope/settings:** device-local flags do not automatically preserve exports: GLB snapshots clone live materials (`stageGlb.ts:50`). Explicitly exclude cosmetic geometry/material overrides. The draft’s low-tier rules conflict, and “no performance regression” conflicts with allowing positive incremental costs (`HANDOFF.md:847`, `:852`, `:855`, `:864`, `:867`). Resolve both before implementation. Its screenshots, lifecycle tests and accessibility controls are appropriate requirements, not evidence that the design works.

3. **What is missing.**

The strongest addition is **visual composition**: fewer, longer luminous lines; contrasting dark surfaces; readable coloured cores; highlights that establish depth.

Additional candidates below have speculative ceilings, not cumulative allocations:

| Candidate | Phone / laptop Δms | Added MiB | Decision |
|---|---:|---:|---|
| Better neon typography on existing wall | 0.10 / 0.05 | 0, reuse texture | Worth testing; typography already exists (`StageEngine.ts:976`; `shaders.ts:447`). Preserve custom media. |
| Two holographic signage planes, shared 256² atlas | 0.25 / 0.12 | ≤0.34 | Defer; normally another draw and transparency work. |
| Derivative-filtered floor grid | 0.15 / 0.08 | 0 | Static only; reject scanning as default visual clutter. |
| Sparse drizzle/streak layer | 0.60 / 0.25 | ≤0.10 | Cut: overdraw, shimmer and near-camera distraction. |
| 16³ RGBA8 LUT in output shader | 0.20 / 0.10 | 0.016 | Technically cheap; reject colour remapping without a demonstrated need. |

Light shafts already have shared atmospheric noise, directional scattering and prism shafts (`shaders.ts:15`, `:96`). Improve those through Sprints 16/20/21 rather than adding another volumetric system. Bloom radius tuning changes the weighting of existing blur scales, not their count (`T/examples/jsm/postprocessing/UnrealBloomPass.js:101`, `:510`).

4. **Revised build slices.**

All flags are development controls; passing effects become defaults.

| Slice / flag | Files to change | Dependencies | Phone / laptop Δms | Added MiB low/high |
|---|---|---|---:|---:|
| A. Colour/output foundation — `lookOutput` | `StageEngine.ts`, `StageScreens.ts`, `shaders.ts`, local output-pass extension, `App.tsx`, settings UI | S15 | ≤0.20 / 0.10 | 0 / 0 |
| B. Neon architectural framing — `lookNeonFrame` | `StageEngine.ts`, `geometryBuilders.ts`, `renderBatcher.ts`, `stageGlb.ts` | S15 | ≤0.30 / 0.15 | ≤0.10 / 0.10 |
| C. Wet deck composition — `lookWetDeck` | `hardwareMaterials.ts`, `geometryBuilders.ts`, `StageEngine.ts`, `stageGlb.ts` | S15, S18 | ≤0.25 / 0.15 | 0 / 0 incremental |
| D. Coloured depth — `lookAtmosphere` | `StageEngine.ts`, `ParticleSystem.ts`; integration checks in `beamPools.ts`, `ildaRenderer.ts` | S15; S20 for local puff lighting | ≤0.20 / 0.10 | ≤0.01 / 0.01 |

**A:** Fix media decoding; tune bloom against dark and bright shows; add device-local True colour and Reduced effects. Avoid global split toning. Tests: grey ramps, intermediate colours, image/video equivalence and approved LED/core/halo regions. Main risk: compensating for an incorrect colour pipeline with brightness adjustments.

**B:** Use one capped shared batch, initially 128 low/512 high instances. Avoid outlining every truss member. Cover both legacy and authored platforms. Tests: approved FOH/wide framing regions, blackout, close-up aliasing, batching parity and unchanged exports. Main risk: decorations appearing to be authored equipment.

**C:** Reuse Sprint 18 textures and replace the existing PMREM during initialization; no second environment. Start with mostly neutral narrow strips, letting authored lighting supply colour. Vary roughness spatially rather than making everything mirror-smooth. Tests: approved grazing-angle deck regions, camera sweeps, seams and resource accounting. Main risk: plastic-looking surfaces or implausible fixed highlights.

**D:** Use a two-second time constant for low-intensity ambient tint; retain dark negative space and unchanged particle caps. Tests: approved beam-crossing/haze regions, opposing colours, zero haze, blackout and cue transitions. Main risk: uniform coloured fog obscuring authored colours.

Combined ceiling: **0.95/0.50 ms, 0.11 MiB, one added draw, zero added fullscreen passes**. S16/17/19/21 require integration regression checks, not blanket implementation dependencies.

For every slice: approve fixed-seed FOH, deck-close and wide references with localized regions; test toggles, resize, media replacement and disposal. Current tests compare same-run whole-image averages, which cannot approve art direction (`tests/e2e/render-budget.spec.mjs:140`). Measure repeated warmed p50/p95/p99 and asynchronous GPU timings at 390×844/4× CPU and fixed laptop resolution/DPR. SwiftShader is currently configured and must remain separate from hardware results (`playwright.config.mjs:16`). CPU throttling does not emulate a phone GPU.

Reduced effects keeps static framing and basic sheen, reduces bloom, and freezes decorative motion. Promote only after visible owner-approved improvement and combined-budget acceptance.

5. **Safety.**

The stated universal flash protection is **not present in this checkout**: audio modulation has a 334 ms refractory gate, but legacy strobes run at `3.5 + 24×rate` Hz and laser shaders at `4 + 26×rate` Hz (`audioModulation.ts:23`; `StageEngine.ts:2339`; `shaders.ts:162`). Close those bypasses before claiming global protection.

Add no decorative flashing or beat-driven brightness. Two-hundred-millisecond smoothing alone proves nothing. Test final rendered luminance and saturated-red transitions, affected area, and rolling one-second flash counts after bloom across cue changes, overlapping effects and irregular frame times.

Cap halo coverage; test black-level visibility and small bright regions. For near-eye views, fade decorative emission before it fills the view; verify camera intersections and both eyes when XR arrives. Reduced-motion tests must show frozen decorative motion. These checks demonstrate bounded behaviour, not universal photosensitivity safety.