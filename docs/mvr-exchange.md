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
| Beams, washes, strobes, blinders, lasers, floor effects | `Fixture` with a StageForge generic GDTF profile and mode `StageForge` (or the original manufacturer GDTF when imported in the same session) |
| Main and secondary LED walls | `VideoScreen` with a GLB panel |
| Speaker hangs | `SceneObject` (aim yaw in the matrix) |
| Focus points (deck centres, audience) | `FocusPoint` |

The generic GDTF profiles follow the channel order StageForge's simulated desk writes: moving heads are Pan, Tilt, Dimmer, Red, Green, Blue, Zoom, Shutter/Strobe; strobes are Dimmer, Strobe; blinders and atmospheric effects are a single output channel; lasers are Dimmer, Pattern, Size X/Y, Speed, Rotation, Beam count, Strobe. Addresses are absolute: `(universe − 1) × 512 + channel`. StageForge's simulated patch reserves a fixed footprint per fixture type (from the fixture catalog), which can be wider than the generic profile's mode, so units keep StageForge's addresses and the spare channels between them stay unused.

Each object's UUID is derived from its StageForge ID (UUID version 5) on first export, or captured from an imported MVR file, and persisted in the show v4 `interchange` block so re-exports keep every object's UUID stable across saves and round trips.

The scene validates against the official MVR 1.6 and GDTF 1.2 XSDs.

## Coordinates

StageForge is right-handed with Y up, in metres, with +Z toward the audience. MVR is right-handed with Z up, in millimetres. A StageForge point `(x, y, z)` is written as `(1000·x, −1000·z, 1000·y)`, so the audience sits toward MVR −Y. Yaw keeps its sign (a rotation about StageForge +Y is the same rotation about MVR +Z). GDTF models fixtures hanging, so floor fixtures are written rotated 180° about X.

## Persistent identity and XML passthrough (Show v4)

When you import an MVR file from another tool—or export a StageForge show to MVR for the first time—StageForge records an additive `interchange` block (saved as show format v4; shows that never touch MVR continue to save as v1–v3):

- **Persisted UUIDs (`interchange.mvr.uuids`):** Maps each StageForge object key (`layer:stageforge`, `truss:<id>`, `fixture:<key>`, `wall:<id>`, `prop:<index>`, `deck:<id>`, `scenery:<id>`, `hang:<index>`, `focus:<id>`) to its canonical uppercase MVR UUID.
- **Synthetic position bars (`interchange.mvr.synthetic`):** When a foreign MVR has free-floating hung fixtures with no parent or nearby truss, StageForge creates temporary position bars (`mvr-position-N`) to display them and marks their IDs synthetic so re-export omits those invented `<Truss>` nodes while still exporting the fixtures.
- **Bounded XML passthrough (`interchange.mvr.passthrough`):** Preserves other tools' XSD-valid XML up to 8 MiB UTF-8 total:
  - Foreign `<UserData><Data>` entries (excluding StageForge's own marker).
  - `<Scene><AUXData>` entries (`Symdef`, `Position`, `MappingDefinition`, and non-colliding `Class` entries).
  - Unmodeled or skipped scene objects (`Support`, `Projector`, foreign `FocusPoint`, `GroupObject` subtrees that contain no StageForge-imported gear, plus any overflow/unplaced objects beyond StageForge's caps).
  - Optional XSD-valid `<Fixture>` child elements (`Color`, `Focus`, `Position`, `Function`, `CastShadow`, `CustomCommands`, `Mappings`, `Connections`, `Protocols`, `Alignments`, etc.), re-emitted in strict MVR 1.6 XSD sequence order.
- **In-session binary resources:** Manufacturer `.gdtf` archives, `.glb`/`.3ds` meshes and textures from an imported MVR are held in memory during the session (up to 128 MiB) and re-bundled untouched when re-exporting. If you save a v4 `.stageforge.show.json` and reload it in a fresh session, the XML passthrough and UUIDs still survive, while unbundled `Geometry3D` file references are stripped and fixtures fall back to bundled StageForge generic GDTF profiles (with a note) so the re-exported `.mvr` stays self-contained.
- **Known passthrough trade-offs:**
  - Sibling XML elements inside preserved fragments are grouped by tag name when rebuilt (`fast-xml-parser` object representation).
  - `GroupObject` wrappers that contain StageForge-imported fixtures or trusses are flattened into world matrices (with a note); `GroupObject` subtrees holding only unmodeled objects stay intact.
  - Sequential console IDs (`FixtureID`, `FixtureIDNumeric`, `UnitNumber`, `CustomId`) are regenerated in `placeFixtures` order on export.
  - Because `fixture` keys include `podId` and layout `prop`/`hang` keys are indexed, moving a fixture group to another truss pod or deleting an earlier layout prop/hang changes its key.

## Round trips

An export also carries the complete StageForge rig, stage overlay and `interchange` metadata in `StageForge_show.json`, flagged by a `StageForge` entry in the scene's `UserData`. Opening a StageForge MVR restores it exactly, including preserved foreign UUIDs, passthrough XML, cues-relevant IDs, walls, wall cues and hang tilt and splay. If another tool moved a rig truss (matching its persisted UUID), the move is applied; moved screens, hangs, decks, props and layout trusses, added fixtures and single-fixture readdressing are reported rather than merged, because the payload stays the source of truth and StageForge patches whole fixture groups.

## Files from other tools

Other tools' MVR files become:

- **Trusses** as box trusses sized from their GLB geometry (3 m when the geometry is a 3DS mesh or symbol).
- **Fixtures** typed from their GDTF (attributes, beam type, laser geometry, or the name when the profile is missing; static colour fixtures such as RGB pars have no closer StageForge type and become blinders), hung on their parent truss, the nearest truss within 1.5 m, or a synthetic position bar per height and depth. Floor effects stand on the deck. Addresses are kept in universes 1–2 (supporting 0-based MVR `<Address break="0">` and multi-break reads); other fixtures take free addresses. StageForge spaces fixtures evenly along each truss, so positions on long bars are approximate.
- **Video screens** as secondary walls (up to 8) sized from their geometry.
- **Scene objects** as scenic layout props.
- **Focus points, supports and projectors** are skipped in the 3D view and preserved in `interchange.mvr.passthrough` for re-export.

Objects with unreadable matrices or more than 10 km from the origin, and more than 256 trusses or 1,024 fixtures, are left out of the live rig and preserved in passthrough when within the 8 MiB cap. The import toast lists anything that changed.

## Cross-tool verification checklist (manual)

Automated tests cover round trips, XSD structure, edge cases (CIE xyY, DMX breaks 0 vs 1, reversed physical ranges, multi-instance LED wall `GeometryReference` footprints) and passthrough. Run this manual checklist against real third-party peers whenever you change the MVR/GDTF codec.

### Peer A: BlenderDMX (free, Blender add-on)

1. **Export from StageForge:**
   - Open StageForge, load *Split Rig rehearsal* (or any show with a yawed truss, hung moving heads, a floor unit, a secondary LED screen and PA hangs).
   - Export via **Show files → Rig for consoles and visualizers (MVR)** and save as `stageforge-check.mvr`.
   - Also save the show via **Show files → Save show JSON** and verify it writes `"version": 4` with `interchange.mvr.uuids`.
2. **Import into BlenderDMX:**
   - In Blender with BlenderDMX enabled, open **DMX → Import → MVR** and select `stageforge-check.mvr`.
   - Verify no import errors in Blender's system console.
   - Check coordinates & orientation:
     - Audience is toward Blender `−Y`, upstage toward `+Y`, height is `+Z`.
     - Front truss is at the expected height and yaw (`+30°` rotates consistently).
     - Hung moving heads hang lenses-down beneath the truss; floor units sit upright on the stage deck.
     - Secondary LED screens and PA hangs appear at the right positions and facing angles.
   - Check DMX patch in BlenderDMX's fixture list:
     - Every fixture's universe and start address matches StageForge's **DMX Monitor** / **CSV patch**.
     - Each generic StageForge GDTF profile loads its `StageForge` mode cleanly (Pan, Tilt, Dimmer, RGB, Zoom, Shutter).
3. **Edit in BlenderDMX and re-import into StageForge:**
   - Move one rig truss by `+1.0 m` in Blender `+Y` (upstage) and rotate it by `10°`.
   - Re-address one fixture (change its DMX address) and optionally add a BlenderDMX FocusPoint or Support.
   - Export MVR from BlenderDMX as `blenderdmx-edited.mvr`.
   - Open `blenderdmx-edited.mvr` in StageForge (**Show files → Open show or rig…**).
   - Verify:
     - The moved truss snaps to the new StageForge position (`z − 1.0 m`, updated yaw) and the toast reports `Moved <truss name> to match the MVR file`.
     - The single-fixture address change is reported in the toast without corrupting StageForge's group patch.
     - Existing cues, recorded takes, walls, wall cues and linked media remain untouched.
4. **Reverse direction (foreign MVR passthrough):**
   - Build a small rig in BlenderDMX containing a truss, two hung fixtures, one floor fixture, a FocusPoint, and a Support (or custom fixture colour/function metadata).
   - Export from BlenderDMX as `from-blender.mvr`.
   - Import `from-blender.mvr` into StageForge, move the floor fixture in the Stage Designer, save a v4 `.stageforge.show.json`, and export MVR as `roundtrip-blender.mvr`.
   - Re-import `roundtrip-blender.mvr` back into BlenderDMX:
     - Verify the moved floor fixture appears at its new position.
     - Verify the original FocusPoint, Support and every object's UUID survived without creating duplicate fixtures or synthetic truss bars.

### Peer B: grandMA3 onPC (free)

1. **Import StageForge MVR into grandMA3 onPC:**
   - Start a new show in grandMA3 onPC.
   - Copy `stageforge-check.mvr` into the MA3 `gma3_library/mvr` folder (or USB `grandMA3/shared/resource/lib_mvr`).
   - Open **Menu → Patch → Import MVR** and select `stageforge-check.mvr`.
   - Verify in **Patch** and **3D**:
     - All fixtures import with StageForge's generic GDTF fixture types and exact Universe.Channel addresses (check both Universe 1 and Universe 2).
     - In the MA3 3D window, trusses, hung fixtures, floor fixtures, LED screens and stage decks align with StageForge's 3D viewport (audience at `−Y`, stage decks at the right height, floor units upright).
     - Test bringing up Dimmer + RGB + Pan/Tilt in MA3 programmer on a moving head and confirm the channel order matches StageForge's DMX Monitor.
2. **Edit in grandMA3 onPC and re-import into StageForge:**
   - In MA3 Patch/3D, move one rig truss `1.0 m` upstage (`PosY +1.0`) and change one fixture's patch address.
   - Export via **Patch → Export MVR** as `ma3-edited.mvr`.
   - Open `ma3-edited.mvr` in StageForge.
   - Verify:
     - The truss move merges by UUID (`Moved <truss>` note in toast).
     - The single-fixture re-addressing is reported cleanly in the toast.
     - Cues, wall cues, takes and linked media remain intact.
3. **Reverse direction (MA3-authored MVR with manufacturer GDTF & MA3 metadata):**
   - Create a small MA3 show with a manufacturer GDTF fixture (e.g., an RGBW moving head or multi-instance LED bar), a truss, and MA3 `UserData` / `Position` / `FocusPoint` entries.
   - Export as `from-ma3.mvr`, open in StageForge, move a floor fixture (or truss), and re-export MVR as `roundtrip-ma3.mvr`.
   - Re-import `roundtrip-ma3.mvr` into MA3 via **Import MVR** (merge):
     - Verify MA3 matches fixtures and trusses by their original UUIDs (no duplicate fixtures created).
     - Verify MA3's `UserData`, `AUXData` (`Position`/`Symdef`), `FocusPoint` and fixture metadata survived, and the manufacturer GDTF was re-bundled untouched during the same session.

## Limits of this release

- No MVR-xchange (live network sync) yet.
- Manufacturer GDTFs are read for type, per-break / multi-instance footprint, channel functions and emitter colours; their custom DMX channel layouts aren't simulated by the live desk yet.
- Binary archive assets (manufacturer `.gdtf`, `.3ds`, `.glb`) are preserved across in-session re-export, not embedded into v4 `.stageforge.show.json` files.
- Hang tilt and splay reach other tools only through the StageForge payload (the hang matrix carries yaw).
