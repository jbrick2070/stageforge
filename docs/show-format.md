# StageForge show files

A `.stageforge.show.json` file stores a rig, its ordered cue list and the lighting desk as plain UTF-8 JSON. Version 1 can also carry a recorded sequence, camera and volume settings, and the names and positions of sound and screen media. The schema uses JSON Schema Draft 2020-12. [Version 1 schema](../public/schemas/show-v1.schema.json) · [Amber Walk-on example](../public/examples/amber-walk-on.stageforge.show.json)

## Opening the example

Choose **Files → Open Amber Walk-on example**, then **Show cues → Replay take**. The example starts a club rig in blackout. Its first cue follows after 2.5 seconds and brings four moving heads up in amber. The second cue holds until the operator advances. The six-second recording starts the built-in score, starts the main-wall video at the reveal, pauses the wall at five seconds and pauses the score at six seconds. The app bundles the [amber screen clip](../public/examples/amber-clouds.mp4). When opening the JSON directly on another machine, select the matching clip in **Files → Relink media files**.

## Reading and writing a show

| Field | Meaning |
| --- | --- |
| `$schema` | `https://jbrick2070.github.io/stageforge/schemas/show-v1.schema.json` |
| `format`, `version` | The exact values `"stageforge-show"` and `1`. |
| `rig` | Stage dimensions and venue, optional platforms and scenic props, trusses with their fixtures, floor effects, sound system and LED wall. Positions and lengths use metres. |
| `cues` | Array in playback order. Each cue has a unique `id`, a display `name`, `tag`, hex `accent` and a partial desk `state`. Optional `screen` sets the main-wall media. |
| `look`, `activeCueId` | Complete current desk settings and the current cue ID, or `null`. Desk changes made after calling a cue belong in `look`. |
| `controls` | Optional named camera preset and music volume from zero to one. |
| `media` | Optional current transport references for both music and the main LED wall. |
| `timeline` | Optional recording with integer `durationMs` and an ordered `events` array. |

Cue states apply as top-level changes. For example, `{"masterDimmer":0.72}` changes just the master, while a cue that changes `led` supplies the whole LED object. Use `followSeconds` for a timed advance after a cue is called. Valid values are greater than zero and at most 3,600. Omit it for manual GO.

A nonempty recording begins with a complete snapshot at `atMs: 0`, including `look`, `cueId`, `camera`, `volume`, `bump`, `music` and `screen`. Subsequent events contain `atMs` and the fields that changed. The six bump flags represent the pressed state of the blinder, strobe, CO₂, smoke, laser and motor-drop controls. Event times must be nonnegative, nondecreasing integers no later than `durationMs`. Apply simultaneous events in file order. Event cue IDs are historical and may survive the deletion of a cue. Replay the recorded look in those events.

A music reference stores its kind (`demo`, `file`, `live` or `none`), display name and playing state. Audio files may include a position in seconds. The built-in score may include `demoStep`, measured in sixteenth notes from zero to 1,024, including fractional positions. Screen media uses `target: "main-led"`, kind `video`, `image` or `none`, its name, playing state and optional position in seconds. Files are identified by basename. Reopening the show on another machine requires access to matching local files. The built-in score travels with the app.

The reader validates the current cue ID, focus marks and motor targets against the show. Within the rig, list IDs are unique, motor limits must be ordered, adjacent truss vertices must be at least 0.25 metres apart and the fixture count may reach 1,024 across the two universes. The exporter clears temporary media URLs and omits session-only data. Existing rig-only `.stageforge.json` files keep their original format.

## Reuse and interoperability

The file format, schema, example show and reference reader are available under the repository's MIT license. Projects are ordinary JSON and can be created, edited and validated offline. The schema URL identifies the format; the StageForge reader uses a bundled copy. Your own show files and media retain the licenses you choose for them. [Reference implementation](../src/data/showFile.ts) · [License](../LICENSE)

DXF carries a plan drawing, glTF 2.0 GLB carries a static stage scene, and CSV lists the simulated channel patch. Use the show JSON for the timed performance. StageForge records desk changes, named camera selections, effect-button states and media transport. The timeline does not include live microphone samples, mouse orbit trajectories, design-edit history, or frame-by-frame DMX universe output. [Khronos glTF](https://www.khronos.org/gltf/) · [Unreal Engine glTF import](https://dev.epicgames.com/documentation/en-us/unreal-engine/importing-gltf-files-into-unreal-engine)
