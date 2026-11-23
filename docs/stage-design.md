# Stage design architecture

The stage plan is part of the saved rig. The editor, 3D renderer, simulated DMX patch and production estimate read the same document. An example rig and a design started on an empty grid follow the same path through the application.

## Coordinates and ownership

Plan coordinates use metres. X runs across the stage. Positive Z points toward the audience. Y is elevation above the venue floor. Each deck module has a stable ID, a centre, a width, a depth and a top elevation. Adjoining modules make wings and thrust stages. Where modules overlap, the highest surface supports the equipment. The estimate counts the deck material for each specified module.

A custom truss is one pod with a world position, elevation, rotation and an ordered path in its local XZ plane. Each adjacent pair of points defines a span. A repeated first point at the end closes the run. Path length drives truss quantity, mount distribution and the displayed length. Moving a pod moves its fixtures and motor targets together. Editing an individual vertex changes the steel and mount locations while keeping the pod and fixture-group IDs and patch addresses.

## Editing and playback

The plan editor owns a draft while it is open. Applying the draft updates the rig as one change. Closing without applying leaves the running stage available. Rig builder handles fixture inventory, patching, PA, video and scenery. The show director operates the fixtures actually installed in the design. A bare venue can therefore be equipped progressively.

The renderer constructs deck surfaces and truss spans from the document. Floor fixtures and scenery use the deck height at their position. Beam pools use the same rectangles and elevations for light and shadow. The DMX allocator indexes fixture groups separately from geometry, so reshaping a run does not consume new addresses.

## Saved rigs

New designs record `schemaVersion: 1`. A legacy rig with no `platforms` uses its original rectangular deck and factory truss shapes. An explicit empty `platforms` array represents bare venue floor. New designs store their deck modules and local truss vertices in JSON. Dimensions used for venue framing and the cumulative length of a custom path are derived when applying or importing a plan. On reload the application restores the latest applied design and its equipment from browser storage. JSON exports are portable named copies.
