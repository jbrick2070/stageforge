# StageForge Native

StageForge Native is a Godot 4 desktop rehearsal prototype for Windows x64 and macOS. Open the supplied Split Rig show to rehearse a 16-second performance. The native build projects separate MP4s onto two stage surfaces and renders the saved beam and wash colors, focus, and laser reveal.

## Use the desk

- **Play** runs the recorded show from its current position. Use the scrubber or a timestamped cue to jump while playing or paused. The clock controls the music and both walls. The second screen holds its frame during the laser reveal while the main wall plays.
- **Stage plan** opens a top-down drawing. Choose **Draw truss** and click two endpoints. Place a speaker hang, inflatable or scenic piece, then select it to change its properties. A hang exposes X, height, Z, yaw, tilt, box count and splay. Apply to see the layout in 3D. **Work lights** illuminate the design independently of its cues. Turn them off to rehearse the opening blackout.
- **Wall cue** lets you pick a wall and show time, choose a local video, and set a start offset. **Play**, **Hold** and **Clear** affect only that wall. The primary wall uses the show's recorded screen events. Each additional wall has a separate transport.
- **Save show as…** writes a single v3 `.stageforge.show.json` for a design with an extended stage. It copies available referenced media beside the show and reports missing media or filename conflicts. Move the show and its media together. **Open show…** reads versions 1–3. The browser desk preserves v3 stage data on a show round trip and previews its primary screen and rig.
- Split Rig includes a stereo render of the original Arena Anthem score's first 16 seconds at 128 BPM. The native player also accepts a show's local Ogg Vorbis, WAV or MP3 track. Native rehearsal currently covers recorded cue occurrences, a simplified stage, beam and wash groups, and the example laser looks. The web desk still has the full effects programmer, fixture optics editor, controller mappings and CAD exports.

## Build

Use Godot 4.7.2 standard with matching export templates and Python 3. The project uses Direct3D 12 on Windows and Metal on macOS. Prepare the shared show assets and pinned video extension from the repository root.

```sh
python native/tools/prepare_examples.py
python native/tools/prepare_video.py
godot --editor --path native --import
godot --path native
```

For an offline dependency installation supply `--archive /path/to/native_video-v0.4.1.zip` to the second command. On macOS use the graphical editor import command above. To export, create the desired output directory, then run the appropriate command on the target machine. Keep the Windows executable, PCK and DLLs together. The macOS preset uses the stock universal template.

```sh
godot --headless --path native --export-release "Windows Desktop" /absolute/output/StageForge.exe
godot --headless --path native --export-release "macOS" /absolute/output/StageForge.zip
```

The native video extension uses the operating system's decoders. H.264 is the bundled example format. HEVC depends on the OS decoder and the input's encoding. The Windows native texture import path requires D3D12. [Video extension source and compatibility](https://github.com/claytercek/godot-native-video/tree/v0.4.1)

## Verification

Run the clock and drawing checks after project import.

```sh
godot --headless --path native --script res://tests/show_clock_test.gd
godot --headless --path native --script res://tests/plan_editor_test.gd
godot --headless --path native --script res://tests/authoring_test.gd
```

To exercise the actual GPU, launch an exported app with `-- --qa-report=/absolute/path/report.json`. The Split Rig check renders at 1920 × 1080, records frame intervals during simultaneous playback, samples both projected wall surfaces, and checks a backward cue jump and ending blackout. It writes a JSON report and adjacent finale screenshot. The full-HD media benchmark uses separate 1920 × 1080 inputs. The bundled rehearsal uses two 448 × 252 inputs.

[Native clock and media fields](clock-format.md) · [Public v3 show schema](../public/schemas/show-v3.schema.json) · [Godot license](https://godotengine.org/license/)
