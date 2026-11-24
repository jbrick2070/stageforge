# MVR exchange

StageForge reads and writes **MVR 1.6** (My Virtual Rig, DIN SPEC 15801:2023-12) with **GDTF 1.2** fixture profiles (DIN SPEC 15800:2022-02), the open format used by grandMA3, Vectorworks Spotlight, Capture, Depence, Unreal Engine's DMX plugin and BlenderDMX.

- **Export:** Show files → *Rig for consoles and visualizers (MVR)*, or File → Export → MVR scene on the desktop.
- **Open:** Show files → *Open show or rig…*, or File → Open on the desktop, and choose an `.mvr` file.

The codec lives in `src/interchange/mvr/` and runs in the browser, the sandboxed desktop renderer and Node tests, with no native modules or WebAssembly.

## What is exported

| StageForge | MVR |
|---|---|
| Deck modules, scenery and layout props | `SceneObject` with a GLB box |
| Truss pods (box, ring, chevron, path) and layout trusses | `Truss` with one GLB box per straight span |
| Beams, washes, strobes, blinders, lasers, floor effects | `Fixture` with a StageForge generic GDTF profile and mode `StageForge` |
| Main and secondary LED walls | `VideoScreen` with a GLB panel |
| Speaker hangs | `SceneObject` (aim yaw in the matrix) |
| Focus points (deck centres, audience) | `FocusPoint` |

The generic GDTF profiles follow the channel order StageForge's simulated desk writes: moving heads are Pan, Tilt, Dimmer, Red, Green, Blue, Zoom, Shutter/Strobe; strobes are Dimmer, Strobe; blinders and atmospheric effects are a single output channel; lasers are Dimmer, Pattern, Size X/Y, Speed, Rotation, Beam count, Strobe. Addresses are absolute: `(universe − 1) × 512 + channel`. StageForge's simulated patch reserves a fixed footprint per fixture type (from the fixture catalog), which can be wider than the generic profile's mode, so units keep StageForge's addresses and the spare channels between them stay unused.

Each object's UUID is derived from its StageForge ID (UUID version 5), so the same rig exports the same UUIDs every time, which lets other tools merge updates.

The scene validates against the official MVR 1.6 and GDTF 1.2 XSDs.

## Coordinates

StageForge is right-handed with Y up, in metres, with +Z toward the audience. MVR is right-handed with Z up, in millimetres. A StageForge point `(x, y, z)` is written as `(1000·x, −1000·z, 1000·y)`, so the audience sits toward MVR −Y. Yaw keeps its sign (a rotation about StageForge +Y is the same rotation about MVR +Z). GDTF models fixtures hanging, so floor fixtures are written rotated 180° about X.

## Round trips

An export also carries the complete StageForge rig and stage overlay in `StageForge_show.json`, flagged by a `StageForge` entry in the scene's `UserData`. Opening a StageForge MVR restores it exactly, including cues-relevant IDs, walls, wall cues and hang tilt and splay. If another tool moved a rig truss (same UUID), the move is applied; moved screens, hangs, decks, props and layout trusses, added fixtures and single-fixture readdressing are reported rather than merged, because the payload stays the source of truth and StageForge patches whole fixture groups.

## Files from other tools

Other tools' MVR files become:

- **Trusses** as box trusses sized from their GLB geometry (3 m when the geometry is a 3DS mesh or symbol).
- **Fixtures** typed from their GDTF (attributes, beam type, laser geometry, or the name when the profile is missing; static colour fixtures such as RGB pars have no closer StageForge type and become blinders), hung on their parent truss, the nearest truss within 1.5 m, or a new position bar per height and depth. Floor effects stand on the deck. Addresses are kept in universes 1–2; other fixtures take free addresses. StageForge spaces fixtures evenly along each truss, so positions on long bars are approximate.
- **Video screens** as secondary walls (up to 8) sized from their geometry.
- **Scene objects** as scenic layout props.
- **Focus points**, supports and projectors are skipped.

Objects with unreadable matrices or more than 10 km from the origin, and more than 256 trusses or 1,024 fixtures, are left out. The import toast lists anything that changed.

## Limits of this release

- No MVR-xchange (live network sync) yet.
- Manufacturer GDTFs are read for type and footprint only; their DMX channel layouts aren't simulated.
- A foreign file's unrecognised XML isn't preserved on re-export.
- Hang tilt and splay reach other tools only through the StageForge payload (the hang matrix carries yaw).
