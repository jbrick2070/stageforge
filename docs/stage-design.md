# Stage design architecture

The stage plan is part of the saved rig. The editor, 3D renderer, simulated DMX patch and production estimate read the same document. An example rig and a design started on an empty grid follow the same path through the application.

## Coordinates and ownership

Plan coordinates use metres. X runs across the stage. Positive Z points toward the audience. Y is elevation above the venue floor. Each deck module has a stable ID, a centre, a width, a depth and a top elevation. Adjoining modules make wings and thrust stages. Where modules overlap, the highest surface supports the equipment. The estimate counts the deck material for each specified module.

A custom truss is one pod with a world position, elevation, rotation and an ordered path in its local XZ plane. Each adjacent pair of points defines a span. A repeated first point at the end closes the run. Path length drives truss quantity, mount distribution and the displayed length. Moving a pod moves its fixtures and motor targets together. Editing an individual vertex changes the steel and mount locations while keeping the pod and fixture-group IDs and patch addresses.

## Moving-head optics

In **Rig builder**, expand **Fixture optics** under a mounted beam, wash or floor beam. Enter the emitted lumens per fixture and the full beam angle at reference zoom. Each field identifies its source. Clearing an override restores the profile value or generic estimate. The stage preview scales brightness with flux and beam spread. The simulated DMX dimmer keeps the same control value when fixture optics change.

The two built-in optical references pair the published fixture output and beam angle at one zoom endpoint. The CHAUVET Rogue R1 BeamWash narrow setting uses 1,483 lm and 4°. The Martin MAC Aura XIP wide setting uses 6,000 lm and 35.3°. The fixture housing, channel layout and desk zoom remain StageForge simulations. [CHAUVET optical specifications](https://www.chauvetprofessional.com/wp-content/uploads/2019/12/Rogue-R1-Beam-Wash-Cutsheet.pdf) · [Martin optical specifications](https://www.martin.com/pl/site_elements/mac-aura-xip-spec-sheet)

**Import GDTF optics** reads the local archive's beam geometries. Pick an emitter, then choose **Use beam profile**. StageForge reads its declared `LuminousFlux`, `BeamAngle`, fixture identity and geometry name. The show stores those values for offline use. Relative beam brightness and stage footprints are intended for visual rehearsal. Manufacturer DMX modes, photometric measurement files and multi-emitter aggregation are outside this importer. [GDTF specification](https://github.com/mvrdevelopment/spec/blob/main/gdtf-spec.md)

## Editing and playback

Monitor wedges follow the front edge of each deck at their position across the stage. On a thrust stage the middle pair can sit on the thrust while the outside pair stay on the main deck. The video wall follows the upstage edge, even on an off-centre stage.

In **Rig builder**, enable **Main LED Wall** and choose **Build from LED cabinets**. Enter the requested columns and rows, the dimensions of one cabinet in millimetres, and its native pixel dimensions. The main screen takes as many whole rows and columns as fit the venue. Optional side wings use matching cabinets and fit into the remaining width. Each display shows an independent copy of the source video. Its installed columns × cabinet pixel width and rows × cabinet pixel height determine its pixel canvas. The renderer samples that canvas, the GLB includes its dimensions, and the production estimate uses the total installed area across all screens. Changing venue retains the requested grid.

Dimension-only walls from existing shows retain their original aspect ratio when the preview fits them below the overhead grid. The estimate uses their fitted area.

New trusses use the selected venue's grid height to set their starting elevation. The stage designer shows the available height and flags a truss with less than 0.3 m of overhead clearance.

The plan editor owns a draft while it is open. Applying the draft updates the rig as one change. Closing without applying leaves the running stage available. Rig builder handles fixture inventory, patching, PA, video and scenery. The show director operates the fixtures actually installed in the design. A bare venue can therefore be equipped progressively.

### Screens, speaker hangs and the native layout

The plan editor also edits the show's stage overlay (`stage` in show format v3). Its draft holds the rig and the overlay together, so Undo, Redo and Cancel cover both, and Apply keeps existing wall cues.

- **Screen** places a secondary LED wall. Drag a screen to move it, drag its arrow to aim it and drag the edge handle to change its width; `[` and `]` rotate the selection by 5° (15° with Shift). The main LED wall appears too. Editing it pins its resolved position and size, and **Reset to rig LED wall** returns it to the rig placement. Deleting a screen also deletes its wall cues; Undo restores both.
- **Speaker hang** places an aimed line array. The plan draws a nominal 90° horizontal coverage fan. While the rig's stock flown arrays are in effect they appear dashed; editing one, or adding a hang, turns them into authored hangs. **Use rig speaker arrays** removes the override. Removing every hang stores an explicit empty list, which removes the arrays.
- **Layout truss** and **Layout prop** author `layout.trusses` and `layout.props` (inflatable or scenic). **Convert to rig truss** turns a layout truss into a rig truss pod with the same geometry, so fixtures can hang on it.
- **Replace rig layout** sets `layout.replace`: the rig's decks, trusses, floor effects and stock arrays are dimmed on the plan and hidden in 3D and in the CAD plan.

Yaw is a rotation about +Y, as in three.js. A front faces (sin yaw, cos yaw) on the plan, toward the audience at 0°, and a wall's width runs along (cos yaw, −sin yaw). Apply checks the overlay against the v3 schema; an overlay with nothing authored is dropped so plain rigs stay v1 or v2.

The renderer constructs deck surfaces and truss spans from the document. Floor fixtures and scenery use the deck height at their position. Beam pools use the same rectangles and elevations for light and shadow. The DMX allocator indexes fixture groups separately from geometry, so reshaping a run does not consume new addresses.

## Saved rigs

New designs record `schemaVersion: 1`. A legacy rig with no `platforms` uses its original rectangular deck and factory truss shapes. An explicit empty `platforms` array represents bare venue floor. New designs store their deck modules and local truss vertices in JSON. Dimensions used for venue framing and the cumulative length of a custom path are derived when applying or importing a plan. On reload the application restores the latest applied design and its equipment from browser storage. JSON exports are portable named copies.
