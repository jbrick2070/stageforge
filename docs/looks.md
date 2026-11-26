# StageForge Look — Sprint 23A Colour and Output Foundation

Sprint 23A is the first shippable slice of the planned default cyberpunk-club look. It improves colour handling
and output restraint without adding a selectable look preset. Slices B (neon architecture), C (wet-deck
composition), and D (coloured atmosphere) are not part of this slice and remain unfinished.

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
