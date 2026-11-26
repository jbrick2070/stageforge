# StageForge Look — Sprint 23A–B Default Look

Sprint 23A is the first shippable slice of the planned default cyberpunk-club look. It improves colour handling
and output restraint without adding a selectable look preset. Slices B (neon architecture), C (wet-deck
composition), and D (coloured atmosphere) are not part of the completed work and remain unfinished.

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
