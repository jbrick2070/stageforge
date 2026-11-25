# Live Measurements, Safety Zones & Pre-flight Gate

StageForge includes an optional live measurement overlay, 3D and 2D stage-plan safety zone overlays, a visible pre-flight gate before arming live DMX output, and a printable **Commissioning Record** sheet in the paperwork book.

> **Guidance only — not certification.** All calculations, zones, and pre-flight results are design guidance. Hardware aim calibration is deferred, so simulated fixture aim may not match real fixture aim on site. A qualified Laser Safety Officer (LSO), master electrician, and rigger must assess and sign off on every real installation.

## Live Measurements (`src/data/measure.ts`)

Toggle the overlay from the top bar (**Measure**), the console header (**Measure**), or keyboard shortcut **`M`**. It is **off by default** and allocates zero 3D overlay objects or GPU resources when off.

Measurements read the engine's live per-head aim (`currentPan`, `currentTilt`, world lens origin, world beam axis, zoom scale, and applied dimmer) directly from `StageEngine` without recomputing fixture placement or aim a second time:

- **Trim height:** height above the stage deck directly below (`trimAboveDeckM`) and above the venue floor (`y = 0`, `trimAboveFloorM`).
- **Pan / Tilt:** live head angles in degrees and corresponding 8-bit DMX values (`axisDmx` against `±270°` pan and `±135°` tilt).
- **Beam angle:** effective full cone angle matching the rendered cone slope and `beamZoomScale`:
  - `theta = 2 * atan(((farRadius - nearRadius) / length) * zoomScale)`
- **Hit point & throw distance:** nearest positive ray intersection across stage deck modules, venue floor, authored/stock LED walls, and physical enclosing venue walls/ceiling (`src/data/venueBounds.ts`). Open-air `festival` venues have no invented ceiling or walls; upward beams report **No surface hit**.
- **Beam footprint (approximate):**
  - Normal incidence (`0°`): `D = 2 * d * tan(theta / 2)` (point-cone model; 10 m throw at `10°` gives `1.75 m`).
  - Oblique incidence (`alpha`, with `k = tan(theta / 2)`, `c = cos(alpha)`, `q = c^2 - k^2 * (1 - c^2)`): exact conic-section ellipse `D_major = 2*d*k*c / q`, `D_minor = 2*d*k*c / sqrt(q)` when `q > 1e-3`, `c >= 0.05`, and elongation `<= 50x`. At grazing or near-grazing angles, both ellipse axes are returned as `null` and reported as **grazing** (alongside the normal diameter) rather than inventing a capped or blown-up ellipse.
- **Illuminance estimate (lux):** computed **only** when the fixture has explicitly configured or verified catalogue luminous flux (`lumens > 0`; never uses the 10,000 lm legacy preview default). Uses uniform spherical-cap solid angle `Omega = 2 * pi * (1 - cos(theta / 2))` and `E = (Phi * dimmer * cos(alpha)) / (Omega * d^2)`, returning `n/a` when photometric data is absent, throw `< 0.5 m`, or `cos(alpha) < 0.05`. Assumes constant flux across zoom and uniform beam distribution.
- **Warnings:** pan or tilt within `5°` of travel limit, beam hitting no surface, or beam entering the audience keep-out volume below `3.0 m` (evaluated for **both** the center beam axis and the lower cone edge in the vertical plane so wide washes cannot hide crowd spill behind a high axis).

## Safety Zones (3D & Stage Plan)

All zones are **off by default**, each with its own independent toggle in the Measure HUD (3D) and Stage Designer toolbar (2D plan):

1. **Audience keep-out volume (`y = 0..3.0 m`):**
   - Uses `MIN_AUDIENCE_CLEARANCE_M = 3.0 m` (IEC 60825-3 / ANSI Z136.1 vertical clearance guidance; `2.5 m` lateral separation noted).
   - Evaluates rays out to the full venue audience bounds (enclosed room walls for indoor venues; full `±70 m` open-air floor extent for festivals; not truncated to the 38 m visual beam shader length).
   - **Flat-floor approximation:** models the audience floor at `y = 0`; raked theatre seating and arena tiers sit higher than `y = 0`, so site clearance must be measured above the highest occupied seating surface.
   - Moving-head beam segments intersecting the keep-out volume turn **red** in the batched 3D overlay.
2. **Laser Nominal Ocular Hazard Distance (NOHD):**
   - Equation (approximate static-beam model):
     `NOHD = (1 / phi) * sqrt((4 * P) / (pi * MPE) - a^2)`
   - **Assumptions and limitations (read carefully):**
     - `P` (W): optical power at aperture. Catalogue `opticalPowerW` figures are typically manufacturer *guaranteed* output, not necessarily absolute peak output.
     - `phi` (rad): **full-angle** beam divergence (`divergenceMrad * 1e-3`).
     - `a` (m): beam diameter at aperture (`beamDiameterMm * 1e-3`, assumed circular/top-hat or 1/e² diameter convention as cited). When `beamDiameterMm` is omitted by the catalogue, StageForge uses **5 mm** as an explicit assumption (`status: 'assumed'`), displays `"assumed 5 mm aperture"`, reports the zero-aperture bound as well, and raises a pre-flight warning. Note that larger aperture diameters *reduce* NOHD slightly, so 5 mm is an illustrative assumption rather than a conservative bound.
     - **Beam profile:** assumes uniform irradiance across the beam cross-section (does not model hot-spot Gaussian peaks, which increase hazard distance).
     - **Wavelength & exposure time:** uses `MPE = 25.4 W/m^2`, which applies to **visible wavelengths (400–700 nm)** for a **0.25 s** aversion-response exposure only. **Staring or longer exposures (> 0.25 s) have a significantly lower MPE and much longer NOHD.**
     - **Static beam worst case:** treating every beam as static is conservative **only for beam motion** (scan failure), **not for exposure time** or optical power margin. Scanned and pulsed beams require a full hazard analysis by a qualified LSO.
   - **Unknown is not safe:** missing, zero, negative, non-finite, or unverified optical power or divergence (or invalid aperture diameter) returns **`status: 'unknown'`**, draws **no hazard cone** (placing only an explicit unassessed caution marker at the projector aperture in 3D and on the 2D plan), displays **"Cannot assess"**, and counts as an unresolved laser hazard in the pre-flight gate. Negative/zero radicand returns **`status: 'within-aperture'`** with `"Cannot be assessed beyond aperture; LSO assessment required."`
   - When drawable (`computed` or `assumed`), NOHD cones are clipped to venue bounds for display while displaying the true unclipped distance in metres and flagging whether the audience zone lies within the NOHD envelope.
3. **Reach map (approximate):**
   - Draws an approximate stage-deck reach envelope for hung and floor pan-tilt moving heads (`±270°` pan, `±135°` tilt), line loci for single-axis tilt battens, and no motorized reach polygon for fixed PAR fixtures. Exact per-target focus reachability is checked separately in `checkRigAimReachability` for pre-flight.

## Pre-flight Gate & Commissioning Record

- **Always evaluates every fixture** (including unplaced units, static moving-head aim & lower-cone audience clearance, disabled lasers, and every stored cue's laser state) regardless of whether the Measure overlay or hit labels are visible.
- **Three outcomes:**
  - **Hard `FAIL` (blocks arming; cannot be acknowledged away):** DMX patch conflict or universe overflow (>512), rigging overload or hoist uplift, electrical branch circuit or feeder overload (when a site feeder is configured), or active laser `audienceScan: true`.
  - **`WARN` (non-laser):** unplaced units, rigging/power caution (`>= 80%`), `simulation-only` physical DMX personalities (including unimplemented catalogue modes and generic non-catalogue fixtures, all of which send neutral `0` on physical DMX), unreachable focus targets, or moving-head audience-clearance / pan-tilt limit warnings. Requires explicit per-row acknowledgement.
  - **Lasers (never skippable):** every laser projector gets its own row evaluated across both the current look and every stored cue. Projectors with unknown NOHD (`cannot assess`), stationary beam hazard, audience clearance `< 3.0 m` (in current look or any cue), or a stored cue enabling `audienceScan` block arming unless fixed or explicitly **inhibited to physical DMX 0** for the session (session-sticky across cue Go and config edits, enforced in `StageEngine` on `physicalDmxU1/U2` with no cue or bump bypass). Assessed clear lasers still require an explicit per-projector acknowledgement.
- **TOCTOU & live monitoring:** acknowledgements bind to a deterministic `configRevision` covering rig geometry, patch, stage layout, every cue's full authored state, full ILDA point data, and DMX routing — separated from runtime playback state so cue `Go` does not falsely trigger stale alarms or drop active laser inhibits, while any authored rig/cue/ILDA/DMX edit marks pre-flight **stale** and disables arming. While live DMX output is running, continuous re-evaluation raises a persistent, non-dismissible warning banner next to the LIVE badge if a safety check starts failing and automatically forces newly-failing lasers to physical DMX 0.
- **Status wording:** displays `"Not checked"`, `"Blocked (N)"`, `"N warnings"`, or `"Checks passed"` (never `"Ready"`, `"safe"`, or `"verified"`). Acknowledged warnings stay reported as `"N warnings"`.
- **Commissioning Record:** Sheet 7 of the Paperwork book (`Gear & cost → Paperwork → Commissioning record`) prints the frozen pre-flight snapshot with tester name, date, revision, check rows, operator actions, disclaimers, and a signature line, and exports the identical snapshot as `.commissioning-record.csv`. Status is informational only and never persisted as enabled.
