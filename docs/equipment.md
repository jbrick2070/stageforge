# Equipment catalogue and sources

StageForge ships a curated catalogue of touring lighting, LED video panel, atmospheric and show laser equipment in [`src/data/equipmentCatalog.ts`](../src/data/equipmentCatalog.ts). Procedural 3D models, deterministic PBR hardware textures, plan/DXF symbols, and mobile/desktop rendering budgets are documented in [`docs/assets.md`](assets.md). Truss profiles, chain hoists, static rigging load calculations, and three-phase power distribution are documented in [`docs/rigging-power.md`](rigging-power.md). Production paperwork (Patch Sheet, Instrument Schedule, Channel Hookup, Power & Load Report, Cue Sheet, and Full Production Book printing) is documented in [`docs/paperwork.md`](paperwork.md).

## Sourcing policy

- **Manufacturer datasheets & Open Fixture Library:** Weights, power draw, beam/zoom ranges, lumen figures, IP ratings and DMX modes are recorded strictly as published factual specifications from manufacturer datasheets/manuals, with DMX mode names occasionally cross-checked against Open Fixture Library.
- **Licensing & database-right hygiene:** Open Fixture Library's code is MIT-licensed, while its community fixture definitions carry no separate licence statement; GDTF Share's terms grant no right to redistribute GDTF files. While individual factual numbers (weights, watts, channel counts) are not copyrightable in the US, the EU provides a separate *sui generis* database right against extracting a substantial part of a database. Accordingly, StageForge records only individually verified factual specs and mode names with primary-source citations, never copies datasheet prose, photos or logos, and never bundles manufacturer GDTF archives.
- **No copied text or media:** Model names identify real hardware only. Entry IDs for expanded catalogue items stay neutral and stable so manufacturer/model display names can be swapped as a pure data change without breaking saved shows.
- **Honest verification flags & nulls:** Any field that could not be independently verified from an authoritative primary source is listed in `unverified` (marked `?` in the UI), or left omitted/`null` when unconfirmed (falling back to StageForge's estimated allowances in inventory/paperwork, `n/a` for lux, and `unknown` for laser NOHD hazard zones).
- **Conventions for `powerW`, `lumens`, and laser divergence:**
  - `powerW` holds the manufacturer's headline maximum power draw (the 230 V figure where split by mains voltage), or the manufacturer's published typical figure when no maximum is stated (noted per entry in the citation index below).
  - `optics.lumens` holds the manufacturer's headline total luminaire output (integrating-sphere output where both sphere and goniophotometer are printed; never raw LED source lumens).
  - `laser.opticalPowerW` holds the manufacturer's **guaranteed optical output at aperture** (maximum output or sum-of-module output can be 3–15% higher, which lengthens static NOHD accordingly; noted per entry in the citation index below).
  - `laser.divergenceMrad` holds full-angle divergence in mrad where stated; whenever the maker omits the full/half-angle convention or prints only an upper bound (`< X mrad`), `laser.divergenceMrad` is flagged in `unverified` and treated as `unknown` by Sprint 12's hazard-zone evaluator.
  - `laser.maxScanAngleDeg` is omitted when unstated on the datasheet; ILDA preview uses a 45° default while Sprint 12's safety clearance evaluates conservatively at 60° and emits a pre-flight warning.
  - **JEM brand lineage:** JEM moved under new ownership in spring 2025 as **JEM Professional** (formerly Martin JEM / HARMAN). New Sprint 14b JEM entries use `JEM Professional`, while the existing `martin-jem-zr45` entry keeps `Martin JEM ZR45` for continuity with older shows.
- **Simulated DMX control layout:** Selecting a catalogue model updates its DMX channel footprint, optical defaults (for moving heads) and weight/power estimates. StageForge's live DMX simulator still writes its built-in control layout starting at each unit's start address rather than the fixture's full manufacturer channel map; both the DMX Monitor and Live DMX Badge note this when catalogue fixtures are patched.

### Open Fixture Library notice

Selected DMX mode names and channel counts cross-checked against Open Fixture Library pages (note: OFL's code is MIT-licensed; fixture definitions carry no separate licence statement):

> Copyright (c) 2017–2026 Open Fixture Library contributors (MIT License for code, https://open-fixture-library.org/).

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
| `hazer-water-01` | JEM Professional Hazer Pro | Hazer | 15 kg | 675 W | — | Water-based haze | 3 ch | `jem-hazer-pro` | — |
| `fogger-tour-01` | JEM Professional ZR35 | Fogger | 15.1 kg | 1500 W | — | Fog machine | 1 ch | `jem-zr35` | — |
| `lowfog-chilled-01` | JEM Professional Glaciator Dynamic | Fogger (Low-fog) | 124 kg | 3500 W | IP20 | Chilled low-fog *(renders as fog plume)* | 1, 2 ch | `jem-glaciator-dynamic` | — |
| `hazer-oil-01` | Antari HZ-500 | Hazer | 31.5 kg? | 480 W | — | Oil/water haze | 1 ch | `antari-hz-500` | `weightKg` |
| `lowfog-ice-01` | Antari ICE-101 | Fogger (Low-fog) | 24.4 kg | 1130 W | — | Ice-chilled low-fog *(renders as fog plume)* | 1 ch | `antari-ice-101` | — |
| `hazer-stadium-01` | CHAUVET Professional Amhaze Stadium | Hazer | 17.4 kg | 1230 W? | IP20 | Water-based haze | 2 ch | `chauvet-amhaze-stadium` | `powerW` |
| `fogger-tour-02` | Look Solutions Cobra 3.1 | Fogger | 16 kg | 3100 W | — | Evaporator fogger | 1, 2, 3 ch | `look-solutions-cobra-31` | — |
| `lowfog-co2-01` | Look Solutions Cryo-Fog High Pressure | Fogger (Low-fog) | 33 kg | 2300 W | — | CO2-chilled low-fog *(renders as fog plume)* | 3? ch | `look-solutions-cryo-fog`, `ofl-look-cryofog` | `modes[0].channels` |
| `co2-jet-moving-01` | MagicFX PSYCO2JET | CO2 Jet | 8.2 kg | 35 W | IP23 | Moving-nozzle CO2 jet (+1 safety ch) | 3, 4 ch | `magicfx-psyco2jet`, `ofl-magicfx-psyco2jet` | — |
| `co2-jet-fixed-01` | CryoFX CO2 Jet DMX 512 | CO2 Jet | 8.1 kg | 100 W | — | Fixed CO2 jet | 1? ch | `cryofx-co2-jet-dmx` | `modes[0].channels` |
| `laser-club-01` | Laserworld EL-400RGB S | Laser | 3 kg | 30 W | — | 400 mW RGB · 15 kpps · 3 mm / 2? mrad · Class 3B · Beam | 16, 36 ch | `laserworld-el-400rgb-s` | `laser.divergenceMrad` |
| `laser-club-02` | Laserworld DS-1000RGB MK5 | Laser | 3.8 kg | 40 W | — | 1 W RGB · 30 kpps · 40° · 3 mm / 0.9 mrad · Class 4 · Beam+Graphic | 19?, 34? ch (ShowNET) | `laserworld-ds-1000rgb-mk5`, `laserworld-shownet-dmx` | `modes[0].channels`, `modes[1].channels` |
| `laser-club-03` | Stairville (Thomann) DJ Lase RGB Pro Advanced 1000 | Laser | 3.6 kg | 25 W | — | 1 W RGB · 20? kpps · 36° · 5? mm / 2? mrad · Class 4 · Beam+Graphic | 20 ch | `stairville-dj-lase-rgb-1000` | `laser.divergenceMrad`, `laser.beamDiameterMm`, `laser.scanSpeedKpps` |
| `laser-tour-01` | Kvant Clubmax 3000 FB4 | Laser | 8.8 kg | 340 W | IP20 | 3 W RGB · 40 kpps · 60° · 4.5 mm / 0.6 mrad · Class 4 · Beam+Graphic | 16?, 39? ch (FB4) | `kvant-clubmax-3000-fb4`, `pangolin-fb4-dmx` | `modes[0].channels`, `modes[1].channels` |
| `laser-outdoor-01` | X-Laser Triton T-5 | Laser | 9.52 kg | 200 W | IP64 | 5 W RGB · 30 kpps · 45° · aperture n/a · 1.4? mrad · Class 4 · Beam+Graphic | 32? ch *(placeholder)* | `xlaser-triton-t5` | `laser.divergenceMrad`, `laser.beamDiameterMm`, `modes[0].channels` |
| `laser-tour-02` | Kvant Clubmax 10 FB4 | Laser | 13 kg | 340 W | IP20 | 9.7 W RGB · 40? kpps · 60° · 5 mm / 0.9 mrad · Class 4 · Beam+Graphic | 16?, 39? ch (FB4) | `kvant-clubmax-10-fb4`, `pangolin-fb4-dmx` | `laser.scanSpeedKpps`, `modes[0].channels`, `modes[1].channels` |
| `laser-outdoor-02` | Laserworld DS-15.000 IP65 | Laser | 11.5 kg | 120 W | IP65 | 15 W RGB · 30 kpps · 50° · 5.5 mm / 1.1? mrad · Class 4 · Beam+Graphic | 34, 19? ch (ShowNET) | `laserworld-ds-15000-ip65`, `laserworld-shownet-dmx` | `laser.divergenceMrad`, `modes[1].channels` |
| `laser-outdoor-03` | Laserworld DS-30.000 IP65 | Laser | 17.3 kg | 350 W | IP65 | 30 W RGB · 30 kpps · 50° · 5.5 mm / 1.1? mrad · Class 4 · Beam+Graphic | 34, 19? ch (ShowNET) | `laserworld-ds-30000-ip65`, `laserworld-shownet-dmx` | `laser.divergenceMrad`, `modes[1].channels` |
| `laser-arena-01` | Kvant Clubmax 40 FB4 | Laser | 20 kg | 1200 W | — | 36.7 W RGB · 30 kpps · 7 mm / 1.1? mrad · Class 4? · Beam+Graphic | 16?, 39? ch (FB4) | `kvant-clubmax-40-fb4`, `pangolin-fb4-dmx` | `laser.divergenceMrad`, `laser.laserClass`, `modes[0].channels`, `modes[1].channels` |
| `panel-mesh-01` | ROE Visual Vanish V8T | LED Panel | 18.2 kg | 480 W | IP65 | 1000×1000 mm · 8.9 mm · 112×112 px | — | `roe-vanish-v8t` | — |
| `panel-outdoor-01` | ROE Visual Black Quartz BQ3.9 | LED Panel | 17.8 kg | 360 W | IP65 | 500×1000 mm · 3.9 mm · 128×256 px | — | `roe-black-quartz-bq39` | — |
| `panel-outdoor-02` | ROE Visual Vanish ST V3ST | LED Panel | 27.5 kg | 700 W | IP65 | 1000×1000 mm · 3.9 mm · 256×256 px | — | `roe-vanish-st-v3st` | — |
| `panel-floor-01` | ROE Visual Black Marble BM5 | LED Panel | 13.5 kg | 270 W | IP65 | 600×600 mm · 5.77 mm · 104×104 px | — | `roe-black-marble-bm5` | — |
| `panel-indoor-01` | ROE Visual Ruby RB1.5F | LED Panel | 8.16 kg | 140 W | IP40 | 500×500 mm · 1.56 mm · 320×320 px | — | `roe-ruby-rb15f` | — |
| `panel-outdoor-03` | Absen PL3.9 Pro V10 | LED Panel | 8.4 kg? | — *(est.)* | IP65? | 500×500 mm · 3.9 mm · 128×128 px? | — | `absen-pl-pro-v10` | `weightKg`, `ipRating`, `panel` |
| `panel-outdoor-04` | Absen PL4.8 Pro V10 | LED Panel | 8.1 kg? | 180 W? | IP65? | 500×500 mm · 4.8 mm · 104×104 px? | — | `absen-pl-pro-v10` | `weightKg`, `powerW`, `ipRating`, `panel` |
| `panel-indoor-02` | Absen PL2.5 Pro V10 | LED Panel | 8.8 kg? | — *(est.)* | IP40? | 500×500 mm · 2.5 mm · 200×200 px? | — | `absen-pl-pro-v10` | `weightKg`, `ipRating`, `panel` |
| `panel-mesh-02` | Planar (Leyard) CarbonLight CLM6.9 | LED Panel | 4.8 kg | 300 W | IP65 | 1000×500 mm · 6.9 mm · 144×72 px? | — | `planar-clm69` | `panel` |
| `panel-floor-02` | Planar (Leyard) CarbonLight CLF VX2.6 | LED Panel | 8 kg | 150 W | — | 500×500 mm · 2.6 mm · 192×192 px | — | `planar-clf-vx26` | — |
| `profile-compact-01` | Ayrton Diablo Profile S | Profile | 22 kg | 550 W | IP20 | 19,000 lm · 7–53° | 34, 36, 56 ch | `ayrton-diablo-s`, `ofl-ayrton-diablo-s` | — |
| `profile-tour-01` | Ayrton Khamsin S | Profile | 39.8 kg | 1150 W | IP20 | 40,000 lm · 7–58° | 40, 42, 64 ch | `ayrton-khamsin-s` | — |
| `profile-tour-02` | Robe T2 Profile | Profile | 36.9 kg | 1150 W | IP20 | 22,000 lm · 5–55° | 52, 36, 56 ch | `robe-t2-profile` | — |
| `profile-tour-03` | Robe ESPRITE | Profile | 28.2 kg | — *(est.)* | IP20 | 5.5–50° | 49, 42, 50, 43, 51 ch | `robe-esprite` | — |
| `profile-tour-04` | CHAUVET Professional Maverick MK3 Profile | Profile | 34.7 kg | 1180 W | IP20 | 23,000 lm · 5.9–64.1° | 38, 54 ch | `chauvet-maverick-mk3-profile` | — |
| `profile-outdoor-01` | CHAUVET Professional Maverick Storm 3 Profile | Profile | 31.3 kg | 1010 W | IP65 | 34,500 lm · 3.5–57.7° | 34, 50 ch | `chauvet-maverick-storm-3-profile` | — |
| `spot-led-01` | CHAUVET Professional Rogue R2X Spot | Spot | 21.7 kg | 481 W | IP20 | 14,789 lm · 16° | 18, 21 ch | `chauvet-rogue-r2x-spot` | — |
| `spot-hybrid-01` | Martin RUSH MH 7 Hybrid | Spot (Hybrid) | 24 kg | 372 W | IP20 | 2.2–45°? | 21 ch | `martin-rush-mh-7-hybrid`, `ofl-martin-rush-mh-7-hybrid` | `optics.zoomDeg` |
| `spot-compact-01` | Martin RUSH MH 5 Profile | Spot | 9 kg | 165 W | IP20 | 14° | 16 ch | `martin-rush-mh-5-profile`, `ofl-martin-rush-mh-5-profile` | — |
| `beam-compact-01` | Martin MAC One | Beam | 4.4 kg | 180 W | IP20 | 2,500 lm · 4–19° | 20, 36, 108, 20 ch | `martin-mac-one` | — |
| `spot-club-01` | Showtec Phantom 130 Spot | Spot | 13.1 kg | 270 W | — | 12–21° | 12, 16 ch | `showtec-phantom-130-spot` | — |
| `wash-outdoor-01` | CHAUVET Professional Rogue Outcast 2X Wash | Wash | 9.6 kg? | 291 W | IP65 | 6,258 lm · 8–36.1° | 56, 55, 54, 33, 23, 22, 17, 15, 54, 33 ch | `chauvet-rogue-outcast-2x-wash` | `weightKg` |
| `batten-tilt-01` | Robe Robin Tetra2 | LED Batten | 18.1 kg | 600 W | IP20 | 10,500 lm · 4–45° | 34, 56, 97, 115, 110, 128 ch | `robe-robin-tetra2` | `modes[0].name`, `modes[1].name`, `modes[2].name`, `modes[3].name`, `modes[4].name`, `modes[5].name` |
| `batten-static-01` | CHAUVET DJ COLORband PiX IP | LED Batten | 6.1 kg | 103 W | IP65 | 20° | 3, 4, 6, 7, 9, 12, 18, 36 ch | `chauvet-dj-colorband-pix-ip`, `ofl-chauvet-dj-colorband-pix-ip` | — |
| `par-zoom-01` | CHAUVET Professional COLORado 1 Solo | LED PAR | 5.4 kg | 65 W | IP65 | 4–40° | 17, 17, 12, 9, 9 ch | `chauvet-colorado-1-solo`, `ofl-chauvet-colorado-1-solo` | — |
| `par-zoom-02` | Elation Professional Fuze Par Z60 IP | LED PAR | 4.5 kg | 78 W | IP65 | 7–39° | 4, 4, 5, 6, 7, 7, 8, 9, 10, 10, 12, 13 ch | `elation-fuze-par-z60-ip`, `ofl-elation-fuze-par-z60ip` | — |
| `par-zoom-03` | Martin RUSH PAR 2 RGBW Zoom | LED PAR | 5.5 kg | 151 W | IP20 | 10–60°? | 5, 9 ch | `martin-rush-par-2-rgbw-zoom`, `ofl-martin-rush-par-2-rgbw-zoom` | `optics.zoomDeg` |
| `ellipsoidal-led-01` | ETC Source Four LED Series 3 Lustr X8 | Profile (Ellipsoidal) | 8.9 kg | 307 W | IP20 | 10,889 lm · 5–90° | 12, 11, 7, 3, 1 ch | `etc-s4-led-s3-lustr-x8`, `ofl-etc-s4-led-s3-lustr-x8` | — |
| `ellipsoidal-led-02` | CHAUVET Professional Ovation E-910FC | Profile (Ellipsoidal) | 7.1 kg | 220 W | IP20 | 7,263 lm · 7–41° | 1, 3, 5, 7, 10, 12, 13, 16, 3? ch | `chauvet-ovation-e-910fc` | `modes[8].channels` |
| `blinder-single-01` | CHAUVET Professional STRIKE 1 | Blinder | 8.6 kg | 265 W | IP65 | 30° | 1, 3, 4, 5, 6, 7 ch | `chauvet-strike-1` | — |
| `strobe-panel-01` | ADJ Jolt Panel FXIP | Strobe | 9.1 kg? | 214 W? | IP65? | 73°? | 6?, 9?, 13?, 18?, 20?, 36?, 41?, 43?, 51?, 81?, 83?, 126?, 141?, 143? ch | `adj-jolt-panel-fxip` | `weightKg`, `powerW`, `ipRating`, `optics.beamDeg`, `modes[0].channels`, `modes[1].channels`, `modes[2].channels`, `modes[3].channels`, `modes[4].channels`, `modes[5].channels`, `modes[6].channels`, `modes[7].channels`, `modes[8].channels`, `modes[9].channels`, `modes[10].channels`, `modes[11].channels`, `modes[12].channels`, `modes[13].channels` |

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
- `jem-hazer-pro`: JEM Professional Hazer Pro datasheet (Rev. 1.0) — https://jemprofessional.com/datablade/hazer-pro.html and https://jemprofessional.com/about.html (checked 2026-11-24; spot-checked 2026-11-25; 15 kg dry, 675 W single published consumption figure)
- `jem-zr35`: JEM Professional ZR35 datasheet (Rev. 1.0) — https://jemprofessional.com/datablade/zr35.html (checked 2026-11-24; 15.1 kg dry, 1500 W EU / 1450 W US)
- `jem-glaciator-dynamic`: JEM Professional Glaciator Dynamic datasheet (Rev. 1.0) — https://jemprofessional.com/datablade/glaciator-dynamic.html (checked 2026-11-24; 124 kg dry, 3500 W max / 3350 W typ)
- `antari-hz-500`: Antari HZ-500 product page — https://antari.com/products/hz-500 (checked 2026-11-24; 480 W at 240 V / 400 W at 120 V; 31.5 kg flagged `unverified` because flight-case inclusion is unstated)
- `antari-ice-101`: Antari ICE-101 product page — https://antari.com/products/ice-101 (checked 2026-11-24; 24.4 kg, 1130 W rated)
- `chauvet-amhaze-stadium`: CHAUVET Professional Amhaze Stadium product page & datasheet — https://chauvetprofessional.com/product/amhaze-stadium/ and https://chauvetprofessional.com/wp-content/uploads/pdf/en/AMHAZESTADIUM.pdf (checked 2026-11-24; 1230 W at 120 V flagged `unverified` due to conflicting 2430 W 230 V line)
- `look-solutions-cobra-31`: Look Solutions Cobra 3.1 product page, datasheet & manual — https://www.looksolutions.com/produkte/cobra/2.html , https://www.looksolutions.com/uploads/pdf/info_cobra31_d.pdf , https://www.looksolutions.com/uploads/pdf/bed_cobra31_d.pdf (checked 2026-11-24; 16 kg dry without canister, 3100 W at 230 V)
- `look-solutions-cryo-fog`: Look Solutions Cryo-Fog High Pressure product page — https://www.looksolutions.com/produkte/cryo_fog/2.html (checked 2026-11-24; 33 kg incl. canister, 2300 W at 230 V / 1700 W at 120 V)
- `ofl-look-cryofog`: Open Fixture Library, Look Solutions Cryo-Fog — https://open-fixture-library.org/look/cryofog (checked 2026-11-24; 3-ch DMX mode flagged `unverified`)
- `magicfx-psyco2jet`: MagicFX PSYCO2JET manual (PART01127 rev 01-02) — https://images.static-thomann.de/pics/atg/atgdata/document/manual/606148_magicfx_psyco2jet_manual.pdf (checked 2026-11-24; 8.2 kg unit weight, 35 W, Raw 3-ch / Preset 4-ch plus separate 1-ch Safety address)
- `ofl-magicfx-psyco2jet`: Open Fixture Library, MagicFX PSYCO2JET — https://open-fixture-library.org/magicfx/psyco2jet (checked 2026-11-24)
- `cryofx-co2-jet-dmx`: CryoFX CO2 Jet DMX 512 product specification — https://cryofx.com/cryofx-cryo-jet-dmx-512.html (checked 2026-11-24; 8.1 kg, 100 W; 1-ch DMX mode inferred and flagged `unverified`)
- `laserworld-el-400rgb-s`: Laserworld EL-400RGB S product page & manual (11/2024) — https://www.laserworld.com/en/laserworld-el/laserworld-el-400rgb-s and https://www.laserworld.com/en/download-file-1931-EL_400RGB_S_web.html (checked 2026-11-24; divergence FWHM convention omits full/half-angle statement so flagged `unverified`; max scan angle omitted)
- `laserworld-ds-1000rgb-mk5`: Laserworld DS-1000RGB MK5 product page — https://www.laserworld.com/en/laserworld-ds/laserworld-ds-1000rgb-mk5 (checked 2026-11-24; 0.9 mrad full angle stated in body text, 3 mm aperture)
- `laserworld-shownet-dmx`: Laserworld ShowNET DMX manual — https://www.laserworld.com/en/laser-online-user-manual/shownet-dip-switch-panel/dmx-control.html (checked 2026-11-24; generic ShowNET 19-ch DJ / 34-ch Professional counts)
- `stairville-dj-lase-rgb-1000`: Stairville DJ Lase RGB Pro Advanced 1000 manual (V5, 2023-10-20) — https://images.static-thomann.de/pics/atg/atgdata/document/manual/c_368582_v5_en_online.pdf (checked 2026-11-24; `< 2 mrad` divergence, `< 5 mm` beam diameter, and `> 20 kpps @ ±20°` flagged `unverified`)
- `kvant-clubmax-3000-fb4`: Kvant Clubmax 3000 FB4 spec sheet & series manual — https://cdn.shopify.com/s/files/1/2680/6950/files/Clubmax_3000_FB4.pdf and https://cdn.shopify.com/s/files/1/2680/6950/files/kvant-clubmax-fb4-series-operation-manual.pdf (checked 2026-11-24; 0.6 mrad averaged full-angle FWHM, 4.5 mm aperture, 340 VA max)
- `xlaser-triton-t5`: X-Laser Triton T-5 specification sheet (2024, hosted by Full Compass) — https://fullcompass.com/common/files/89767-5WRGBIP64RatedLaserSystemwithBuiltInMercury.pdf (checked 2026-11-24; beam diameter null/unknown, `< 1.4 mrad` upper bound without convention flagged `unverified`; 32-ch `DMX` mode is a StageForge placeholder footprint flagged `unverified` because the datasheet omits channel counts)
- `kvant-clubmax-10-fb4`: Kvant Clubmax 10 FB4 spec sheet & series manual — https://cdn.shopify.com/s/files/1/2680/6950/files/Clubmax_10_FB4.pdf and https://cdn.shopify.com/s/files/1/2680/6950/files/kvant-clubmax-fb4-series-operation-manual.pdf (checked 2026-11-24; 0.9 mrad averaged full angle, 5 mm aperture, 340 VA max; 40 vs 30 kpps conflict flagged `unverified`)
- `laserworld-ds-15000-ip65`: Laserworld DS-15.000 IP65 product page — https://www.laserworld.com/en/laserworld-ds/laserworld-ds-15-000-ip65 (checked 2026-11-24; spot-checked 2026-11-25; 15 W guaranteed, 11.5 kg, 120 W, IP65, 5.5 mm / 1.1 mrad FWHM with full/half angle unstated on this page so flagged `unverified`)
- `laserworld-ds-30000-ip65`: Laserworld DS-30.000 IP65 product page — https://www.laserworld.com/en/laserworld-ds/laserworld-ds-30-000-ip65 (checked 2026-11-24; 30 W guaranteed, 17.3 kg, 350 W, IP65, 5.5 mm / 1.1 mrad FWHM with full/half angle unstated on this page so flagged `unverified`)
- `kvant-clubmax-40-fb4`: Kvant Clubmax 40 FB4 spec sheet — https://cdn.shopify.com/s/files/1/2680/6950/files/Clubmax_40_FB4.pdf (checked 2026-11-24; 36.7 W guaranteed, `< 1.1 mrad` upper-bound divergence flagged `unverified` so NOHD stays unknown, 7 mm aperture, 1200 VA max, max scan angle omitted; Class 4 derived from 36.7 W optical power and flagged `unverified`)
- `roe-vanish-v8t`: ROE Visual Vanish V8T brochure (Nov 2025) & product page — https://www.roevisual.com/uploads/files/Product%20File/Vanish/v8t-brochure-nov-7_-2025.pdf and https://www.roevisual.com/en/products/vanish-8-touring (checked 2026-11-24; spot-checked 2026-11-25; 18.2 kg, 480 W max / 240 W avg)
- `roe-black-quartz-bq39`: ROE Visual Black Quartz BQ3.9 brochure (Jul 2024) & product page — https://www.roevisual.com/uploads/files/Product%20File/Black%20Quartz/black-quartz-brochure-en-july.-22-2024.pdf and https://www.roevisual.com/en/products/black-quartz (checked 2026-11-24; spot-checked 2026-11-25; 17.8 kg bare panel / 22 kg with wind frame, 360 W max / 180 W avg)
- `roe-vanish-st-v3st`: ROE Visual Vanish ST V3ST brochure (Nov 2025) — https://www.roevisual.com/uploads/files/Product%20File/Vanish%20ST/vanish-st-brochure-nov-7_-2025.pdf (checked 2026-11-24; 27.5 kg bare / 34.5 kg with ladder, 700 W max / 350 W avg)
- `roe-black-marble-bm5`: ROE Visual Black Marble BM5 brochure (Aug 2023) — https://www.roevisual.com/uploads/assets/uploads/bm5-brochure-brochure-en-aug.-9-2023-duplicate-duplicate-duplicate-duplicate-duplicate.pdf (checked 2026-11-24; 13.5 kg matte PC variant, 270 W max / 135 W avg, IP65 floor panel)
- `roe-ruby-rb15f`: ROE Visual Ruby RB1.5F brochure & product page — https://www.roevisual.com/uploads/files/Product%20File/Ruby/ruby-1.5fand1.9fand2.2fand2.6f-(vp)-brochure.pdf and https://www.roevisual.com/en/ruby (checked 2026-11-24; 8.16 kg, 140 W max / 70 W avg, IP40)
- `absen-pl-pro-v10`: Absen Polaris PL Pro V10 specification bundle (distributor-hosted Full Compass PDF) — https://fullcompass.com/common/files/86826-PL29V10specsheet.pdf (checked 2026-11-24; distributor-hosted copy so fields flagged `unverified`; `powerW` omitted on PL3.9/PL2.5 where per-panel max W was derived from W/m² and unfound verbatim on re-check)
- `planar-clm69`: Planar CarbonLight CLM6.9 datasheet & series page — https://res.cloudinary.com/iwh/image/upload/q_auto,g_center/assets/1/26/Planar-CLM6.2-Data-Sheet.pdf and https://www.planar.com/products/led-video-walls/carbonlight/clm (checked 2026-11-24; 4.8 kg, 300 W max / 150 W typ; pixel axis orientation flagged `unverified`)
- `planar-clf-vx26`: Planar CarbonLight CLF VX2.6 spec sheet (May 2023) — https://res.cloudinary.com/iwh/image/upload/q_auto,g_center/assets/1/26/PlanarCLF_VX2.6-Specsheet.pdf (checked 2026-11-24; 8 kg, 150 W max, indoor LED floor)
- `ayrton-diablo-s`: Ayrton Diablo Profile S product specification — https://www.ayrton.eu/?p=5513 (checked 2026-11-24; spot-checked 2026-11-25; 22 kg spec block / 21.8 kg intro, 550 W max, 19,000 lm total luminaire output)
- `ofl-ayrton-diablo-s`: Open Fixture Library, Ayrton Diablo S — https://open-fixture-library.org/ayrton/diablo-s (checked 2026-11-24; mode names/counts cross-checked)
- `ayrton-khamsin-s`: Ayrton Khamsin S product page & DMX chart V221 — https://www.ayrton.eu/produit/khamsin/ and https://www.ayrton.eu/wp-content/uploads/2020/06/Khamsin-DMX-chart_V221-1.pdf (checked 2026-11-24; 39.8 kg, 1150 W max, 40,000 lm total luminaire output)
- `robe-t2-profile`: Robe T2 Profile datasheet & user manual v3.1 — https://cdn.aws.robe.cz/print/en_product_4311.pdf , https://www.robe.cz/res/downloads/user_manuals/User_manual_Robin_T2_Profile.pdf , https://www.robe.cz/t2-profile (checked 2026-11-24; 36.9 kg, 1150 W max, 22,000 lm integrating sphere / 17,600 lm goniophotometer)
- `robe-esprite`: Robe ESPRITE product page & user manual v5.0 — https://www.robe.cz/esprite and https://www.robe.cz/res/downloads/user_manuals/User_manual_Robin_Esprite.pdf (checked 2026-11-24; `powerW` and `optics.lumens` omitted because not re-found in cited text on verification pass)
- `chauvet-maverick-mk3-profile`: CHAUVET Professional Maverick MK3 Profile product page — https://chauvetprofessional.com/product/maverick-mk3-profile/ (checked 2026-11-24; spot-checked 2026-11-25; 34.7 kg, 1180 W at 230 V / 1230 W at 120 V, 23,000 lm output)
- `chauvet-maverick-storm-3-profile`: CHAUVET Professional Maverick Storm 3 Profile product page — https://chauvetprofessional.com/product/maverick-storm-3-profile/ (checked 2026-11-24; 31.3 kg, 1010 W at 230 V / 1020 W at 120 V, 34,500 lm output, IP65)
- `chauvet-rogue-r2x-spot`: CHAUVET Professional Rogue R2X Spot product page — https://chauvetprofessional.com/product/rogue-r2x-spot/ (checked 2026-11-24; 21.7 kg, 481 W at 230 V / 488 W at 120 V, 14,789 lm output, fixed 16° beam)
- `martin-rush-mh-7-hybrid`: Martin RUSH MH 7 Hybrid product page — https://www.martin.com/en-US/products/rush-mh-7-hybrid (checked 2026-11-24; discontinued; 24 kg, 372 W typical at 230 V / 377 W at 120 V, lumens unpublished)
- `ofl-martin-rush-mh-7-hybrid`: Open Fixture Library, Martin RUSH MH 7 Hybrid — https://open-fixture-library.org/martin/rush-mh-7-hybrid (checked 2026-11-24)
- `martin-rush-mh-5-profile`: Martin RUSH MH 5 Profile product page — https://www.martin.com/en-US/products/rush-mh-5-profile (checked 2026-11-24; discontinued; 9 kg, 165 W typical at 100 V / 157 W at 230 V, fixed 14° half-peak beam, lumens unpublished)
- `ofl-martin-rush-mh-5-profile`: Open Fixture Library, Martin RUSH MH 5 Profile — https://open-fixture-library.org/martin/rush-mh-5-profile (checked 2026-11-24)
- `martin-mac-one`: Martin MAC One product page — https://www.martin.com/en-US/products/mac-one (checked 2026-11-24; 4.4 kg, 180 W max / 160 W typ, 2,500 lm, 4–19° half-peak beam)
- `showtec-phantom-130-spot`: Showtec Phantom 130 Spot English manual V1 (40073) — https://www.highlite.com/media/attachments/MANUAL/40073_MANUAL_GB_V1.pdf (checked 2026-11-24; 13.1 kg, 270 W, 12–21° zoom, lumens & IP unpublished)
- `chauvet-rogue-outcast-2x-wash`: CHAUVET Professional Rogue Outcast 2X Wash datasheet, manual Rev 10 & DMX chart Rev 3 — https://chauvetprofessional.com/wp-content/uploads/pdf/en/ROGUEOUTCAST2XWASH.pdf , https://chauvetprofessional.com/wp-content/uploads/2022/08/Rogue_Outcast_2X_Wash_UM_Rev10.pdf , https://chauvetprofessional.com/wp-content/uploads/2022/08/Rogue_Outcast_2X_Wash_DMX_Chart_Rev3.pdf (checked 2026-11-24; 291 W at 120 V / 282 W at 230 V, 6,258 lm output; 9.6 vs 10.6 kg weight conflict flagged `unverified`)
- `robe-robin-tetra2`: Robe Robin Tetra2 leaflet & user manual v2.1 — https://robe.cz/res/downloads/catalogues/ROBE_Tetra2_leaflet_online_version.pdf and https://www.robe.cz/res/downloads/user_manuals/User_manual_Robin_Tetra_2.pdf (checked 2026-11-24; 18.1 kg, 600 W max at 230 V, 10,500 lm integrating sphere; mode names mapped by chart order so flagged `unverified`)
- `chauvet-dj-colorband-pix-ip`: CHAUVET DJ COLORband PiX IP product page, datasheet & manual Rev 2 — https://www.chauvetdj.com/products/colorband-pix-ip/ , https://www.chauvetdj.com/wp-content/uploads/pdf/en/colorband-pix-ip.pdf , https://www.chauvetdj.com/wp-content/uploads/2015/12/COLORband_PiX_IP_UM_Rev2_WO-1.pdf (checked 2026-11-24; discontinued 2021; 6.1 kg, 103 W at 230 V / 98 W at 120 V, fixed 20° beam)
- `ofl-chauvet-dj-colorband-pix-ip`: Open Fixture Library, CHAUVET DJ COLORband PiX IP — https://open-fixture-library.org/chauvet-dj/colorband-pix-ip (checked 2026-11-24)
- `chauvet-colorado-1-solo`: CHAUVET Professional COLORado 1 Solo datasheet & product page — https://chauvetprofessional.com/wp-content/uploads/pdf/en/COLORADO1SOLO.pdf and https://chauvetprofessional.com/product/colorado-1-solo/ (checked 2026-11-24; 5.4 kg, 65 W at 120/230 V, IP65, 4–40° beam)
- `ofl-chauvet-colorado-1-solo`: Open Fixture Library, CHAUVET Professional COLORado 1 Solo — https://open-fixture-library.org/chauvet-professional/colorado-1-solo (checked 2026-11-24)
- `elation-fuze-par-z60-ip`: Elation Professional Fuze Par Z60 IP EU archive page — https://elationlighting.eu/fuze-par-z60-ip (checked 2026-11-24; archived; 4.5 kg, 78 W max, IP65, 7–39° zoom)
- `ofl-elation-fuze-par-z60ip`: Open Fixture Library, Elation Fuze Par Z60 IP — https://open-fixture-library.org/elation/fuze-par-z60ip (checked 2026-11-24)
- `martin-rush-par-2-rgbw-zoom`: Martin RUSH PAR 2 RGBW Zoom spec sheet & manual Rev I — https://www.martin.com/pl/site_elements/rush-par-2-rgbw-zoom-spec-sheet-english and https://www.martin.com/en/site_elements/martin-rush-par-2-rgbw-zoom-user-manual (checked 2026-11-24; 5.5 kg, 151 W typical at 120 V / 148 W at 230 V; 10–60° zoom beam/field ambiguity flagged `unverified`)
- `ofl-martin-rush-par-2-rgbw-zoom`: Open Fixture Library, Martin RUSH PAR 2 RGBW Zoom — https://open-fixture-library.org/martin/rush-par-2-rgbw-zoom (checked 2026-11-24)
- `etc-s4-led-s3-lustr-x8`: ETC Source Four LED Series 3 Lustr X8 datasheet Rev I (2024-05) — https://www.etcconnect.com/WorkArea/DownloadAsset.aspx?id=10737506242 and https://www.etcconnect.com/Products/Entertainment-Fixtures/Source-Four-LED-Series-3/Documentation.aspx (checked 2026-11-24; 8.9 kg engine+barrel excl. lens tube, 307 W typical at 120 V / 305 W at 230 V, 10,889 lm max system output, 5–90° swappable lens tube range)
- `ofl-etc-s4-led-s3-lustr-x8`: Open Fixture Library, ETC Source Four LED Series 3 Lustr X8 — https://open-fixture-library.org/etc/source-four-led-series-3-lustr-x8 (checked 2026-11-24; mode names/counts only — OFL physical data reflects Daylight HDR)
- `chauvet-ovation-e-910fc`: CHAUVET Professional Ovation E-910FC datasheet, product page & manual Rev 19 — https://chauvetprofessional.com/product/ovation-e-910fc/ , https://chauvetprofessional.com/wp-content/uploads/pdf/en/OVATIONE910FC-2.pdf , https://chauvetprofessional.com/wp-content/uploads/2015/09/Ovation_E-910FC_UM_Rev19.pdf (checked 2026-11-24; 7.1 kg excl. lens tube, 220 W at 100 V / 216 W at 230 V, 7,263 lm max tube output, 7–41° tube range; HSV 3-ch count inferred from highest start address 510 and flagged `unverified`)
- `chauvet-strike-1`: CHAUVET Professional STRIKE 1 datasheet, manual Rev 8 & DMX chart Rev 4 — https://chauvetprofessional.com/wp-content/uploads/pdf/en/STRIKE1.pdf , https://chauvetprofessional.com/wp-content/uploads/2018/10/Strike_1_UM_Rev8.pdf , https://chauvetprofessional.com/wp-content/uploads/2018/10/Strike_1_DMX_Chart_Rev4.pdf (checked 2026-11-24; 8.6 kg, 265 W at 100 V / 254 W at 230 V, IP65, fixed 30° beam)
- `adj-jolt-panel-fxip`: ADJ Jolt Panel FXIP user manual v1.3 (distributor-hosted copy) — https://leisuretec.co.uk/cdn/shop/files/ADJ_Jolt_Panel_FXIP_User_Manual.pdf (checked 2026-11-24; distributor-hosted manual because adj.com was inaccessible, so all numeric specs & DMX modes flagged `unverified`)

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
