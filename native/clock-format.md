# Native show playback

The native transport opens public show versions 1–3. The show supplies the rig, lighting looks, ordered events, cue identities, music transport and main LED transport. Its recorded event times are integer milliseconds. Repeated cue IDs can occur at different times, including the last return to blackout in Split Rig. The native cue list identifies each recorded occurrence by its time. Version 3 embeds the extended stage in the top-level `stage` object, including the wall placements, additional transports, and authored layout. [Open show format](../docs/show-format.md)

## Independent video walls

An optional adjacent `.stageforge.stage.json` describes wall placements and adds transport events for secondary walls. For `split-rig.stageforge.show.json` the companion file is `split-rig.stageforge.stage.json`. This lets the original show remain directly playable in StageForge 1.3. [Example sidecar](examples/split-rig.stageforge.stage.json)

```json
{
  "format": "stageforge-native-stage",
  "version": 1,
  "walls": [
    {"id": "side-led", "label": "Stage right", "x": 4.25, "y": 1.95, "z": -1.95, "width": 1.5, "height": 2.05, "yaw": -18}
  ],
  "screenEvents": [
    {"atMs": 6500, "target": "side-led", "kind": "video", "name": "blue-raster.mp4", "playing": true, "offsetSeconds": 1.25},
    {"atMs": 11000, "target": "side-led", "kind": "video", "name": "blue-raster.mp4", "playing": false, "offsetSeconds": 2.75}
  ]
}
```

Every secondary wall begins empty. Coordinates and dimensions use metres and yaw uses degrees. The sidecar can also specify placement for `main-led`. Its content and timing come from the main show. A secondary event takes a full screen reference for one wall. `offsetSeconds` identifies the media position at the event time. `playing: false` holds that position. `kind: "none"` clears the wall. List events in nondecreasing time order within the recorded take. Local media references use basenames.

## Show time and seeking

The CPU transport advances from Godot's monotonic clock. Each render tick consumes any newly crossed events, then samples each media position against the same show time. Scrubbing backward reconstructs the saved state and reapplies events in file order. Pausing holds the current position on every transport and retains each wall's authored play state for resume. A later cue can restart the same clip at a different position. The native video players receive that cue's event time together with its offset.

A demo score counts sixteenth notes and follows authored tempo changes. An external song uses offsets in seconds. The clock computes transport positions independently of installed decoders, actual media durations and audio-device latency. A show without a recorded take opens on its saved look.

After preparing the bundled example, run the independent transport regression from the repository root.

```sh
godot --headless --path native --script res://tests/show_clock_test.gd
```
