# StageForge Show Paperwork

StageForge generates a six-sheet production paperwork book directly from the same resolved rig geometry, fixture placements, rigging load solver, electrical power report, and show cue stack used by the 3D engine, MVR 1.6 export, and DXF plan export.

Access paperwork in **Gear & production → Paperwork** (or download individual CSV tables from **Show files → Exchange formats**).

## The Production Book (Six Sheets)

| Sheet | Sort Order / Contents | CSV Filename | Print Page |
|---|---|---|---|
| **1. Plot Plan** | True-scale vector plan (1:25–1:250), symbols, fixture numbers & addresses, scale bar, upstage arrow, legend & title block | Print / Save as PDF (vector SVG) | Landscape (`@page plot-a4` / `plot-letter`) |
| **2. Patch Sheet** | DMX Universe → Start Address → Fixture # | `<rig>.patch-sheet.csv` | Portrait |
| **3. Instrument Schedule** | Hanging Position (truss pods, then Stage floor) → Mount # | `<rig>.instrument-schedule.csv` | Landscape (`@page wide`) |
| **4. Channel Hookup** | Fixture # / Console Channel (`1..N`) | `<rig>.channel-hookup.csv` | Landscape (`@page wide`) |
| **5. Power & Load Report** | Overhead hoist points, truss spans, other flown loads, 3-phase balance & circuits | `<rig>.rigging-power.csv` | Portrait |
| **6. Cue Sheet** | Cue stack order (`1..N`) | `<rig>.cue-sheet.csv` | Portrait |

## True-Scale Plot Plan (Sheet 1)

**Print full book** opens with `PlotPlanPage` (`src/data/plotPlan.ts`, `src/components/PlotPlanPage.tsx`) rendered entirely as inline vector SVG — no PDF library is required. Use the browser's or Electron's **Save as PDF** at **100% (Actual size)** on **A4 landscape** (297 × 210 mm) or **Letter landscape** (11 × 8.5 in) with 10 mm margins.

- **Single-source positions:** Every fixture's position (`x`, `z`), rotation (`yaw`), fixture number (`#`), DMX address, and status comes straight from `ShowPaperwork.units` without recomputing placement, so the plot, patch sheet, instrument schedule, MVR, and DXF stay locked together.
- **Rig geometry & symbols:** Trusses and decks come from `resolveStudioGeometry()`, LED walls from `planWalls()` (stock main LED wall + authored secondary screens), and PA hangs from `effectiveHangs()` (stock line arrays + authored hangs). Fixture silhouettes come from `symbolForHardware()` + `specToSvgPath()` in `src/data/equipmentSymbols.ts`.
- **Automatic true scale:** `buildPlotPlan()` picks the largest standard scale (`1:25`, `1:50`, `1:75`, `1:100`, `1:150`, `1:200`, `1:250`) at which the rig bounds plus a 0.5 m margin and 8 mm label clearance fit inside the printable plan area left of the legend and title block. Rigs larger than `1:250` step up to an explicit fit scale (`1:300`, `1:400`, `1:500`, `1:750`, `1:1000`, or nearest 100) with a sheet note that multi-sheet tiling is not supported.
- **Orientation & verification:** Upstage (`−Z`) is at the top of the page (marked with an Upstage arrow) and audience (`+Z`) is at the bottom (marked `DOWNSTAGE / AUDIENCE`), matching the DXF plan. The bottom band includes a metric scale bar (1, 5, and 10 m ticks at scales `≥ 1:75`; 1–5 m at `1:50` and 1–2 m at `1:25` where 10 m physically exceeds the plan column) and a printed check dimension (`10 m = 10000 ÷ scale mm`) to verify 100% print scale with a ruler. In the browser or Electron print dialog, choose the same paper size (`A4` or `Letter` landscape), 10 mm margins, and 100% ("Actual size") scale so the right-hand sidebar is never clipped.
- **Dense clusters & patch issues:** When fixtures are closer than 4 mm on paper, labels offset along the truss normal with leader lines; if full labels still collide, the plot prints fixture numbers only and adds a note pointing to the Patch Sheet. Units with DMX `conflict` or `overflow` status are outlined in red dashed double rings with a `!` marker so they remain legible on monochrome printers too.
- **Legend & title block:** The legend summarises every placed symbol and model (manufacturer, model, count, watts each — matching the Instrument Schedule per model, and summing across DMX modes to match total Inventory counts when `unplaced` is empty) plus line styles for truss, deck edge, LED wall, and PA hang. The bottom-right title block shows the rig name (truncated with an ellipsis if long), venue, designer, revision letter, date, scale, sheet number (`Sheet 1 of 6` in book mode, `Sheet 1 of 1` when printing the plan alone), and the disclaimer *"Design guidance: not for construction. Verify all dimensions, loads and power on site."*
- **Local-only settings:** Paper size (`A4` / `Letter`) and title-block fields are edited under **Plot page & title block** in the Paperwork tab and saved in `localStorage` under `stageforge.titleBlock`. They are never written to show files.

## CSV notes

- **Weight source / Power source** columns (Instrument Schedule and Channel Hookup CSVs) say where each value comes from, per field: `Datasheet` for a verified catalogue value, `Estimate` for a generic allowance or a catalogue value marked unverified. A catalogue fixture can therefore read `Datasheet` for weight and `Estimate` for power. On the Instrument Schedule, on screen and in print, estimated values carry a `*`.
- The Patch, Instrument and Hookup CSVs carry the simulated-channel-map notice in a final `Notes` column.
- Units the rig counts but could not place appear as extra rows with Status `UNPLACED`, so the CSV never silently disagrees with the inventory and power totals.
- Cells that start with `=`, `+`, `-`, `@`, tab or CR are neutralised against spreadsheet formula injection.

Use **Print full book** to print all six sheets (Plot Plan first, then the five tabular sheets) in a single packet separated by page breaks (`break-before: page`) with repeating table headers (`thead { display: table-header-group }`).

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
