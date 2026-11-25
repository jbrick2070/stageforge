# StageForge Show Paperwork

StageForge generates five production paperwork sheets directly from the same resolved rig geometry, fixture placements, rigging load solver, electrical power report, and show cue stack used by the 3D engine, MVR 1.6 export, and DXF plan export.

Access paperwork in **Gear & production → Paperwork** (or download individual CSV tables from **Show files → Exchange formats**).

## The Five Sheets

| Sheet | Sort Order | CSV Filename | Print Page |
|---|---|---|---|
| **Patch Sheet** | DMX Universe → Start Address → Fixture # | `<rig>.patch-sheet.csv` | Portrait |
| **Instrument Schedule** | Hanging Position (truss pods, then Stage floor) → Mount # | `<rig>.instrument-schedule.csv` | Landscape (`@page wide`) |
| **Channel Hookup** | Fixture # / Console Channel (`1..N`) | `<rig>.channel-hookup.csv` | Landscape (`@page wide`) |
| **Power & Load Report** | Overhead hoist points, truss spans, other flown loads, 3-phase balance & circuits | `<rig>.rigging-power.csv` | Portrait |
| **Cue Sheet** | Cue stack order (`1..N`) | `<rig>.cue-sheet.csv` | Portrait |

## CSV notes

- **Weight source / Power source** columns (Instrument Schedule and Channel Hookup CSVs) say where each value comes from, per field: `Datasheet` for a verified catalogue value, `Estimate` for a generic allowance or a catalogue value marked unverified. A catalogue fixture can therefore read `Datasheet` for weight and `Estimate` for power. On the Instrument Schedule, on screen and in print, estimated values carry a `*`.
- The Patch, Instrument and Hookup CSVs carry the simulated-channel-map notice in a final `Notes` column.
- Units the rig counts but could not place appear as extra rows with Status `UNPLACED`, so the CSV never silently disagrees with the inventory and power totals.
- Cells that start with `=`, `+`, `-`, `@`, tab or CR are neutralised against spreadsheet formula injection.

Use **Print full book** to print all five sheets in a single packet separated by page breaks (`break-before: page`) with repeating table headers (`thead { display: table-header-group }`).

## Single-Source Parity with MVR and DXF

`src/data/showPaperwork.ts` calls `resolveStudioGeometry(rig, stage?.layout)` and `placeFixtures(resolvedRig)` — the exact pipeline used by `src/interchange/mvr/exportMvr.ts` and `src/data/stageDxf.ts`:

- **Fixture # (`fixtureNumber`)**: 1-based placement index across `placeFixtures(resolvedRig)`. Matches MVR `<FixtureID>`, `<FixtureIDNumeric>`, and `<CustomId>` identically. Note that `hungUnits()` interleaves groups across a truss by fractional position, so `fixtureNumber` and `mountOrder` follow physical hang order rather than group order.
- **Unit # (`unitNumber`)**: 1-based index within the fixture's group. Matches MVR `<UnitNumber>`.
- **DMX Address (`dmxLabel` / `absoluteAddress`)**: `formatDmxLabel(universe, address)` produces `U1.001`, matching DXF `PATCH_TAGS` and XDATA for patched units. The DXF text for a conflicting or overflowing unit adds ` (invalid patch)`, which the paperwork shows in its `Status` column instead. `absoluteAddress` equals `(universe - 1) * 512 + address` when patched (`status === 'ok'`) and `null` when conflicting or overflowing (matching MVR omitting `<Addresses>` for unpatched units).
- **World Coordinates (`x`, `y`, `z`)**: StageForge world metres (Y up, +Z toward audience). MVR multiplies by 1,000 with axis swap `(1000x, −1000z, 1000y)`.
- **DXF Block (`dxfBlock`)**: Computed by shared `dxfBlockName(type, catalogId)` in `src/data/equipmentSymbols.ts` (`SF_<TYPE>` for default-family fixtures, `SF_<TYPE>_<FAMILY>` for distinct catalogue body families), identical to `stageDxf.ts`.
- **Circuit & Phase (`circuitId`, `phase`)**: Indexed directly from `computePowerReport()` via `unitCircuitIndex(power)` so deduplicated circuit IDs (`#1`, `#2`), multi-circuit splits (`-01`, `-02`), pinned phases, and single-phase `L1` assignments never drift from the **Rigging & power** tab.
- **Unplaced Fixture Detection**: If any rig group contains units that `placeFixtures()` could not mount (for example, a degenerate truss path with zero mount slots), StageForge surfaces an explicit unplaced-fixture alert on screen and in print rather than silently diverging from inventory or power totals.

## Backwards Compatibility & Safety

- **Legacy `patchCsv()`**: The original per-channel `<rig>.patch.csv` export remains unchanged. The new `<rig>.patch-sheet.csv` provides one row per physical fixture unit.
- **CSV Formula Neutralization**: Every paperwork CSV uses `formatCsv(..., { bom: true })` (RFC 4180 + UTF-8 BOM + leading `=`, `+`, `-`, `@`, `\t`, `\r` neutralization) so untrusted model or cue names cannot execute spreadsheet formulas.
- **Notices & Disclaimers**:
  - Patch Sheet and Full Production Book note that StageForge uses a simulated channel map — verify real fixture DMX footprints against the fixture's GDTF mode before live output.
  - Power & Load sheets carry the simplified static guidance disclaimer (not structural engineering sign-off); see [rigging-power.md](rigging-power.md).
  - Cue Sheet rows with laser `audienceScan` enabled display the shared IEC 60825 / ANSI Z136 crowd-scan warning from `src/data/laserSafety.ts`.
