# Show Control, Timecode & Tempo

StageForge integrates with lighting consoles, QLab, DAWs, media servers and OSC controllers over open standards while enforcing a single clock owner so cues never double-fire.

## Single Clock Owner

Open **Sync** in the top bar to open the **Show Control & Sync** drawer. StageForge always boots in **Master** mode with all network and MIDI listeners turned **off**.

| Mode | Internal take play & follows | Auto-LD | External Timecode (MTC / Art-Net TC) | External Triggers (OSC / MSC) | Outbound Sync |
| --- | --- | --- | --- | --- | --- |
| **Master** | Allowed | Allowed | Readout only (ignored for transport) | Ignored & logged | Opt-in MTC, Art-Net TC & OSC state feedback |
| **Chase TC** | Suppressed | Suppressed | Drives take & secondary walls | Ignored (except emergency `ALL_OFF` / blackout) | Never re-emits timecode |
| **Cue Caller** | Suppressed | Suppressed | Readout only | Allowed (`GO`, `BACK`, `STOP`, `RESUME`, `RESET`, blackout, master, bumps, tempo) | Opt-in OSC state feedback |

- Switching clock mode cancels every follow timer, stops internal take playback, resets chase/dedupe state and fires nothing.
- Manual blackout (`Space`) and master dimmer always remain active as safety overrides.
- Clock ownership can never be changed remotely over OSC or MIDI.
- When StageForge is in **Chase TC** or **Cue Caller** mode, a compact corner badge stays visible (including in Cinema mode) with a one-click **Master** reset button.
- For connecting local AI clients over MCP (Streamable HTTP on `127.0.0.1`), see [AI Bridge (`docs/ai-bridge.md`)](./ai-bridge.md).

## OSC (Open Sound Control 1.0)

- **Desktop app (Electron):** listens on UDP `127.0.0.1:8000` by default (loopback only unless **Listen on all interfaces (`0.0.0.0`)** is explicitly enabled). Desktop CSP stays tight (`connect-src 'self' blob:`) because UDP runs in the Electron main process.
- **Web browser:** connects to an OSC-over-WebSocket bridge (`ws://` or `wss://`, default `ws://127.0.0.1:8080`).
- **Safety:** packets capped at 8 KiB, bundle depth capped at 4, max 64 elements per bundle, unknown type tags and wildcard pattern characters rejected, datagram ingress budgeted before decoding (1,000 datagrams/s aggregate), and OSC messages rate-limited to 500 messages/s per source / 1,000 messages/s aggregate with a shared overflow bucket beyond 64 sources (no fresh allowance on eviction).
- **Momentary bump leases:** every remote bump (`/stageforge/bump/*`) is source-owned and expires automatically after **2 seconds** unless refreshed (senders holding a button should repeat at least once per second). Disconnecting, disabling the listener, switching clock modes, or blurring the window clears all holds immediately. A remote `laser` bump never enables a laser whose desk toggle is off.

### Inbound OSC addresses

| Address | Arguments | Action |
| --- | --- | --- |
| `/stageforge/go` | *(none)* or float `≥ 0.5` | Advance to next cue (coalesced 100 ms; TouchOSC press/release buttons should send float `1.0`/`0.0`) |
| `/stageforge/go` | `i` (`1..4096`) | Trigger cue by 1-based index (250 ms idempotence; send float `1.0`/`0.0` if you want next-cue press/release) |
| `/stageforge/go` | `s` | Trigger cue by exact cue ID or exact trimmed name |
| `/stageforge/back` | *(none)* or `≥ 0.5` | Previous cue |
| `/stageforge/stop` | *(none)* or `≥ 0.5` | Stop active playback / audio |
| `/stageforge/resume` | *(none)* or `≥ 0.5` | Resume audio playback |
| `/stageforge/blackout` | *(none)* or `i/f/T/F` | Blackout on (`≥ 0.5` / no arg) or off (`< 0.5`) |
| `/stageforge/master` | `f` (`0..1`) | Set grand master dimmer |
| `/stageforge/bump/1`..`6` (or `blinder`, `strobe`, `co2`, `smoke`, `laser`, `motorDrop`) | `f` (`≥ 0.5` pressed, `< 0.5` released) | Momentary bump |
| `/stageforge/tempo/tap` | *(none)* or `≥ 0.5` | Tap tempo |
| `/stageforge/tempo/bpm` | `f` | Set desk BPM (octave-folded into `70..180`) |
| `/stageforge/tempo/half`, `/stageforge/tempo/double` | *(none)* or `≥ 0.5` | Half-time / double-time (within `70..180`) |
| `/stageforge/audio/reactive` | *(none)* or `i/f/T/F` (`0`/`1`) | Enable (`≥ 0.5`) or disable (`< 0.5`) master Beat sync |
| `/stageforge/audio/mapping/<id>/amount` | `f` (`-1..1`) | Set audio-mapping amount for mapping `<id>` (clamped to valid range for the target) |

### Outbound OSC state feedback (opt-in)

- `/stageforge/state/cue` (`s`)
- `/stageforge/state/timecode` (`s`)
- `/stageforge/state/bpm` (`f`)
- `/stageforge/state/clock` (`s`: `master` | `chase` | `caller`)

## Web MIDI (MTC & MSC)

Works in Chromium/Edge browsers and the StageForge desktop app (Electron grants `midi` and `midiSysex` for app pages only).

- **MTC (MIDI Time Code):**
  - Quarter-Frame (`0xF1`): forward assembly completes on piece 7 with the MIDI spec `+2` frame display offset and ¼-frame interpolation; reverse assembly (`7 → 0`) seeks silently without firing cues.
  - Full-Frame SysEx (`F0 7F <dev> 01 01 <0rrhhhhh> <mm> <ss> <ff> F7`): immediate locate (no `+2` offset, seeks without firing skipped events).
  - Supports `24`, `25`, `29.97` drop-frame (rejects invalid dropped frames `00`/`01` on non-10th minutes) and `30` fps.
- **MSC (MIDI Show Control):**
  - `F0 7F <dev> 02 <fmt> <cmd> [data] F7` (capped at 128 bytes; device filter `0..111` or `127` all-call; formats `01` lighting, `02` moving lights, `7F` all).
  - Supported commands: `01` GO, `02` STOP, `03` RESUME, `04` TIMED_GO, `06` SET (controller 1 → 14-bit grand master), `08` ALL_OFF (blackout on), `09` RESTORE (blackout off), `0A` RESET.
  - Q-number resolution: integer → 1-based cue index; dotted number (e.g. `1.5`) → exact trimmed cue name. No fuzzy matching.

## Art-Net 4 Timecode (`OpTimeCode` `0x9700`)

Available in the Electron desktop app on UDP `6454`:

- Shares one exclusive-bind UDP `6454` socket (`desktop/artnet-rx.cjs`) with Art-Net node discovery (`OpPollReply` `0x2100`) so enabling Art-Net Timecode RX and scanning for Art-Net DMX nodes never collide with `EADDRINUSE`.
- Filters to `StreamId = 0`, validates frame rates (`0=24`, `1=25`, `2=29.97 DF`, `3=30`), rate-limits to 120 pkts/s and coalesces to ≤ 60 Hz across IPC.
- Chase state machine (`UNLOCKED → LOCKING → LOCKED → FREEWHEEL → STOPPED`): locks after 2 consistent frames, slews jitter within ±2 frames, seeks silently on jumps (`> 10` frames forward or `> 2` frames backward), freewheels on dropout (`250..500 ms` dropout, `0..2000 ms` freewheel), and holds look cleanly on stop.
- Take SMPTE frame rate (`24 | 25 | 29.97 | 30`) and start offset (`timecodeOffsetMs`, e.g. `01:00:00:00`) persist additively in [Show format v5](show-format.md).

## Tempo, Offline Beat Grid & Live BPM

- **Tap Tempo:** click **Tap** (in the Show cues desk or Audio popover) or press **`T`** (when not typing). Averages the last 4–8 intervals, rejects outliers, resets after a 2-second gap, and folds into `70..180` BPM.
- **Half / Double Time (`½×` / `2×`):** halves or doubles the desk BPM without folding; disabled with a tooltip when the result would leave `70..180` BPM.
- **Offline Beat Grid (`web-audio-beat-detector`):** when you load an audio track (`≤ 64 MiB` and `≤ 15 min`), StageForge decodes it at mono 22.05 kHz and computes a phase-locked `{ bpm, offsetMs }` grid in a Web Worker. Use **`−50 / −10 / +10 / +50`** to nudge the phase or **`Downbeat` / `1!`** to lock Beat 1 to the current track position.
- **Live Tempo (`realtime-bpm-analyzer`):** enable **Live BPM** to run an AudioWorklet tempo tracker on live mic or playing audio (served from `'self'` to stay compatible with strict CSP). Applies automatically only after 4 seconds of stability within ±1.5 BPM when the tempo differs by more than 1 BPM.

## Audio-Reactive Mappings

StageForge's lighting engine acts as a virtual audio-reactive lighting controller. Open **Show cues → Audio** at the bottom of the desk to map live FFT/audio features to fixture groups, LED walls, haze, and laser projectors:

- **Master Beat sync & source:** **Beat sync** (`look.audioReactive`, also toggleable via Xbox gamepad **L3 (hold 250 ms)** or OSC `/stageforge/audio/reactive`) is the master enable. Drive analysis from a loaded audio track, the demo synth, or **Mic** (live microphone / line-in, opened with echo cancellation, noise suppression and auto-gain disabled for accurate music analysis).
- **32-band FFT range picker:** Drag across the live 32-band spectrum meter (or use the keyboard `Lo`/`Hi` inputs) to choose any FFT band range (`0..31`) and add a band mapping.
- **Presets & custom rows:** One-click presets include **Kick → wash dimmer**, **Hats → beam strobe**, **Bass → LED wall**, and **Energy → beam zoom**. Up to 16 mappings can be active at once, each with source, target group/parameter (plus optional per-projector selector on lasers), amount (`-1..1`, negative ducks), attack/release envelope times, threshold gate, curve (`linear`, `square`, `sqrt`), enable toggle, and a live level meter.
- **Cues, replay & live DMX:** Mappings live in `look.audioMap` (saved additively in [Show format v8](show-format.md)) so **Store cue** captures and recalls them. Modulation runs once per frame in `StageEngine` before both 3D rendering and live DMX frame emission, so physical fixtures over sACN, Art-Net or Enttec USB Pro follow the exact same envelope. Modulation is never baked into recorded takes, keeping seek and replay deterministic.
- **Built-in safety:**
  - **Blackout and Master dimmer always win.**
  - **Photosensitivity flash limiter:** All audio-mapped strobe triggers share a combined room refractory window (`≥ 334 ms` between staggered flashes, `≤ 3` flashes/s across the rig; simultaneous hits on the same beat frame fire together as one flash), and all audio-mapped dimmer, brightness, and laser-intensity targets enforce a fall-rate cap on the combined target output (`≤ 3` full-intensity flashes/s). Refractory timing persists across Beat sync toggles and cue switches. Mapped strobe targets write `0` on the DMX strobe-rate channel and flash through the dimmer channel so physical fixtures obey the same cap. An amber **Flash limiter active (≤ 3/s)** live-region notice appears whenever the limiter engages.
  - **Laser safety:** Laser mappings can only scale intensity, spread, and rotation at or below the look's set levels, and can only increase scan speed (`[base, 1]`). They can never enable a disabled laser, enable audience scanning, or pitch beams downward.
  - **Haze inertia:** Haze mappings enforce slow envelope limits (`attackMs ≥ 1000`, `releaseMs ≥ 2000`).

## Manual Hardware & Cross-Tool Verification Checklist

Because physical MIDI interfaces, audio rooms and external show controllers cannot be tested unattended, verify these manually on your rig:

1. **QLab / TouchOSC → Desktop OSC (UDP):**
   - Open **Sync**, switch to **Cue Caller**, enable **Listen UDP** on `127.0.0.1:8000` (or enable *All interfaces* for a tablet on LAN).
   - Send `/stageforge/go` (no args and with int `2`), `/stageforge/master` (`0.5`), `/stageforge/blackout` (`1` then `0`), and `/stageforge/bump/1` (`1` press, `0` release). Confirm TouchOSC press+release fires once and blackout restores cleanly.
   - Switch back to **Master** and confirm incoming OSC triggers are logged as `ignored: master`.
2. **Browser OSC-over-WebSocket:**
   - Run an OSC WebSocket bridge on `ws://127.0.0.1:8080`, open the web build, connect in **Sync**, switch to **Cue Caller**, and send `/stageforge/go`.
3. **Reaper / DAW → Web MIDI MTC:**
   - Route a virtual MIDI cable (loopMIDI on Windows / IAC Driver on macOS) sending 30 fps or 29.97 DF MTC from `01:00:00:00`.
   - Set **TC start offset** to `01:00:00:00`, record a 10 s take, switch to **Chase TC**, enable **MTC in**, and play/scrub/stop the DAW. Confirm `LOCK` badge appears, cues fire once without double-firing, scrubbing seeks silently, and stopping freewheels then holds the look.
4. **grandMA3 onPC / QLab → MIDI MSC:**
   - Send MSC `GO 1`, `GO 2`, `SET` ctrl 1, `ALL_OFF`, and `RESTORE` over virtual MIDI with **Cue Caller** + **MSC in** enabled.
5. **Art-Net Timecode (`OpTimeCode` `0x9700`) + DMX Discovery:**
   - Send Art-Net TC from Reaper/TimeLord/grandMA3 to UDP `6454` with **Receive OpTimeCode** enabled, then click **Scan** in the DMX Output panel and confirm zero `EADDRINUSE` conflict.
6. **Offline Beat Grid & Live Mic BPM:**
   - Load a 128 BPM WAV/MP3 track; confirm `Grid 128.0` appears, nudge downbeat `±10 ms`, click `1!`, and confirm fixture beat pulses lock to the kick.
   - Switch to **Mic input**, enable **Live BPM**, play steady 124 BPM audio into the room mic, and verify BPM updates smoothly after ~4 s of lock.
