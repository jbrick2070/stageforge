# Demo Track & Per-Track Section Map

**Play demo** starts the bundled recorded track in `public/demo/`. **Audio** offers **Play synth demo** for the built-in 64-bar procedural score, and **Play demo track** to switch back to the recording. To supply your own bundled recording, update `public/demo/track.json` and its audio file.

The editor opens silent. Idle discovery and the first Play share one metadata request. Audio downloads only after an explicit Play. If the bundled map or recording is unavailable, **Play demo** falls back to the synth and explains the reason.

---

## Shipped Demo Track

StageForge ships with the following mapped track in `public/demo/`:

- **Audio:** `public/demo/track.mp3` — 96 kbps constant-bitrate (CBR) stereo MP3, 3,715,925 bytes (~3.72 MB, under the 4 MB mobile budget), duration 5:09.6 (309.6 s).
- **Section map:** `public/demo/track.json` — **122 BPM**, `firstDownbeatMs: 96`, **11 sections**, **158 bars** total:
  - `Walk-on` (`intro`, 8) → `Rising` (`build`, 8) → `Kick enters` (`drop`, 16, bar 17 at `0:31.6`) → `Main groove` (`groove`, 32) → `Lift` (`build`, 8) → `Main drop` (`drop`, 36) → `Breakdown` (`breakdown`, 8, bar 109 at `3:32.6`) → `Rebuild` (`rebuild`, 12) → `Second drop` (`drop`, 12) → `Finale` (`finale`, 8) → `Curtain call` (`outro`, 10).
- **Trailing margin:** 158 bars at 122 BPM plus the 96 ms first downbeat spans 310.92 s, running 1.32 s past the 309.6 s audio file on purpose so the measured bar lines stay exact. When the audio reaches the end of its trailing silence, playback finishes cleanly through the audio element's `ended` event and switches the transport button to **Replay track**.
- **Replacing or removing:** to use a different track, replace `public/demo/track.mp3` (or point `"file"` at another plain basename in `public/demo/`) and update `public/demo/track.json` + [`docs/assets.md`](assets.md). To disable the feature in a custom build, delete `public/demo/`.
- **Provenance & licence:** see **Demo Track Provenance** in [`docs/assets.md`](assets.md). `public/demo/track.mp3` is not covered by this repository's MIT licence (licence terms pending owner decision).

---

## File Layout

Place both files in `public/demo/`:

```text
public/demo/
  track.json     # section map (format: "stageforge-demo-track", version: 1)
  track.mp3      # audio file referenced by "file" (plain basename only)
```

Both web builds (`npm run build` → `dist/demo/`) and desktop builds (`npm run desktop:prepare` → `desktop/build/app/renderer/demo/`) copy `public/demo/` automatically. All fetches stay same-origin (`connect-src 'self' blob:`, `media-src 'self' blob:`) under Electron's strict CSP.

---

## Track Map Schema (`track.json`)

```json
{
  "format": "stageforge-demo-track",
  "version": 1,
  "title": "Midnight House Blues",
  "file": "track.mp3",
  "bpm": 120,
  "firstDownbeatMs": 0,
  "sections": [
    { "role": "intro", "label": "Walk-on", "bars": 8 },
    { "role": "groove", "label": "Deep groove", "bars": 16 },
    { "role": "build", "label": "Synth riser", "bars": 8 },
    { "role": "drop", "label": "12-bar blues drop", "bars": 12 },
    { "role": "breakdown", "label": "Rhodes break", "bars": 8 },
    { "role": "rebuild", "label": "Horns build", "bars": 8 },
    { "role": "finale", "label": "Final chorus", "bars": 12 },
    { "role": "outro", "label": "Curtain call", "bars": 4 }
  ]
}
```

### Validation Rules

| Field | Rule |
|---|---|
| `format` | Must be `"stageforge-demo-track"`. |
| `version` | Must be `1`. |
| `title` | Non-empty string, max 80 characters. |
| `file` | Plain filename only (no slashes, no `..`), ending in `.mp3`, `.m4a`, `.ogg`, or `.wav`. Max audio size: 16 MB (keep under 4 MB for fast mobile loads). |
| `bpm` | Finite number in `70..180`. Authoritative — StageForge sets the beat grid directly from `bpm` and `firstDownbeatMs` and skips offline beat analysis. |
| `firstDownbeatMs` | Finite number in `0..600000` (milliseconds from 0:00 to Bar 1, Beat 1). Before `firstDownbeatMs`, StageForge holds the opening blackout. |
| `sections` | Array of `1..24` sections. Total bars across all sections must be `<= 512`. |
| `sections[i].role` | One of: `intro`, `groove`, `build`, `drop`, `breakdown`, `rebuild`, `finale`, `outro`. Roles may repeat in any order. |
| `sections[i].label` | Non-empty string, max 48 characters, shown in the stage overlay. |
| `sections[i].bars` | Integer in `1..64` (12-bar blues choruses, 16-bar grooves, 4-bar outros, etc. all work). |

### Clock & Section Math

StageForge computes the musical sixteenth-note step directly from the audio player's playback position:

```text
step = (playbackMs - firstDownbeatMs) * bpm / 15000
bar  = floor(step / 16) + 1
```

Because the clock reads the audio element's position every frame, pause, resume, restart, track-position scrubbing, and `Prev / Next section` jumps stay locked to the music. Ensure your sections cover the full duration of the audio file; if audio continues past the final section, the outro look holds and the overlay reads "Show complete" until audio ends.

---

## Building a Section Map from Timestamps

In 4/4 time, one bar lasts:

```text
seconds_per_bar = 240 / bpm
bars            = (section_end_seconds - section_start_seconds) * bpm / 240
```

### Worked Example (120 BPM)

At **120 BPM**, `seconds_per_bar = 240 / 120 = 2.0 s` per bar.

Suppose your DAW markers are:

| Marker | Start | End | Duration | Calculation | `bars` | `role` |
|---|---|---|---|---|---|---|
| Bar 1 (after 0.5 s trim) | `0:00.5` | `0:16.5` | `16.0 s` | `16.0 × 120 / 240` | `8` | `intro` |
| Groove enters | `0:16.5` | `0:48.5` | `32.0 s` | `32.0 × 120 / 240` | `16` | `groove` |
| Riser | `0:48.5` | `1:04.5` | `16.0 s` | `16.0 × 120 / 240` | `8` | `build` |
| 12-bar blues chorus | `1:04.5` | `1:28.5` | `24.0 s` | `24.0 × 120 / 240` | `12` | `drop` |
| Breakdown | `1:28.5` | `1:44.5` | `16.0 s` | `16.0 × 120 / 240` | `8` | `breakdown` |
| Outro | `1:44.5` | `1:52.5` | `8.0 s` | `8.0 × 120 / 240` | `4` | `outro` |

Here `firstDownbeatMs` is `500` (or `0` if you trim that 0.5 s of leading silence in your DAW before exporting).

---

## Track Preparation Checklist

Before committing a real demo track into `public/demo/`:

- [ ] **Steady 4/4 at a fixed tempo:** no tempo ramps, rubato, or odd-meter bars (Section maps assume constant BPM in 4/4).
- [ ] **Trim leading silence:** align Bar 1 Beat 1 to `0:00.000` so `firstDownbeatMs` is `0` (or note the exact millisecond offset if a count-in is intentional).
- [ ] **Encode as CBR stereo MP3 under 4 MB (96–128 kbps):** use **CBR** (constant bitrate), not VBR, because VBR frame tables can drift by tens of milliseconds on browser seeks. Example with `ffmpeg`:
  ```bash
  ffmpeg -i master.wav -vn -codec:a libmp3lame -b:a 128k -ac 2 -ar 44100 public/demo/track.mp3
  ```
- [ ] **Verify the beat grid in StageForge:** open Audio settings, click **Play demo track**, confirm the Track grid shows your exact BPM and downbeat offset, and use **Prev / Next section** to verify every section transition lands cleanly on the bar line.
- [ ] **Record provenance in [`docs/assets.md`](assets.md):** update the Demo Track Provenance table (which parts are your own recordings vs generated, tool, plan, date, prompt, and licence terms) whenever the bundled track changes.
