# Rigging & Power Specifications, Solvers and Sources

> **Simplified static guidance only — not structural engineering sign-off.** Always verify spans, bridles, dynamic loads, electrical feeders, harmonics, and roof steel with a qualified rigger and licensed master electrician before suspending or powering real equipment.

StageForge's rigging and electrical model lives in:
- [`src/data/rigCatalog.ts`](../src/data/rigCatalog.ts) — curated touring truss profiles and chain hoist / dead-hang specifications
- [`src/data/hoistPoints.ts`](../src/data/hoistPoints.ts) — single source of truth for hoist anchor coordinates shared by 3D geometry, the production estimator, and the load solver
- [`src/data/rigLoads.ts`](../src/data/rigLoads.ts) — static point-load and bending-moment guidance solver
- [`src/data/powerReport.ts`](../src/data/powerReport.ts) — dimmer/circuit auto-packing, deterministic LPT three-phase balance, neutral current estimate, feeder/generator sizing, and unified `.rigging-power.csv` export

---

## Truss Profiles (verified 2026-11-24)

| ID | Manufacturer & Model | Outer Section | Center-to-Center | Chords / Braces | Self-Weight | Published Simple-Span UDL / CPL Range | Table Deducts Self-Weight | Sources | Unverified |
|---|---|---|---|---|---|---|---|---|---|
| `prolyte-h30v` | Prolyte H30V | 287 × 287 mm | 239 mm | 48×3 mm / 16×2 mm | 7.0 kg/m | 4 m (491.3 kg/m, 1298.1 kg) – 12 m (74.8 kg/m, 466.5 kg) | Yes | `prolyte-h30v` | `maxCantileverM` |
| `prolyte-h40v` | Prolyte H40V | 387 × 387 mm | 339 mm | 48×3 mm / 20×2 mm | 8.1 kg/m | 6 m (414.6 kg/m, 1234.4 kg) – 16 m (64.7 kg/m, 482.5 kg), 18 m (49.8 kg/m) | Yes | `prolyte-h40v` | `maxCantileverM` |
| `eurotruss-fd34` | Eurotruss FD34 | 290 × 290 mm | 240 mm | 50×2 mm / 20×2 mm | 6.0 kg/m | 4 m (460 kg/m, 950 kg) – 12 m (55 kg/m, 331 kg) | Yes | `eurotruss-fd34` | `maxCantileverM` |
| `tomcat-12x12` | Tomcat 12"×12" Plated Box (LD) | 305 × 305 mm | 254 mm | 50.8×3.18 mm / 25.4 mm | 9.23 kg/m (6.2 lb/ft) | 3.05 m (778.3 kg/m, 1185.2 kg) – 12.19 m (31.3 kg/m, 193.2 kg) | Yes | `tomcat-12x12` | `maxCantileverM` |
| `tomcat-20-5x20-5` | Tomcat 20.5"×20.5" Plated Box (MD) | 521 × 521 mm | 470 mm | 50.8×3.18 mm / 25.4 mm | 12.65 kg/m (8.5 lb/ft) | 3.05 m (1293.2 kg/m, 3090.8 kg) – 18.29 m (44.6 kg/m, 402.8 kg), 21.34 m (28.3 kg/m) | Yes | `tomcat-20-5x20-5` | `maxCantileverM` |

*Notes:*
- European tables (Prolyte, Eurotruss) are published under Eurocode; jurisdictions requiring ANSI E1.2 or BS 7905-2 typically apply an additional 0.85 reduction factor.
- Legacy unprofiled trusses (`trussProfileId` omitted) keep StageForge's original 20.5" visual proportions (`hSize = 0.24 m`, mount Y `-0.28 m`) and `30 lb/m` (~13.61 kg/m) touring allowance so v1–v6 shows remain bit-identical.

---

## Chain Hoists & Suspension Hardware (verified 2026-11-24)

| ID | Manufacturer & Model | Nominal WLL | Safety Class | Body Weight (excl. chain) | Chain / Steel Weight | Motor Power | Lift Speed | Sources | Unverified |
|---|---|---|---|---|---|---|---|---|---|
| `cm-lodestar-05t` | CM Lodestar Model F (½-Ton) | 500 kg | D8 | 16.3 kg | 0.89 kg/m? | 750 W (½ HP) | 4.88 m/min (16 FPM) | `cm-lodestar` | `chainKgPerM` |
| `cm-lodestar-1t` | CM Lodestar Model L (1-Ton) | 1,000 kg | D8 | 27.2 kg | 1.40 kg/m? | 1,500 W (1 HP) | 4.88 m/min (16 FPM) | `cm-lodestar` | `chainKgPerM` |
| `cm-lodestar-2t` | CM Lodestar Model R (2-Ton) | 2,000 kg | D8 | 56.7 kg | 2.80 kg/m? | 1,500 W (1 HP) | 2.44 m/min (8 FPM) | `cm-lodestar` | `chainKgPerM` |
| `chainmaster-d8plus-500` | ChainMaster D8Plus 500 kg | 500 kg | D8+ | 17.0 kg | 0.59 kg/m | 700 W | 4.0 m/min | `chainmaster-d8plus` | — |
| `chainmaster-d8plus-1000` | ChainMaster D8Plus 1000 kg | 1,000 kg | D8+ | 31.0 kg | 1.30 kg/m | 1,100 W | 4.0 m/min | `chainmaster-d8plus` | — |
| `dead-hang-1t` | Dead Hang (1-Ton Steel + Shackle) | 1,000 kg | deadhang | 3.5 kg? | 0.40 kg/m? | 0 W | 0 m/min | `rigging-practice` | `bodyKg`, `chainKgPerM` |

---

## Static Load Model & Allowances

1. **Named allowances:**
   - **Clamps & safety bonds:** `+1.0 kg` per mounted fixture (marked estimated).
   - **Cable loom:** `+10%` of mounted fixture weight (displayed explicitly, never hidden inside fixture weights).
   - **Roof load vs Hoist load:** Each hoist point reports both the **hook/hoist load** (truss share + payload, compared against effective WLL) and the **roof point load** (hook load + hoist body + chain drop from venue grid height).
2. **Solvers by shape:**
   - **Box trusses (2–4 collinear points):** Uniform continuous-beam flexibility solver (rigid supports, Gaussian elimination). With 2 points this is exact static moment equilibrium; with 3 points under uniform load it produces the exact **⅝ wL (62.5%)** center-point reaction. Negative reactions from heavy overhangs are surfaced as **Uplift** errors and are never clamped away.
   - **Chevron & Path trusses:** Approximate segment-by-segment simply-supported distribution (statically indeterminate).
   - **Circle trusses:** Angular split between adjacent hoist points (ring torsion ignored; no ring span table).
3. **Span bending moment check:**
   - For each span $L$, allowable moment is interpolated from the truss's published table:
     $$M_{\text{allow}}(L) = \min\!\left(\frac{\text{UDL}_{\text{allow}} \cdot L^2}{8},\; \frac{\text{CPL}_{\text{allow}} \cdot L}{4}\right)$$
   - Spans longer than the manufacturer table's maximum span are flagged as **Overload (outside manufacturer table)**.
   - Overhangs exceeding `maxCantileverM` (or ¼ of the adjacent back span when unverified) trigger a **Caution** warning.
4. **D8 vs D8+ guidance (IGVW SQP2 / DGUV V17):**
   - Single-brake **D8** hoists cannot hold loads over people without independent secondary safety steels; converting to **D8+** requires dual independent brakes and 50% derating (minimum 8:1/10:1 static load path). StageForge applies a 50% guidance derate to D8 hoists by default (toggleable in the Rigging & power tab) while leaving **D8+** and **deadhang** at 100% of rated static WLL.
5. **Kinetic dynamic factor:** Motorized pods display a separate **Kinetic ×1.2** figure alongside static load.
6. **Other flown loads:** Flown PA line arrays and LED video walls are listed in their own section with total weight and recommended bridle/header points, separate from the truss pod solver.

---

## Electrical Distribution & Three-Phase Balance

- **Supported systems:** US 120/208 V 3φ Wye (20 A circuits, NEC 210.20 80% continuous = 16 A / 1,920 VA), EU 230/400 V 3φ Wye (16 A circuits, 80% practice = 12.8 A / 2,944 VA), plus US 120 V 1φ and EU 230 V 1φ.
- **Auto-packing & phase pins:** Each fixture/FX group auto-packs into `<label>-NN` branch circuits without exceeding 80% continuous apparent power (VA), flagging single units that exceed breaker ratings. Pinned groups/departments (`L1`/`L2`/`L3`) are assigned first; remaining circuits are balanced deterministically via Longest-Processing-Time (LPT) sorting.
- **Neutral current & harmonics:** Linear Wye neutral current $I_N = \sqrt{I_a^2 + I_b^2 + I_c^2 - I_a I_b - I_b I_c - I_c I_a}$ is reported alongside a warning that switch-mode loads (LED walls, moving lights) produce triplen harmonics that can push neutral current toward $\sqrt{3}\times$ phase current (specifying a 200% rated neutral on touring feeders).
- **Intermittent hoists:** Chain hoist motors (PF 0.8) are excluded from the continuous 3-phase balance and evaluated separately against feeder headroom with an inrush note.
- **Total wattage parity:** `computePowerReport(rig, stage).totals.totalW` strictly equals `calculateProductionEstimate(rig, stage).totalWatts`.

---

## Source References

- `prolyte-h30v` — Prolyte H30V Square Truss technical specification & Eurocode load tables (prolyte.com, verified 2026-11-24).
- `prolyte-h40v` — Prolyte H40V Heavy-Duty Square Truss technical specification & Eurocode load tables (prolyte.com, verified 2026-11-24).
- `eurotruss-fd34` — Eurotruss FD34 Square Truss technical specification & TÜV/Eurocode load table (eurotruss.com / eurotruss.ch, verified 2026-11-24).
- `tomcat-12x12` — Tomcat 12"×12" Plated Light-Duty Box Truss engineering data sheet (tomcatglobal.com, verified 2026-11-24).
- `tomcat-20-5x20-5` — Tomcat 20.5"×20.5" Plated Medium-Duty Box Truss engineering data sheet (tomcatglobal.com, verified 2026-11-24).
- `cm-lodestar` — Columbus McKinnon CM-ET Lodestar Model F (½-Ton), Model L (1-Ton), and Model R (2-Ton) entertainment hoist specification sheets (cmco.com / columbusmckinnon.ie, verified 2026-11-24).
- `chainmaster-d8plus` — ChainMaster D8Plus Ultra 500 kg & 1000 kg electric chain hoist datasheets (chainmaster.de, verified 2026-11-24) and IGVW SQP2 / DGUV V17 rigging code of practice (igvw.org).
- `rigging-practice` — Standard entertainment dead-hang steel wire rope + 1-ton shackle hardware allowance (unverified generic allowance).
- `stageforge-legacy` — StageForge v1–v6 legacy touring allowances (`30 lb/m` truss, `124 lb / 1500 W` hoist).
