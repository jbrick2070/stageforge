# Deep House performance desk

Open **Show files → Open Deep House rehearsal** to load Signal Room. The sample opens silent and uses StageForge’s procedural visuals. The APC40 desk works with the keyboard and mouse. Its color rows address lighting and the virtual RGB laser independently on the bundled custom-color look. The wall follows the lighting palette and has its own pattern and brightness controls.

| Control | Assignment |
| --- | --- |
| Pad rows 1 and 2 | Red, Amber, Yellow, Green, Cyan, Blue, Violet, White for lighting and the virtual laser |
| Pad row 3 | Two-color lighting palettes |
| Pad row 4 | Wall patterns and moving-light looks |
| Pad row 5 | Eight cue looks |
| Scene buttons | Intro, Groove, Build, Peak and Close |
| Track faders 1–8 | Beam, wash, virtual laser, wall brightness, haze, simulated lift, movement speed, beam width |
| Master fader | Desk master dimmer |
| Stop All Clips | Latch the operator blackout. Clear it from the existing StageForge desk. |

To connect, expand **APC40 mkII MIDI connection**, enable MIDI access and choose both ports. The two ports must identify as a single unambiguous APC40 mkII pair. StageForge checks the model and initializes the controller before sending pad colors. Faders pick up when they reach or cross the current software value. StageForge clears the controller binding when its session or rehearsal scope changes. Reconnect explicitly after unplugging or replacing a show.

The controller is scoped to the editable Deep House U3 rehearsal with physical output off. Chase and take playback suspend cues, pads and faders while retaining the blackout latch. The lift only moves a simulated pod in Manual mode. The sample does not arm or send output, and the controller does not configure Sync.

The test suite uses an Akai protocol mock for SysEx, selection and LED messages. Physical APC40 mkII USB identity, LED colors and pickup remain unverified on the authorized Mac mini and RTX 4060.
