# StageForge 3D

StageForge is an open-source concert stage designer and simulator for Windows, Apple Silicon Macs and desktop browsers. Build a stage, program cues, and record or replay a performance from the lighting desk. Phones open in the player, with **Show desk** available when needed.

[Launch StageForge in your browser](https://jbrick2070.github.io/stageforge/)

![Arena show with steel-blue and amber lighting, inflatable tentacles and flown line arrays](docs/stageforge-arena.webp)

## Run locally

Use Node.js 22.12 or later and a browser with WebGL 2 enabled. From the project directory, run

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite. The default is [127.0.0.1:5173](http://127.0.0.1:5173/).

Run `npm test` to check rig compatibility, deck surfaces and truss patching. To compile the TypeScript and build a production copy, run `npm run build`. Run `npm run preview` to inspect the generated site locally.

## Desktop apps

The retired Godot prototype is preserved at the `native-v0.1.0` tag. Studio opens its v3 show files and `.stageforge.zip` bundles, including secondary walls, wall cues and aimed speaker hangs.

The Electron editions bundle the renderer, fonts, fixtures and demo score. They run offline and keep their own saved stage. Show files and rig files open in both desktop apps and the browser.

- On **Windows x64**, open the portable StageForge executable.
- On an **Apple Silicon Mac**, extract the ZIP and open **StageForge.app**.
- Use **File → Open show or rig** and **File → Save show as** for project files, and the **View** menu for full screen. In the plan editor, **Apply design** commits your draft before you export.

To build from source, run `npm ci`, then `npm run desktop:win` on Windows or `npm run desktop:mac` on an Apple Silicon Mac. The packages appear in `desktop/build/release/`. Run `npm run desktop:start` to open the desktop app during development. These local builds do not carry a publisher certificate or Apple notarization.

## Open show files and exchange formats

Open **Files** next to **Design stage**. Choose the format for the next person who will use the file.

| File | Contents |
| --- | --- |
| `.stageforge.show.json` | Editable show, rig, ordered cues, lighting and effect parameters, focus targets, camera and volume, timestamped take, music and screen-media references |
| `.dxf` | Layered CAD plan in metres, including elevations, truss paths and fixture symbols |
| `.glb` | Self-contained static 3D stage for glTF 2.0 tools, including Blender and Unreal Engine |
| `.patch.csv` | Simulated DMX addresses and channel functions, one row per channel per fixture |
| `.stageforge.json` | StageForge rig geometry, scenery and equipment patch |

Use **Show cues → Edit cue list** to name and order your cues. **Add current look** captures the live desk. Set **Follow after** to advance automatically after a cue, or leave it empty to wait for **GO**. **Hold follow** cancels a pending advance.

The desk shows the current cue and the next one. Changing a look marks the current cue **Modified** and keeps its place. **GO** and Xbox D-pad right advance from there. A timed follow keeps counting through a manual edit. After the final cue, **Next** shows the first cue with a **Wrap** indicator. Removing cues in the editor moves forward and offers **Undo remove**.

Choose **Record take**, perform the show, then **Stop recording**. **Replay take** starts its recorded action sequence at zero. **Files → Recorded actions** shows what changed at each timestamp. **Save show JSON** writes the complete project. StageForge records desk and transport changes, including momentary effects, camera selections, music, and the main LED wall. The recording uses stage lighting parameters rather than a sampled DMX packet stream.

The project identifies local music, video and still images by filename. Carry those files with the show. On the destination, use **Files → Relink media files** to select them. The built-in score travels with the app. Live microphone samples and uploaded media bytes stay outside the JSON.

If a file is missing, click the missing-media button to relink it. A cue that calls an unavailable clip shows its filename on the LED wall. New video cues start at zero unless you select **Store cues at current video position** or edit the cue's start time. For a local soundtrack, use **Audio → Restart 0:00** or scrub to your rehearsal mark before recording.

Choose **Files → Open Split Rig rehearsal → Show cues → Replay take** for a 16-second example. In **Lighting**, select **Beams** or **Washes** to change their movement, focus and colors independently. In **Lasers**, select a projector to change its ray count, pattern resolution and colors. **Rig builder** holds the optical profiles and LED cabinet dimensions.

The project specification, schemas, examples and implementation are public under the repository's MIT license. [Show format](docs/show-format.md) · [Version 2 schema](public/schemas/show-v2.schema.json) · [Split Rig example](public/examples/split-rig.stageforge.show.json) · [License](LICENSE)

## Draw the stage plan

Choose **Design stage** beside Play to open the plan view. Start a blank design or edit the current rig. Draw deck modules at different heights to make platforms, wings and runways. Click points to draw a truss, then finish the path. Move its vertices to change the span or corners. The plan uses metres, with the audience downstage.

**Apply design** builds the 3D stage from the drawing. Open **Rig builder** to equip the trusses with lights, set their motors, add floor effects and place PA or scenery. This browser saves the applied design and subsequent equipment changes. Reloading restores that stage and its fixture patch. After exploring a different rig, **Open saved design** brings the saved plan back into the editor. Export named rig JSON files to keep several designs or open them on another device. The arena, festival, warehouse and starter rigs are also available as starting points.

- Under **Inflatables & stage props**, add a tentacle, foil star, arch, marquee tower or performance riser. Select a placed piece to change its color, position, size and rotation.
- Configure the PA with **Flown boxes per side**, **Monitor wedges** and **Subwoofers**. Each flown array supports 4–12 cabinets, the deck supports up to eight monitor wedges, and the sub wall supports 2–16 cabinets in pairs.
- The arena and festival rigs use original 3D models sized to L-Acoustics’ published cabinet dimensions. **Speaker system** also offers a generic touring rig. The PA models provide a visual reference. The production budget uses illustrative prices. Manufacturer specifications are available for the [K2 array](https://www.l-acoustics.com/products/k2/), [KS28 subwoofer](https://www.l-acoustics.com/products/ks28/) and [X12 monitor](https://www.l-acoustics.com/products/x12/).
- Use the download and upload buttons at the top of **Rig builder** to save and restore a rig as JSON. The file includes scenery and speaker settings.

The plan format, fixture attachment rules and rendering flow are described in [Stage design architecture](docs/stage-design.md).

## Run a show

The stage opens in blackout. To preview the rig before playback, open **Rig builder**, select a camera or tap a cue. **Play demo** starts the concert from black even after a preview.

1. Press **Play demo**. At the default 128 BPM, the stage stays completely dark for two bars (3.75 seconds). A pair of amber backlights fades up in bars 3–4. More beams join in bars 5–6, followed by washes in bars 7–8. The video walls ease in during the groove, and lasers enter during the build. The first full-rig hit lands at 0:45. The breakdown at 1:00 leads into a second build, the finale at 1:30 and a curtain call at the end of the two-minute set. **Pause** holds your place and **Replay demo** repeats the opening blackout. Open **Audio** to change tempo, load your own track or use a microphone.
2. To run the opening again at any point, choose **Audio → Restart demo**. If a track or microphone is active, choose **Audio → Return to demo**. Select a pad in **Show cues** for an immediate lighting change. To save a look for this session, choose **Store cue** and then a destination pad.
3. **Auto-LD** follows the demo score from the first bar. Select a cue or edit a fixture to take over the lights while the music continues. Turn **Auto-LD** back on to rejoin the current phrase. The master dimmer, blackout, camera and momentary effects stay under your control.
4. Open **DMX** to inspect simulated channel values and fixture patches in either 512-channel universe. **Cost & crew** shows an illustrative production estimate for the current rig.

| Keyboard | Action |
| --- | --- |
| Space | Toggle blackout |
| B / S | Hold blinders / strobe |
| C / F | Hold CO₂ / smoke |
| L / D | Hold laser hit / rig drop |
| 1–6 | Select show camera |
| 7 | Inspect the PA up close |
| H | Toggle cinema mode |

## Xbox controller

Connect a standard-mapped Xbox controller by USB or Bluetooth, focus the show, and press a button to connect. Open **Controller** on the stage for its connection status and bindings. If the browser asks for an audio gesture, click **Play demo** once.

| Controller | Action |
| --- | --- |
| A | Play, pause, resume or replay |
| D-pad left / right | Previous / next cue |
| D-pad up / down | Raise / lower the master by 5 percentage points |
| LB / RB | Previous / next camera |
| Right stick | Orbit the camera |
| B / X / Y | Hold blinders / laser hit / CO₂ |
| LT / RT | Hold smoke / strobe |
| View / Menu | Toggle Auto-LD / cinema mode |

## License

[MIT](LICENSE)
