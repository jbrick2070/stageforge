# Codex whole-repo review, 2026-11-24

Independent read-only review by Codex (`gpt-6-astra`) of commit `d132537`. Line numbers refer to that commit and may have moved. The full test suite could not run in the review sandbox (no `node_modules`); findings come from reading the code and small in-memory reproductions. Claude Code re-checked H1 to H4, M2, M4 and M5 against the code; M1, M3 and L1 were not yet checked. Sprint 13 in `HANDOFF.md` tracks the fixes.

Health: strong simulator foundations, but physical-output safety is not yet dependable.  
Risk 1: catalogue fixtures receive generic DMX channel mappings, including incorrect blackout behaviour.  
Risk 2: renderer stalls and lost remote releases can preserve hazardous output indefinitely.  
Risk 3: recording and timecode state diverge from actual playback.  
Biggest simplification wins: restrict physical output to verified profiles; centralize transport state; remove eager panel preloading.

Review was read-only and offline. Focused, in-memory reproductions ran without dependencies; the full suite could not run because `node_modules` is absent. Hardware consequences below are inferred from verified emitted bytes, not hardware testing.

## Findings

### Critical

None verified.

### High

**H1 — Catalogue channel counts are mistaken for physical channel mappings.**  
`src/engine/StageEngine.ts:2545`

> `writeDmxChannels(uBuf, fx.dmxStart, fx.dmxWidth, [`  
> `  axisDmx(fx.currentPan, PAN_LIMIT),`  
> `  axisDmx(fx.currentTilt, TILT_LIMIT),`

Every moving/wash fixture receives the same simulator channel order; catalogue mode selection changes its footprint, not its encoding. `equipmentCatalog.ts:490` offers an ETC ColorSource PAR “1-Ch” mode, which therefore receives only the pan byte.

**Reproduction:** select that mode, center pan, and enable desk blackout. The actual encoder produces channel value **128**, despite simulated dimmer zero. Narrow RGB modes similarly receive axis values.

**Fix:** allow physical output only for explicitly implemented personalities. Preserve generic encoding for simulation and old-file loading, but exclude it from physical transmission.

**H2 — A frozen renderer leaves output refreshing indefinitely.**  
`desktop/dmx-sender.cjs:416`

> `const items = buildUniversePackets(activeConfig, buffers, optionsOverride);`

The main-process timer retransmits cached buffers without a renderer-liveness lease. Crash handlers do not cover a living, frozen renderer.

**Reproduction:** with an injected socket and clock, submit slot 255, stop renderer updates, then advance 60 seconds. Output remains enabled and transmits 255.

**Fix:** add a separate heartbeat and expire hazardous output on heartbeat loss. Unchanged-frame suppression at `StageEngine.ts:2211` means frame changes cannot serve as that heartbeat.

`docs/live-dmx.md:24` says “Guaranteed blackout,” but its own limitations contradict that guarantee. USB also runs in the renderer and cannot reliably black out after renderer failure.

**H3 — Remote “momentary” bumps can become permanent.**  
`src/App.tsx:781`

> `onSetBump: (key, active) => {`  
> `  setBump((b) => ({ ...b, [key]: active }));`

Bumps have no source ownership or expiry. WebSocket disconnect only updates connection status; disabling reception does not release held bumps.

**Reproduction:** in Cue Caller mode, send `/stageforge/bump/laser 1`, then disconnect or lose the release packet. The bump remains true. `StageEngine.ts:2561` permits it to enable a laser whose desk toggle is off.

**Fix:** track source-owned holds, require refresh for hazardous momentary commands, and clear them on disconnect, listener disable, or lease expiry.

**H4 — Emergency blackout leaves CO₂ and smoke output active.**  
`src/engine/StageEngine.ts:2877`

> `const output = fx.type === 'co2' ? Number(effCo2) : fx.type === 'smoke' ? effSmoke : effHaze;`  
> `fx.buffer[fx.start - 1] = Math.round(output * 255);`

This path ignores `s.blackout`, although blackout affects the lighting master.

**Reproduction:** activate CO₂, then press Space or send MSC `ALL_OFF`. The CO₂ channel remains **255**. This undermines the emergency “safety override” described in `docs/show-control.md:16`. The separate **Blackout & stop** transport action has different behaviour.

**Fix:** enforce emergency shutdown of hazardous effects before encoding. Define ordinary haze/master-dimmer behaviour separately.

### Medium

**M1 — An old USB write failure can close a new connection.**  
`src/dmx/enttecPro.ts:361`

> `} catch (err) {`  
> `  if (this.enabled) {`  
> `    this.error = \`USB DMX write failed: ${err instanceof Error ? err.message : String(err)}\`;`

A timed-out write can outlive `disable()`. Its later failure calls `forceCloseAfterError()`, which closes the current port rather than the originating session.

**Reproduction:** stall a write, disable through the timeout path, reconnect, then reject the old write. An in-memory reproduction changed the new session from enabled to disabled and closed its port.

**Fix:** capture writer/session generations in asynchronous operations and ignore stale completions.

**M2 — Recording loses removal of audio mappings.**  
`src/input/useShowTimeline.ts:27`

> `for (const key of Object.keys(after.look) as (keyof ShowState)[]) {`

Removing the final mapping deletes `audioMap`; the recorder only examines surviving keys.

**Reproduction:** otherwise identical frames, before containing `audioMap` and after lacking it, produce `frameDelta(...) === null`. Replay retains modulation that the operator removed.

Serialization also deletes empty mapping lists (`showFile.ts:274–277`), so recording an empty list alone would not survive export. Full starting snapshots can inherit final-look mappings through merge-based reconstruction.

**Fix:** distinguish full snapshots, patches, and explicit clears throughout recording, cue application, serialization, and seeking.

**M3 — Stationary timecode holds the cursor but leaves media running.**  
`src/showControl/clockOwner.ts:308`

> `return {`  
> `  lockState: 'LOCKED',`  
> `  action: 'none',`

Repeated timecode sets the internal paused flag without notifying playback transports. Continued packets prevent dropout handling.

**Reproduction:** lock at progressing timestamps, then repeat 1067 ms every 33 ms. Over two seconds, the state machine emits no stop action. `useShowControl` consequently never pauses the already-running media.

**Fix:** emit an explicit hold transition, pause all media clocks, and resynchronize on resumed progression.

The existing regression at `tests/show-control.test.mjs:508–516` checks cursor stability and `none` actions, but omits media behaviour.

**M4 — “Set downbeat” discards bar position.**  
`src/audio/tempoEngine.ts:68`

> `const nextOffset = ((safeMs % beatMs) + beatMs) % beatMs;`

Modulo one beat preserves beat alignment but loses which beat is Beat 1.

**Reproduction:** at 120 BPM, anchor at 500, 1000, or 1500 ms. Immediately evaluating that position returns `isDownbeat: false`.

**Fix:** retain an absolute downbeat anchor or explicit bar phase; preserve it when nudging.

`tests/show-control.test.mjs:351–355` asserts the incorrect intermediate representation without asserting the requested downbeat outcome.

**M5 — Cycling source addresses defeats OSC rate limiting.**  
`desktop/show-control-service.cjs:100`

> `if (buckets.size >= MAX_RATE_BUCKET_SOURCES) {`  
> `  const oldest = buckets.keys().next().value;`  
> `  if (oldest !== undefined) buckets.delete(oldest);`

Eviction gives returning sources fresh token allowances.

**Reproduction:** with frozen time and an injected socket, one source’s 1,000 packets yielded 500 accepted events. Cycling 65 addresses admitted **100,000/100,000** packets with zero drops. Exploitation requires the ability to vary source addresses; LAN exposure additionally requires enabling reception beyond loopback.

**Fix:** add an aggregate ingress budget and avoid replenishing active source budgets through eviction.

### Low

**L1 — Deferred panels still load at startup.**  
`src/App.tsx:266`

> `useEffect(() => {`  
> `  if (!viewerMode) preloadPanels();`  
> `}, [viewerMode]);`

`preloadPanels()` immediately imports seven panels, including the stage designer and rig builder.

**Scenario:** open the editor without opening any drawer; all seven imports are requested anyway. Splitting shifts work past initial rendering but retains startup download/parse cost.

**Fix:** load on opening or deliberate hover/focus; selectively idle-prefetch only after measurement.

Direct dependencies are exactly pinned. Runtime lockfile licence metadata lists MIT, ISC, Apache-2.0 and 0BSD; font licence texts are present. No conflicting runtime licence was identified. GitHub Actions references in `.github/workflows/pages.yml` remain mutable major tags. Desktop notice generation exists; equivalent Pages notice generation is not explicit. This was not an advisory or legal audit.

## Simplification, ranked by effort versus payoff

1. **Low effort, high payoff:** remove blanket `preloadPanels()` from `src/App.tsx`. Keep existing deferred components.
2. **Medium effort, highest safety payoff:** restrict physical output to verified profiles and centralize final blackout/lease enforcement across `StageEngine.ts`, `src/dmx/`, and `desktop/dmx-sender.cjs`. Consider retaining USB as simulation-only until its lifecycle is reliable.
3. **Medium effort, high correctness payoff:** one transport-state model for snapshot/patch/clear/hold/resume across `useShowTimeline.ts`, `showClock.ts`, `cueLook.ts`, and `useShowControl.ts`.
4. **Medium–high effort:** split the largest files along existing responsibilities:
   - `StageEngine.ts` (~3,017 lines): scene construction, frame evaluation, physical encoding.
   - `App.tsx` (~2,631): document transactions, session state, transport coordination.
   - `importMvr.ts` (~1,614): archive/XML parsing, transforms, reporting.
   - `StageDesigner.tsx` (~1,536): editing operations and canvas interaction.
   - `geometryBuilders.ts` (~1,514): venue and equipment geometry families.
5. **Low–medium effort:** reuse scratch vectors/colors in `StageEngine.ts`; it allocates a vector per hoist per frame and additional colors each frame. Measure allocation and frame-time improvements before wider abstraction work.

## Design critique

**Sprint 10 — useful, but insufficiently specified.**  
`HANDOFF.md:432–485` assumes parameterizing sections generalizes choreography. Existing `demoLighting.ts:56–66` uses absolute step thresholds for opening, LED fades, and build color transitions; repeated or relocated roles will not behave consistently at equal section progress. Separate the one-time opening sequence from section-relative choreography.

Define behaviour when audio ends before/after the map, during seek/loading failure, and when users change BPM. Use occurrence identity separately from role. Freeze parity fixtures against a named revision, not moving `HEAD`. The minimum three-section requirement adds little value.

**Sprint 11 — tool-name absence is not capability isolation.**  
`HANDOFF.md:513–522` does not establish “outputs are not reachable.” Once a human arms output, allowed `go`, `trigger_cue`, `set_master`, and accepted proposals can affect physical output without enabling it themselves.

Likewise, rejecting top-level `audienceScan: true` is insufficient: inspect every cue, timeline event, full-show proposal, and partial-look route. Existing generic validators intentionally accept audience-scan state. Positive strobe values can also select legacy/manual oscillators outside the audio limiter: `StageEngine.ts:2292–2297` reaches 25.58 Hz for a strobe bump; mapped physical rate bytes normally become zero, but bumps can override that protection.

The simplest enforceable initial boundary is **mutual exclusion between bridge control and physical output**, checked in the output service, including pending proposals and in-flight commands. An exact server dispatch allowlist must govern calls, not merely `tools/list`. The guarantee should describe this bridge’s authority, not every capability an external AI client possesses.

Loopback, token, Host and Origin checks are sensible layers. Add connection/concurrency budgets, request timeouts, bounded proposal storage, cancellation on disable, and rejection of obsolete-token work. Avoid implementing Streamable HTTP yourself merely to meet an arbitrary 5 MB SDK threshold.

**Sprint 12 — measurement guidance cannot establish physical safety.**  
The equation at `HANDOFF.md:566` assumes a particular beam-growth model: squared diameter grows as `a² + (φz)²`. Its irradiance expression also assumes a spatial power distribution. The design does not establish compatible diameter/divergence conventions, beam profile, wavelength treatment, exposure duration, or uncertainty. Its numerical examples verify arithmetic, not those assumptions.

“Static is the worst case” is too broad for the stated pulsed/scanned scope. A fixed 0.25-second assumption does not establish safety for longer exposure. Missing power must mean **unknown**, not “no zone” as proposed at line 601. Validate zero divergence, negative radicands, units, and assumed aperture size explicitly.

Current clearance calculations truncate rays at the simulator’s 38 m beam length and use simplified audience geometry. Matching those calculations is not independent validation.

The proposed arm gate also has a time-of-check/time-of-use gap: cues, modulation, motor movement and AI commands can change conditions after approval. Hardware calibration is explicitly deferred at line 594, undermining correspondence between simulated and physical aim. Distinguish hard failures, unknowns and acknowledgable warnings; invalidate checks against a revision of all relevant state. Keep measurement labels separate from safety evaluation so hidden fixtures are still checked. Replace “Ready” with narrower wording.

Moving output under Advanced is worthwhile. Keep the emergency stop visible, and remove “guaranteed blackout” claims.

## Ten most valuable missing tests

1. Physical personality golden bytes, including one-channel PAR blackout and every supported mode.
2. Renderer-heartbeat loss while transmitting nonzero hazardous channels, including unchanged cues.
3. Lost bump release, remote disconnect, and listener disable clearing source-owned holds.
4. Emergency blackout zeroing CO₂/smoke despite active toggles and bumps.
5. Enttec late write completion/rejection after disable and reconnect.
6. Mapping add/remove/clear through record, save, reopen, replay and seek, preserving older show compatibility.
7. Stationary timecode actually pausing audio and all video clocks, then resuming coherently.
8. Downbeat anchoring on each of four beats, plus nudges across beat boundaries.
9. OSC admission with more than 64 sources and sustained aggregate overload.
10. Final composed flash limits and bridge restrictions across nested proposals, cue playback, manual/remote overrides, and already-live output.