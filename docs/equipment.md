# Equipment catalogue and sources

StageForge ships a curated catalogue of touring lighting, LED video panel, atmospheric and show laser equipment in [`src/data/equipmentCatalog.ts`](../src/data/equipmentCatalog.ts). Procedural 3D models, deterministic PBR hardware textures, plan/DXF symbols, and mobile/desktop rendering budgets are documented in [`docs/assets.md`](assets.md). Truss profiles, chain hoists, static rigging load calculations, and three-phase power distribution are documented in [`docs/rigging-power.md`](rigging-power.md). Production paperwork (Patch Sheet, Instrument Schedule, Channel Hookup, Power & Load Report, Cue Sheet, and Full Production Book printing) is documented in [`docs/paperwork.md`](paperwork.md).

## Sourcing policy

- **Manufacturer datasheets & Open Fixture Library:** Weights, power draw, beam/zoom ranges, lumen figures, IP ratings and DMX modes are taken from published manufacturer specification sheets or the MIT-licensed Open Fixture Library.
- **No copied text or media:** Model names identify real hardware only; no datasheet copy, photos, logos or non-permissive GDTF archives are bundled.
- **Honest verification flags:** Any value that could not be independently verified from an authoritative datasheet on the lookup date is listed in `unverified` (both in code and below) and marked with `?` in the UI.
- **Simulated DMX control layout:** Selecting a catalogue model updates its DMX channel footprint, optical defaults (for moving heads) and weight/power estimates. StageForge's live DMX simulator still writes its built-in control layout starting at each unit's start address rather than the fixture's full manufacturer channel map; both the DMX Monitor and Live DMX Badge note this when catalogue fixtures are patched.

### Open Fixture Library notice

Selected DMX mode names and channel counts cross-checked against Open Fixture Library data are used under the MIT License:

> Copyright (c) 2017–2026 Open Fixture Library contributors (MIT License, https://open-fixture-library.org/).

---

## Catalogue entries (verified 2026-11-24)

| ID | Manufacturer & Model | Category | Weight | Power | IP | Optics / Panel | DMX Modes | Sources | Unverified |
|---|---|---|---|---|---|---|---|---|---|
| `claypaky-sharpy` | Claypaky Sharpy | Beam | 19 kg | 350 W? | IP20 | 3.8° | 16, 20 ch | `claypaky-sharpy`, `ofl-claypaky-sharpy` | `powerW` |
| `robe-megapointe` | Robe MegaPointe | Beam | 22 kg | 670 W | IP20? | 20,375 lm · 1.8–42° | 39, 34 ch | `robe-megapointe` | `ipRating` |
| `robe-ledbeam-150` | Robe LEDBeam 150 | Beam | 5.7 kg | 220 W | IP20? | 2,842 lm · 3.8–60° | 22, 16 ch | `robe-ledbeam-150` | `ipRating` |
| `martin-mac-ultra-performance` | Martin MAC Ultra Performance | Profile | 44 kg | 1380 W? | IP20? | 46,500 lm · 8–54° | 48 ch | `martin-mac-ultra-performance` | `powerW`, `ipRating` |
| `robe-bmfl-spot` | Robe BMFL Spot | Spot | 36 kg | 2000 W | IP20? | 40,000 lm · 5–55° | 41, 33 ch | `robe-bmfl-spot` | `ipRating` |
| `robe-t1-profile` | Robe T1 Profile | Profile | 24.3 kg | 650 W | IP20? | 10,075 lm · 7–49° | 49, 33, 53 ch | `robe-t1-profile` | `ipRating` |
| `ayrton-perseo-profile` | Ayrton Perseo Profile | Profile | 38.8 kg | 800 W | IP65 | 27,400 lm · 7–58° | 38, 40, 58, 61 ch | `ayrton-perseo-profile` | — |
| `robe-bmfl-followspot` | Robe BMFL FollowSpot | Followspot | 35 kg | 2000 W | IP20? | 39,770 lm · 5–45° | 33, 27 ch | `robe-bmfl-followspot` | `ipRating` |
| `martin-mac-aura-xb` | Martin MAC Aura XB | Wash | 6.5 kg | 359 W | IP20 | 6,000 lm · 9–59.1° | 14, 25 ch | `martin-mac-aura-xb` | — |
| `martin-mac-aura-xip` | Martin MAC Aura XIP | Wash | 8.95 kg | 340 W | IP54 | 6,000 lm (wide 35.3°) · 6.3–50.4° | 20, 36, 57, 93, 14, 25 ch | `martin-mac-aura-xip` | — |
| `robe-spiider` | Robe Spiider | Wash | 13.3 kg | 660 W | IP20? | 13,700 lm · 4–50° | 27, 47, 90, 91, 110, 123 ch | `robe-spiider` | `ipRating` |
| `chauvet-rogue-r1-beamwash` | CHAUVET Professional Rogue R1 BeamWash | Wash | 5.35 kg | 285 W | IP20? | 1,483 lm (narrow 4°) · 4–37.8° | 14, 15, 19, 21 ch | `chauvet-rogue-r1-beamwash` | `ipRating` |
| `chauvet-colorado-1-quad-zoom` | CHAUVET Professional COLORado 1-Quad Zoom | LED PAR | 7 kg | 108 W | IP65 | 7–32° | 12, 4, 5, 17, 25 ch | `chauvet-colorado-1-quad-zoom` | — |
| `etc-colorsource-par` | ETC ColorSource PAR | LED PAR | 3.8 kg | 90 W | IP20 | 3,039 lm · 14.5° | 5, 6, 3, 1 ch | `etc-colorsource-par`, `ofl-etc-colorsource-par` | — |
| `chauvet-colorado-pxl-bar-16` | CHAUVET Professional COLORado PXL Bar 16 | LED Batten | 20.7 kg | 750 W? | IP65 | 8,959 lm (wide) · 5.8–47.9° | 20, 19, 84, 154, 182, 186 ch | `chauvet-colorado-pxl-bar-16` | `powerW` |
| `glp-impression-x4-bar-20` | GLP impression X4 Bar 20 | LED Batten | 14.5 kg | 450 W | IP20 | 4,300 lm · 7–50° | 34, 20, 35, 48, 88, 89 ch | `glp-impression-x4-bar-20` | — |
| `glp-jdc1` | GLP JDC1 | Strobe | 11.6 kg | 1200 W | IP20 | — | 14, 23, 17, 62, 68 ch | `glp-jdc1` | — |
| `martin-atomic-3000-led` | Martin Atomic 3000 LED | Strobe | 7.8 kg | 1300 W? | IP20? | 180,000 lm | 4, 3, 14 ch | `martin-atomic-3000-led` | `powerW`, `ipRating` |
| `mole-richardson-molefay-4lite` | Mole-Richardson 4-Light Molefay | Blinder | 7.6 kg | 2600 W | IP20 | Analog tungsten (external dimmer) | 1?, 4? ch | `mole-richardson-molefay-4lite` | `modes[0].channels`, `modes[1].channels` |
| `chauvet-strike-4` | CHAUVET Professional STRIKE 4 | Blinder | 8.7 kg | 301 W | IP20 | — | 4, 1, 3, 9 ch | `chauvet-strike-4` | — |
| `roe-bp2-v2` | ROE Visual Black Pearl BP2 V2 | LED Panel | 9.35 kg | 190 W | IP20? | 500×500 mm · 2.84 mm · 176×176 px | — | `roe-bp2-v2` | `ipRating` |
| `roe-cb5` | ROE Visual Carbon CB5 | LED Panel | 13.85 kg | 500 W | IP65? | 600×1200 mm · 5.77 mm · 104×208 px | — | `roe-cb5` | `ipRating` |
| `mdg-atme` | MDG ATMe | Hazer | 16.8 kg | 715 W | — | — | 3 ch | `mdg-atme` | — |
| `mdg-theone` | MDG theONE | Hazer | 23 kg | 1480 W | — | — | 5 ch | `mdg-theone`, `ofl-mdg-theone` | — |
| `look-solutions-unique-21` | Look Solutions Unique 2.1 | Hazer | 8.7 kg | 1500 W | — | — | 2 ch | `look-solutions-unique-21` | — |
| `martin-jem-zr45` | Martin JEM ZR45 | Fogger | 17.7 kg | 2100 W | — | — | 1 ch | `martin-jem-zr45` | — |
| `look-solutions-viper-nt` | Look Solutions Viper NT | Fogger | 8.3 kg | 1300 W | — | — | 2 ch | `look-solutions-viper-nt`, `ofl-look-solutions-viper-nt` | — |
| `magicfx-co2jet-ii` | MagicFX CO2Jet II | CO2 Jet | 4.29 kg | 20 W | — | Switched power (external DMX switchpack) | 1? ch | `magicfx-co2jet-ii` | `modes[0].channels` |
| `laserworld-cs-500g` | Laserworld CS-500G | Laser | 5 kg? | 50 W | IP20? | 400 mW 532 nm green · 25 kpps? · 40° · Class 3B · Beam | 15, 12 ch | `laserworld-cs-500g` | `weightKg`, `ipRating`, `laser.scanSpeedKpps` |
| `unity-raw-1-7` | Unity Lasers Raw 1.7 | Laser | 5.3 kg | 100 W | IP20? | 1.7 W RGB · 30 kpps · 45° · 1.1 mrad · Class 4 · Beam+Graphic | 10, 34 ch | `unity-raw-1-7` | `ipRating` |
| `laserworld-ds-3000rgb` | Laserworld DS-3000RGB MK5 | Laser | 5.5 kg | 80 W | IP4X | 3 W RGB · 40 kpps · 40° · 1.0 mrad · Class 4 · Beam+Graphic | 19, 34 ch (ShowNET) | `laserworld-ds-3000rgb`, `laserworld-shownet` | — |
| `kvant-clubmax` | KVANT Clubmax 6000 FB4 | Laser | 11.6 kg | 400 W? | IP20? | 6 W RGB · 40 kpps · 60° · 1.0 mrad · Class 4 · Beam+Graphic | 16, 39 ch (FB4) *(+legacy 18? ch)* | `kvant-clubmax-6000`, `pangolin-fb4-dmx` | `powerW`, `ipRating`, `modes[2].channels` |
| `laserworld-pl-10000rgb` | Laserworld PL-10.000RGB MK3 | Laser | 14.6 kg | 350 W | IP54 | 10 W RGB · 40 kpps · 50° · 1.0 mrad · Class 4 · Beam+Graphic | 19, 34 ch (ShowNET) | `laserworld-pl-10000rgb`, `laserworld-shownet` | — |
| `kvant-spectrum` | KVANT Spectrum 30 | Laser | 36 kg | 900 W? | IP65 | 30 W RGB · 30 kpps · 60° · 1.0 mrad · Class 4 · Beam+Graphic | 16, 39 ch (FB4) *(+legacy 18? ch)* | `kvant-spectrum-30`, `pangolin-fb4-dmx` | `powerW`, `modes[2].channels` |

---

## Legacy generic type mapping

Saved v1–v5 shows and stock presets without a `catalogId` continue using their generic simulation footprints and optics untouched. In the Rig Builder picker, each legacy type maps to a suggested real-world default:

| Legacy type | Legacy preset label | Legacy DMX footprint | Catalogue default (`LEGACY_DEFAULTS`) |
|---|---|---|---|
| `beam` | Sharpy X-Beam 350 *(illustrative)* | 16 ch | `claypaky-sharpy` (Claypaky Sharpy) |
| `wash` | MAC Aura Pro RGBW *(illustrative)* | 12 ch | `martin-mac-aura-xb` (Martin MAC Aura XB) |
| `laser` | KVANT Clubmax 12W *(illustrative)* | 18 ch | `kvant-clubmax` (KVANT Clubmax 6000 FB4) |
| `strobe` | Atomic Pro JDC-1 *(illustrative)* | 8 ch | `glp-jdc1` (GLP JDC1) |
| `blinder` | Molefay 4-Lite Warm *(illustrative)* | 4 ch | `mole-richardson-molefay-4lite` (Mole-Richardson 4-Light Molefay) |
| `hazer` | MDG ATMe Touring Hazer | 3 ch | `mdg-atme` (MDG ATMe) |
| `smoke` | JEM ZR45 Smoke Machine | 2 ch | `martin-jem-zr45` (Martin JEM ZR45) |
| `co2` | MagicFX CO2Jet II | 2 ch | `magicfx-co2jet-ii` (MagicFX CO2Jet II) |
| `floor_laser` | KVANT Spectrum 25W *(illustrative)* | 18 ch | `kvant-spectrum` (KVANT Spectrum 30) |
| `floor_beam` | MegaPointe Floor Beam *(illustrative)* | 16 ch | `robe-megapointe` (Robe MegaPointe) |

---

## Citation index (checked 2026-11-24)

- `claypaky-sharpy`: Claypaky Sharpy product specification — https://www.claypaky.it/en/products/sharpy (checked 2026-11-24; 350 VA apparent power vs active W and 0° minimum vs StageForge 0.1° floor flagged `unverified`)
- `ofl-claypaky-sharpy`: Open Fixture Library, Claypaky Sharpy — https://open-fixture-library.org/clay-paky/sharpy (checked 2026-11-24)
- `robe-megapointe`: Robe MegaPointe technical specification — https://www.robe.cz/megapointe (checked 2026-11-24)
- `robe-ledbeam-150`: Robe ROBIN LEDBeam 150 technical specification — https://www.robe.cz/ledbeam-150 (checked 2026-11-24)
- `martin-mac-ultra-performance`: Martin MAC Ultra Performance specification — https://www.martin.com/en/products/mac-ultra-performance (checked 2026-11-24)
- `robe-bmfl-spot`: Robe BMFL Spot technical specification — https://www.robe.cz/bmfl-spot (checked 2026-11-24)
- `robe-t1-profile`: Robe T1 Profile technical specification — https://www.robe.cz/t1-profile (checked 2026-11-24)
- `ayrton-perseo-profile`: Ayrton Perseo Profile specification — https://www.ayrton.eu/produit/perseo-profile/ (checked 2026-11-24)
- `robe-bmfl-followspot`: Robe BMFL FollowSpot technical specification — https://www.robe.cz/bmfl-followspot (checked 2026-11-24)
- `martin-mac-aura-xb`: Martin MAC Aura XB specification — https://www.martin.com/en/products/mac-aura-xb (checked 2026-11-24)
- `martin-mac-aura-xip`: Martin MAC Aura XIP specification sheet — https://www.martin.com/pl/site_elements/mac-aura-xip-spec-sheet (checked 2026-11-24)
- `robe-spiider`: Robe ROBIN Spiider technical specification — https://www.robe.cz/spiider (checked 2026-11-24)
- `chauvet-rogue-r1-beamwash`: CHAUVET Professional Rogue R1 BeamWash cutsheet — https://www.chauvetprofessional.com/wp-content/uploads/2019/12/Rogue-R1-Beam-Wash-Cutsheet.pdf (checked 2026-11-24)
- `chauvet-colorado-1-quad-zoom`: CHAUVET Professional COLORado 1-Quad Zoom specification — https://www.chauvetprofessional.com/products/colorado-1-quad-zoom/ (checked 2026-11-24)
- `etc-colorsource-par`: ETC ColorSource PAR datasheet — https://www.etcconnect.com/Products/Lighting-Fixtures/ColorSource-PAR/Features.aspx (checked 2026-11-24)
- `ofl-etc-colorsource-par`: Open Fixture Library, ETC ColorSource PAR — https://open-fixture-library.org/etc/colorsource-par (checked 2026-11-24)
- `chauvet-colorado-pxl-bar-16`: CHAUVET Professional COLORado PXL Bar 16 specification — https://www.chauvetprofessional.com/products/colorado-pxl-bar-16/ (checked 2026-11-24)
- `glp-impression-x4-bar-20`: GLP impression X4 Bar 20 specification & DMX chart — https://www.germanlightproducts.com/products/impression-x4-bar-20/ (checked 2026-11-24)
- `glp-jdc1`: GLP JDC1 specification & DMX chart — https://www.glp.de/en/products/entertainment-lighting/led-strobes/jdc1 (checked 2026-11-24)
- `martin-atomic-3000-led`: Martin Atomic 3000 LED specification — https://www.martin.com/en/products/atomic-3000-led (checked 2026-11-24)
- `mole-richardson-molefay-4lite`: Mole-Richardson 4-Light Molefay (Type 5581) datasheet — https://www.mole.com/5581-4-light-molefay (checked 2026-11-24; analog tungsten unit controlled via external dimmer pack)
- `chauvet-strike-4`: CHAUVET Professional STRIKE 4 specification — https://www.chauvetprofessional.com/products/strike-4/ (checked 2026-11-24)
- `roe-bp2-v2`: ROE Visual Black Pearl BP2 V2 specification — https://www.roevisual.com/en/products/black-pearl-bp2-v2 (checked 2026-11-24)
- `roe-cb5`: ROE Visual Carbon CB5 specification — https://www.roevisual.com/en/products/carbon-cb5 (checked 2026-11-24)
- `mdg-atme`: MDG ATMe haze generator specification — https://www.mdgfog.com/en/product/atme (checked 2026-11-24)
- `mdg-theone`: MDG theONE atmospheric generator specification — https://www.mdgfog.com/en/product/theone (checked 2026-11-24)
- `ofl-mdg-theone`: Open Fixture Library, MDG theONE — https://open-fixture-library.org/mdg/theone (checked 2026-11-24)
- `look-solutions-unique-21`: Look Solutions Unique 2.1 specification — https://www.looksolutions.com/en/products/hazer/unique-21 (checked 2026-11-24)
- `martin-jem-zr45`: Martin JEM ZR45 specification — https://www.martin.com/en/products/jem-zr45 (checked 2026-11-24)
- `look-solutions-viper-nt`: Look Solutions Viper NT specification — https://www.looksolutions.com/en/products/fog-machines/viper-nt (checked 2026-11-24)
- `ofl-look-solutions-viper-nt`: Open Fixture Library, Look Solutions Viper NT — https://open-fixture-library.org/look-solutions/viper-nt (checked 2026-11-24)
- `magicfx-co2jet-ii`: MagicFX CO2Jet II product specification — https://www.magicfx.com/en/products/co2jet-ii (checked 2026-11-24; direct power switched via external DMX switchpack)
- `laserworld-cs-500g`: Laserworld CS-500G Club Series technical data — https://www.laserworld.com/en/laserworld-cs/laserworld-cs-500g.html (checked 2026-11-24; chassis weight varies across generations and scan speed is rated @ 4° rather than 8°, both flagged `unverified`)
- `unity-raw-1-7`: Unity Lasers Raw 1.7 product specification & operational manual — https://unitylasers.com/products/raw-1-7 (checked 2026-11-24)
- `laserworld-ds-3000rgb`: Laserworld DS-3000RGB MK5 technical data — https://www.laserworld.com/en/laserworld-ds/laserworld-ds-3000rgb-mk5.html (checked 2026-11-24)
- `laserworld-pl-10000rgb`: Laserworld PL-10.000RGB MK3 technical data — https://www.laserworld.com/en/laserworld-pl/laserworld-pl-10000rgb-mk3.html (checked 2026-11-24)
- `laserworld-shownet`: Laserworld ShowNET DMX modes (DJ 19-Ch & Professional 34-Ch) — https://www.laserworld.com/en/shownet (checked 2026-11-24)
- `kvant-clubmax-6000`: KVANT Clubmax 6000 FB4 specification — https://www.kvantlasers.sk/products/clubmax-6000 (checked 2026-11-24; 350 VA–400 W range flagged `unverified`)
- `kvant-spectrum-30`: KVANT Spectrum 30 specification — https://www.kvantlasers.sk/products/spectrum-30 (checked 2026-11-24; 900 VA apparent power flagged `unverified`)
- `pangolin-fb4-dmx`: Pangolin FB4 DMX-512 profile documentation (16-Ch FB3 profile & 39-Ch FB4 profile) — https://wiki.pangolin.com/doku.php?id=fb4:dmx (checked 2026-11-24)

---

## Laser Safety Guidance & ILDA (.ild) Support

- **Standards referenced (by name only):** IEC 60825-1 (optical power classes: Class 3B ≤ 500 mW, Class 4 > 500 mW), IEC 60825-3 (laser display safety), ANSI Z136.1 / FDA laser show variance practice.
- **Commonly cited separation design values:** StageForge flags beams entering the audience zone (`z > stageDepth / 2`) below **3.0 m** vertical clearance above the audience floor (`y = 0`) and notes **2.5 m** lateral separation as commonly cited design values. Stationary/collapsed beams and explicit `CROWD SCAN ON` also raise a `Danger` indicator.
- **Disclaimer:** All laser safety indicators in StageForge are **design guidance only, not regulatory certification or Laser Safety Officer (LSO) sign-off.** Real-world laser shows require on-site MPE measurements, hardware scan-failure interlocks, E-stop circuits, and applicable national/local variances.
- **ILDA (.ild) reader (`src/data/ilda.ts`):** Implements IDTF Revision 011 Formats 0, 1, 2 (palette), 4, and 5 (including the standard 64-color default palette and BGR true-color byte order) with strict untrusted-input caps: 8 MB max file size, 2,000 frames, 4,000 points/frame, 200,000 total points on desktop (`high` tier) and 60,000 on phones (`low` tier). Loaded `.ild` clips are in-session only (`Not saved with show`).

---

## Equipment Inventory, Shop Stock & Rental Exports

- **Inventory panel (`src/data/equipmentInventory.ts`, `src/components/InventoryPanel.tsx`):** Accessible from the TopBar **Gear & cost** button (default `Inventory` tab alongside `Cost & crew`). Aggregates lighting, lasers, and FX by real catalogue model and DMX mode, plus infrastructure (trusses, motors, LED walls, speakers, stage/FOH, scenery), reporting unit and total weight in **kg / lb**, nameplate maximum power in **W / kW**, spec provenance (`datasheet`, `unverified`, or `estimate` allowance), and per-universe DMX channel usage (`used`, `free`, `conflicts`, `overflow`, and `unpatched` unit counts).
- **Illustrative shop stock limits (`src/data/shopStock.ts`):** Defaults to **Unlimited (free design)** so saved shows and free-form editing are unaffected. Optional fictional rental-house presets (**Local Club Shop**, **Regional Production House**, **Arena Touring Vendor**, plus editable **Custom shop**, persisted locally under `stageforge.shop.v1`) enforce hard quantity limits on Rig Builder additions and model switches while always permitting removals, whole-rig opens/imports, and an optional **Allow over-stock (plan a sub-rental)** toggle. Legacy generic fixtures draw from their `LEGACY_DEFAULTS` model stock pool; LED panel cabinet sliders emit soft stock warnings only.
- **CSV & printable rental sheet (`src/data/csv.ts`, `src/components/InventoryPrintSheet.tsx`):** Exports UTF-8 BOM, CRLF, RFC 4180 `.equipment.csv` files with spreadsheet formula-injection neutralization (`=`, `+`, `-`, `@`, tab, CR) from both the Inventory panel and **Show files → Exchange formats**. Printing uses an in-document `@media print` sheet (`window.print()`) that hides dark UI chrome and the WebGL canvas, working cleanly in browsers and Electron without popups.
