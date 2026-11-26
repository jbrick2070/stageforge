# StageForge Look — Sprint 23A–D Default Look

Sprint 23 delivers the default cyberpunk-club look without adding a selectable look preset. Slices A (colour and
output), B (neon architecture), C (wet-deck composition), and D (coloured atmospheric depth) are promoted.

## Promoted output foundation

`lookOutput` is a device-local renderer development flag, now promoted on by default after its visual,
lifecycle, export, accessibility, and performance checks passed. It is never written to a show, bundle, MVR,
DXF, GLB, or paperwork export.

- Video displayed through the custom LED-wall shader receives an sRGB EOTF on both the main and authored
  secondary walls. The decode is video-only. A still image keeps the ordinary Three.js sRGB path and is not
  decoded twice.
- Bloom keeps the existing `ScaledBloomPass`: authored show strength is evaluated at `0.72×`, with radius
  `0.26` and threshold `0.74`. The intent is coloured cores, controlled local halos, and readable black space,
  not a different grade. Neutral tone mapping stays at exposure `0.96`, followed by the existing `OutputPass`
  sRGB conversion.
- There is no global teal/magenta grade, LUT, chromatic aberration, grain, rain, scanning grid, or additional
  fullscreen pass.

The controlled browser fixture uses FFmpeg's standard SMPTE intermediate greys and 75% colour bars. On the
final Windows SwiftShader full-gate run, main-wall video/image mean error improved from `20.83` to `2.44`, and the
authored secondary wall improved from `18.65` to `2.34`. Toggling the flag changed the corresponding still image
by at most `4 LSB` (`1.60 LSB` mean) and `0 LSB`, respectively. Lossy video is required to improve within a
tolerance; it is not claimed to be byte-identical to PNG.

## Accessible device-local controls

Both controls are native keyboard-reachable checkboxes under **Display & safety**, have explicit labels and a
polite screen-reader status, and are stored in `localStorage["stageforge.render.v1"]` inside try/catch handling.
They preserve the requested preference while reporting why an automatic policy is active.

- **True colour** bypasses bloom and future cosmetic look effects while retaining exposure, Neutral tone
  mapping, final sRGB output, and the video correctness decode. It does not mutate authored `bloomStrength`.
- **Reduced effects** lowers bloom to half resolution and `0.36×` authored strength. It is automatic on the low
  render tier and when `prefers-reduced-motion: reduce` is active. Slice A introduces no decorative animation to
  freeze; later look slices must consume the same effective policy for any decorative motion they add. Static
  framing and basic deck sheen are intended to remain available.

## Approved references

The left half of each panel is the Sprint 21 output path (`lookOutput=false`); the right half is the promoted
Sprint 23A path. The fixed show state uses static authored cyan/magenta colours and no animated wall media, so
the local core, halo, stage, crowd, and negative-space regions are repeatable.

- [Front of house](looks/sprint23-a-foh-before-after.webp)
- [Deck close-up](looks/sprint23-a-deck-close-before-after.webp)
- [Wide view](looks/sprint23-a-wide-before-after.webp)

Regenerate all three without changing the normal read-only gate:

```powershell
$env:STAGEFORGE_UPDATE_LOOK_REFS='1'
npx playwright test tests/e2e/sprint23-look-output.spec.mjs -g "restrained bloom" --workers=1
```

The three WebP files total 76,644 bytes, below the 600 KB documentation allowance.

## Promoted neon architectural framing

Sprint 23B adds one renderer-only `InstancedMesh`, promoted through the device-local `lookNeonFrame` flag after
its localized visual, lifecycle, export, safety, and repeated-budget checks passed. The batch draws long,
continuous lines rather than outlining production equipment: one exposed stage lip across the legacy deck or
the exposed front edges of authored platforms, a restrained two-line wing at each side, and four-line frames
around the main, stock-wing, and authored secondary screens. The fixed cyan/magenta appearance in the approved
references comes from that show's static `primaryColor` and `accentColor`; no audio, beat, demo phase, strobe,
or clock value enters the shader or palette update.

The batch is capped by deterministic family quotas at `128` instances on the low tier and `512` on the high
tier. It costs at most one draw and adds no fullscreen pass or dependency. Normal premultiplied-alpha blending,
depth testing, a sub-pixel fade, and a `0.40–1.35 m` near-eye fade keep the lines architectural instead of
camera-filling decoration. Blackout and master-dimmer zero hide the batch; intermediate master levels scale
opacity without reallocating it. **True colour** releases its GPU resources; **Reduced
effects**, automatic low-tier policy, and reduced motion retain the framing because it is completely static.
Authored stage geometry, fixture and material colours, show/DMX data, and production materials are not changed.

GLB snapshotting defensively rejects nodes marked `cosmeticLook`, although the batch also lives outside the GLB
root. Browser coverage invokes the actual GLB, DXF, MVR, and patch-paperwork download buttons with the feature
off and on: structural GLB fingerprints, DXF bytes, normalized MVR archive contents, and paperwork bytes remain
invariant. The setting remains absent from show schemas and bundle data.

### Approved Sprint 23B references

The left half has framing disabled and the right half has the promoted static batch enabled. I deliberately
re-approved all three fixed-camera panels after checking that the long lip, side wings, and screen silhouette
remain visible without flattening dark space or disguising the lines as authored fixtures.

- [Front of house](looks/sprint23-b-foh-before-after.webp)
- [Deck close-up](looks/sprint23-b-deck-close-before-after.webp)
- [Wide view](looks/sprint23-b-wide-before-after.webp)

Regenerate the three panels without changing the normal read-only gate:

```powershell
$env:STAGEFORGE_UPDATE_LOOK_REFS='1'
npx playwright test tests/e2e/sprint23-neon-frame.spec.mjs --workers=1
```

The B panels total 67,976 bytes; all six Sprint 23 panels total 144,620 bytes, below the 600 KB allowance.

### Slice B budget and evidence boundaries

The focused promotion run used three alternating warmed pairs at fixed `1280×720` and at `390×844` with 4×
CPU throttling. The post-QA-fix replay measured laptop p50 off `[0.9, 0.9, 1.0] ms` / on
`[0.9, 0.9, 0.9] ms` (median delta `0.00 ms`), p95 off `[1.2, 1.3, 1.4]` / on `[1.1, 1.0, 1.1]`,
and p99 off `[1.2, 1.4, 1.4]` / on `[1.1, 1.0, 1.3]`. Phone-like p50 was off
`[6.6, 6.4, 6.9] ms` / on `[6.6, 6.4, 6.7] ms` (median delta `0.00 ms`), p95 off
`[8.8, 9.6, 9.2]` / on `[8.9, 8.1, 9.9]`, and p99 off `[12.5, 9.9, 11.9]` / on
`[9.5, 9.9, 10.5]`. At the profiler's demonstrated `0.1 ms` CPU resolution, both median p50 costs are zero and
both p95 medians improve; both profiles remain inside B's
`+0.15 / +0.30 ms` ceilings. Slice A measured zero incremental cost, so these are also the measured combined
Sprint 23 A+B CPU deltas, within the combined `+0.50 / +0.95 ms` ceilings.

Asynchronous GPU p50 was laptop off `[139.1031, 139.1762, 139.6883] ms` / on
`[140.6591, 138.9228, 138.1595] ms`, and phone-like off `[68.7131, 70.9737, 68.9992] ms` / on
`[69.8684, 70.6314, 69.7210] ms`. These are ANGLE SwiftShader software-renderer timings, not hardware-GPU
measurements; CPU throttling does not emulate a phone GPU. The one batch owns `11,584 B` on low tier and
`40,768 B` on high tier (`1,856 B` geometry plus fixed matrix/colour attributes), within `0.10 MiB`; A+B remains
within `0.11 MiB`, adds at most one draw, and adds no pass.

Localized changed-pixel fractions were `14.67%` FOH, `18.66%` deck-close, and `8.31%` wide while strong-delta
coverage remained `0.53%`, `0.37%`, and `0.21%`. At a camera intersection, strong-delta coverage was `0.10%`.
Irregular final post-bloom sampling recorded no repeated qualifying transition after activation. These checks,
along with inherited preview-flash limits, show bounded behaviour, not universal photosensitivity safety.

## Promoted wet-deck composition

Sprint 23C replaces the source composition of the one existing PMREM target during engine initialization. The
legacy broad blue, purple, and warm cards become five long, narrow, near-neutral strips against a darker neutral
background. The PMREM target keeps the same descriptor, intensity, construction/disposal lifetime, and room-gain
control; StageForge never retains a second environment. The effect adds no draw, pass, texture, geometry, buffer,
or application-owned GPU byte.

The deck remains the existing `MeshStandardMaterial`. When `lookWetDeck` is active and the independent Sprint 18
`deckSheen` maps are not requested, a material specialization derives conservative spatial roughness
from the already-sampled seeded Marley albedo. Its seams, grain, and scuffs therefore break the grazing strips
without another texture lookup or allocation. If `deckSheen` is explicitly enabled, its registered roughness and
normal maps remain authoritative and retain their original Sprint 18 lifecycle and budget. C does not silently
allocate them.

The strips are deliberately neutral, so **True colour** has no wet-deck tint to remove and retains the physical
material response. **Reduced effects** and reduced motion also retain it because it is static. The automatic
**low tier bypasses C** and constructs the legacy PMREM/material path: the high-tier spatial-roughness shader did
not stay within the phone-like software-renderer proxy budget before that fallback was applied. Authored stage
lights continue to supply the visible cyan, magenta, amber, or other colour through direct PBR lighting. The PMREM
is only a distant-light approximation: it does **not** provide position-correct fixture, LED-wall, video, planar,
screen-space, or ray-traced reflections.

The environment is construction-time owned. Probe A/B tests start a fresh engine for legacy versus wet-neutral
composition; normal resize, rig rebuild, media replacement, simulated context restore, and renderer disposal keep
the same target. A real WebGL context loss destroys PMREM GPU contents, so restore disposes the invalid target first
and rebuilds the same deterministic plan into the single ownership slot; exactly one persistent target exists at
every point. The live probe can isolate the zero-texture material specialization for warmed timing, but it does not
allocate or replace a PMREM target. GLB canonicalizes the deck to its production material, and actual GLB, DXF, MVR,
and patch-paperwork downloads are invariant. In the real context-loss test, the grazing view retained a bounded
`0.0908` mean max-channel pixel delta and whole-image luminance `0.27257 → 0.29079` (`6.68%`) after the deterministic
single-slot rebuild; the probe reported build count `2`, one persistent target, and restored scene ownership.

### Approved Sprint 23C references

The left half uses the legacy environment and the right half uses the promoted neutral-strip composition, with a
fixed rig, authored cyan/magenta state, and fixed cameras. I deliberately re-approved the restrained result: the
deck-close panel shows broken grazing response and scuff/seam variation without turning the whole surface into a
mirror; FOH and wide retain dark negative space and do not imply reflected fixture or wall positions.

- [Front of house](looks/sprint23-c-foh-before-after.webp)
- [Deck close-up](looks/sprint23-c-deck-close-before-after.webp)
- [Wide view](looks/sprint23-c-wide-before-after.webp)

Regenerate the three panels without changing the ordinary read-only gate:

```powershell
$env:STAGEFORGE_UPDATE_LOOK_REFS='1'
npx playwright test tests/e2e/sprint23-wet-deck.spec.mjs --workers=1
```

The C panels total `63,652 B`; all nine A–C panels total `208,272 B`, below the `600 KB` allowance. In the focused
promotion run, changed/strong/mean-delta fractions were FOH `31.25% / 0.021% / 0.01126`, deck-close
`34.82% / 0% / 0.01008`, and wide `39.86% / 0.040% / 0.01130`. A seven-position grazing sweep had a maximum
whole-frame luminance step of `0.01756` in the exact full gate, with no seam pop or fixed full-frame streak
seen in the approved panels.

### Slice C budget and evidence boundaries

Five order-balanced warmed pairs at `1280×720` high tier measured p50 off/on
`[1.6, 1.5, 1.5, 1.5, 1.5] / [1.6, 1.5, 1.5, 1.5, 1.5] ms` (median delta `0.0 ms`), p95
`[1.9, 1.8, 1.7, 2.1, 1.8] / [1.8, 1.9, 1.7, 2.1, 1.8]`, and p99
`[2.0, 2.0, 1.9, 2.4, 1.9] / [1.9, 2.0, 1.9, 2.2, 2.0]`. A newly constructed `390×844` low-tier engine
with 4× CPU throttling exercised the documented bypass: p50 off/on
`[13.3, 11.7, 11.3, 11.3, 10.8] / [12.1, 11.1, 11.0, 11.5, 10.8] ms` (median delta `-0.2 ms`), p95
`[15.1, 13.0, 13.5, 12.9, 12.1] / [14.4, 12.8, 12.5, 12.2, 12.0]`, and p99
`[16.2, 13.7, 16.2, 14.1, 12.2] / [14.8, 13.6, 14.0, 13.0, 12.4]`. Both p50 deltas are below C's
`+0.15 / +0.25 ms` ceilings at the profiler's demonstrated `0.1 ms` resolution.

Asynchronous GPU p50 was laptop off `[191.1592, 190.0736, 190.7711, 191.2755, 192.3307] ms` / on
`[193.8731, 193.0641, 193.7097, 193.9930, 194.1360] ms`, and low-tier phone-like off
`[145.7650, 146.3162, 145.9592, 145.9309, 145.9082]` / on
`[147.1325, 145.8182, 146.1988, 145.7202, 145.8089] ms`. These are ANGLE SwiftShader software-renderer values, not hardware-GPU
measurements; 4× CPU throttling does not emulate a phone GPU. C owns `0 B`, adds zero draws and passes, and leaves
the promoted A+B `40,768 B` / one-draw ceiling unchanged. Using the B receipt's additive A+B delta, the measured
A+B+C total remains below the combined Sprint 23 CPU and memory ceilings.

The C source is static and no flash input exists. Irregular final post-bloom sampling recorded zero qualifying
general or saturated-red transitions after material activation. These checks, the black/clipped-region bounds,
and the inherited preview limiter show bounded behaviour, not universal photosensitivity safety.

## Promoted coloured atmospheric depth

Sprint 23D lets the one existing global `FogExp2` colour follow the intensity-weighted palette of active moving
beam and wash fixtures. The device-local `lookAtmosphere` flag is promoted on by default. The controller reads
the authored per-fixture colour and ungated dimmer after group overrides and demo fades have resolved, then uses
a frame-rate-independent two-second exponential response. Strobe gates, preview flash governors, catalogue flux,
lasers, LED walls, blinders, and strobe bars never enter its palette, so a flashing fixture does not make the
ambient colour pulse.

The colour remains deliberately dark: palette influence is capped at `7.5%` of the existing `0x04060c` base,
linear luminance at `0.025`, and any channel at `0.060`. Opposing colours average by their active fixture
intensity before those bounds. Haze density remains the existing `0.008 + 0.015 × haze`; D changes colour only.
It adds no draw, pass, texture, buffer, dependency, particle, or GPU-owned byte. Authored beam colours and live
DMX stay on their existing paths, and Sprint 20's local beam-lit smoke plus all particle caps remain unchanged.

Zero haze, blackout, master-dimmer zero, and an empty active palette snap immediately to the legacy neutral fog
instead of leaving a slow cosmetic afterglow. **True colour** also uses the neutral fog. **Reduced effects**,
`prefers-reduced-motion`, and the automatic **low tier** bypass D because its cue-following colour is decorative
motion; a fresh low-tier engine therefore reports the requested default but uses the neutral fallback. High tier
uses the slow tint. Resize, rig rebuild, media replacement, simulated/real context restore, and disposal own no D
resource or replacement object. Actual GLB, DXF, MVR, and patch-paperwork downloads are invariant off/on.

### Approved Sprint 23D references

The left half uses the legacy neutral fog and the right half uses the promoted fixture-palette colour. I
deliberately re-approved the fixed-seed panels: FOH and wide gain restrained cyan/blue depth between crossing
cyan, blue, magenta, and amber beams; the deck close-up keeps fixture colours and black foreground separation.
The tint does not flatten the whole frame or turn the fog into a bright emitter.

- [Front of house](looks/sprint23-d-foh-before-after.webp)
- [Deck close-up](looks/sprint23-d-deck-close-before-after.webp)
- [Wide view](looks/sprint23-d-wide-before-after.webp)

Regenerate the three panels without changing the ordinary read-only gate:

```powershell
$env:STAGEFORGE_UPDATE_LOOK_REFS='1'
npx playwright test tests/e2e/sprint23-atmosphere.spec.mjs --workers=1
```

The D panels total `78,226 B`; all twelve A–D panels total `286,498 B`, below `600 KB`. Localized
changed/strong/mean-delta fractions were FOH `70.204% / 0.046% / 0.03188`, deck-close
`31.502% / 0.124% / 0.01250`, and wide `91.023% / 0.131% / 0.07176`. Clipped fractions were zero;
black-region coverage remained `8.90% / 27.09% / 11.73%`. The broad changed fraction is expected from a global
fog colour; the low mean and strong fractions are the bounds that keep it atmospheric rather than a global grade.

### Slice D budget and evidence boundaries

Five order-balanced warmed pairs at `1280×720` measured p50 off/on
`[1.8, 1.6, 1.6, 1.6, 1.5] / [1.7, 1.7, 1.6, 1.6, 1.6] ms` (median delta `0.0 ms`), p95
`[2.2, 1.8, 1.9, 1.9, 1.8] / [1.9, 2.1, 1.8, 1.9, 1.7]`, and p99
`[2.4, 1.9, 2.0, 2.1, 1.8] / [2.1, 2.5, 2.2, 2.2, 1.9]`. A fresh `390×844` low-tier engine with
4× CPU throttling exercised the documented neutral fallback: p50 off/on
`[12.6, 11.4, 11.4, 11.4, 11.5] / [12.0, 11.6, 11.0, 11.3, 10.9] ms` (median delta `-0.1 ms`), p95
`[15.5, 12.7, 12.9, 12.7, 12.8] / [13.7, 14.2, 12.3, 12.4, 12.4]`, and p99
`[16.3, 13.1, 13.8, 12.9, 14.1] / [14.6, 15.5, 12.7, 12.9, 12.8]`. Both are inside D's exact
`+0.10 / +0.20 ms` ceilings at the profiler's demonstrated `0.1 ms` resolution without a tolerance allowance.

Asynchronous GPU p50 was laptop off `[244.7409, 243.2747, 247.1172, 245.0724, 245.9839] ms` / on
`[245.0961, 242.0131, 248.4776, 246.6640, 241.3324] ms`, and phone-like off
`[143.3916, 143.7193, 144.1269, 144.4714, 144.4520]` / on
`[144.4271, 144.9798, 143.5194, 144.0499, 144.4694] ms`. These are ANGLE SwiftShader software-renderer
values, not hardware-GPU measurements; 4× CPU throttling does not emulate a phone GPU. D owns `0 B` and adds
zero draws/passes. With the C receipt's A+B+C deltas, A–D remains `0.0 ms` laptop / `-0.8 ms` phone-like,
`40,768 B`, one draw, and no added pass, within the combined Sprint 23 ceilings.

Opposing palettes, beam crossings, zero haze, blackout, master zero, cue transitions, accessibility fallbacks,
and lifecycle paths have direct browser coverage. Irregular final post-bloom sampling across red/blue cue changes
recorded zero qualifying general or saturated-red transitions and a rolling one-second count of zero. These
checks show bounded behaviour, not universal photosensitivity safety.

## Budget and evidence boundaries

The final repeated warmed Windows full-gate run measured three A/B pairs at a fixed `1280×720` laptop profile
and at `390×844` with 4× CPU throttling. Median p50 CPU delta was `0.00 ms` on the laptop profile and
`-0.30 ms` on the phone-like profile. A focused exact-commit replay that also recorded p95/p99 measured
`0.00 ms` and `-0.60 ms`, respectively. The look adds zero draws, passes, textures, geometries, or
application-owned GPU bytes; low-tier half-resolution bloom reduces the existing render-target estimate.

Playwright is configured with SwiftShader. Its asynchronous GPU p50 values are software-renderer evidence, not
Apple, Windows-hardware-GPU, or phone-GPU performance. CPU throttling does not emulate a phone GPU. The final
Mac gate and Windows Electron/package gates are recorded separately in the Sprint 23A Overnight receipt.

The existing preview flash limiter remains authoritative and no flashing or beat-driven decorative brightness
was added. Automated checks cover final rendered luminance after bloom on the supported StageForge paths,
including saturated-red and rolling one-second counts. These checks show bounded behaviour, not universal
safety; uploaded video, arbitrary animated ILDA content, and camera motion can introduce changes outside the
parameter-level governor.
