# Read-only Pitch Viewer

StageForge includes a read-only **Pitch Viewer** for production managers, clients, and collaborators who need to review a show or bundle without risking accidental edits, local-storage writes, or live output.

## Entering and exiting viewer mode

You can open the pitch viewer in three ways:

1. **URL flag (`?view`):** append `?view` to the StageForge URL (for example, `https://jbrick2070.github.io/stageforge/?view`). The `?view` parameter is strictly a boolean flag — any value is ignored and StageForge never fetches remote URLs from it.
2. **Show files dialog (web & desktop):** open **Files → Open in viewer…** and pick a `.stageforge.show.json`, `.stageforge.zip` bundle, or `.stageforge.json` file.
3. **Desktop File menu (Electron):** choose **File → Open in viewer…** (`Ctrl+Shift+O` / `Cmd+Shift+O`).

Clicking **Exit viewer** restores your previous desk session (rig, stage, cues, look, camera, volume, take, ILDA clip, and linked desk media) paused and intact — or, if booted directly via `?view`, removes `?view` from the address bar and returns to the normal desk. For safety, live DMX output, show-control transports (OSC, MIDI, Art-Net timecode), live BPM analysis, and external clock modes (`chase` / `caller`) stay off (clock mode resets to `master`) after exit until you deliberately re-arm them.

> **Memory note:** when entering viewer mode from an active desk session, the desk snapshot and its media remain in memory alongside the opened viewer show/bundle (up to the 512 MiB in-memory bundle limit) so **Exit viewer** can restore the desk without reloading.

## What you can do in viewer mode

- **Orbit and zoom** the 3D stage freely with mouse or touch.
- **Switch camera presets** via the Camera selector or keys `1`–`7`.
- **Run cues:** click **GO**, **Back**, any cue pad, or use `→` / `PageDown` (GO) and `←` / `PageUp` (Back).
- **Play, pause, and scrub takes:** use **Play/Pause** (or `Space`), **Stop**, the take scrubber, and cue/wall markers.
- **Cinema mode:** toggle with the eye icon or key `H`.
- **Open another show or bundle** in memory via **Open show…** (bundles still run full manifest and SHA-256 verification before applying).
- **Relink missing media for the session:** if a JSON show references external audio, video, or image files, click the missing-media banner to relink them in memory. Relinked files are never persisted and are released when you exit viewer mode.

## What is disabled in viewer mode

Capabilities are governed by a single read-only capability object (`VIEWER_CAPABILITIES` in `src/viewer/capabilities.ts`):

| Capability | Editor | Pitch Viewer |
| --- | --- | --- |
| `edit` | `true` | `false` |
| `save` | `true` | `false` |
| `autosave` | `true` | `false` |
| `liveOutput` | `true` | `false` |
| `showControl` | `true` | `false` |
| `mutatingHotkeys` | `true` | `false` |
| `controllers` | `true` | `false` |

In viewer mode:

- **No editing or persistence:** the rig builder, stage designer, gear/cost/paperwork modal, cue list editor, and console edit tabs are unmounted. Mutation choke points (`applyRig`, `installStage`, `flushDesign`, `saveDocument`, cue/look/stage/shop-stock edits) are gated off, so `localStorage` (including `stageforge.design.v1`) is never modified.
- **No live output or show control:** sACN, Art-Net 4, Web Serial USB DMX, OSC (UDP & WebSocket), Web MIDI (MTC/MSC), Art-Net timecode, and gamepad controllers are forced off and cannot be started.
- **Playback-only hotkeys:** `Space` toggles play/pause (never blackout), `←`/`→` and `PageUp`/`PageDown` step cues, `1`–`7` switch cameras, and `H` toggles cinema mode. Momentary FX (`B`/`S`/`C`/`F`/`L`/`D`) and tap tempo (`T`) are disabled.
- **Desktop menu & main-process guards:** on Electron, mutating File menu items (`Open show or rig…`, `Save show as…`, `Save show bundle…`, `Export rig…`, and the `Export` submenu) are disabled in the main process, downloads are cancelled, and `serial`/`midi`/`media` permissions and DMX/show-control enable IPC calls are rejected while the window is in viewer mode.

> **Security note (desktop):** `stageforgeDesktop.setViewerMode(boolean)` is a renderer self-restriction mechanism designed to prevent accidental edits and outputs during a client review — it is not a security boundary against a compromised renderer. The capability gates in the renderer and the main-process guards work together to prevent unintentional state changes or live hardware output.
