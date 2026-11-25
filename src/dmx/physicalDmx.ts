import type { FloorFxUnit, MountedFixtureGroup, RigConfig } from '../types/show';
import { buildDmxPatch, groupFootprint, writeDmxChannels } from '../data/dmxPatch';
import { getCatalogEntry, getCatalogMode } from '../data/equipmentCatalog';

export type PhysicalDriveStatus = 'implemented' | 'generic-simulated' | 'simulation-only';

export type PhysicalGroup = MountedFixtureGroup | FloorFxUnit;

export interface PhysicalUnitState {
  /** True when desk blackout is active. */
  blackout: boolean;
  /** Moving/wash/PAR dimmer in [0, 1] (already master/blackout-scaled). */
  dimmer?: number;
  /** Red in [0, 1]. */
  r?: number;
  /** Green in [0, 1]. */
  g?: number;
  /** Blue in [0, 1]. */
  b?: number;
  /** Blinder intensity in [0, 1] (already master/blackout-scaled). */
  blinder?: number;
  /** Smoke output in [0, 1] (already blackout-gated). */
  smoke?: number;
}

export interface PhysicalPersonality {
  readonly key: string;
  readonly catalogId: string;
  readonly modeName: string;
  readonly channels: number;
  readonly manualRef: string;
  readonly channelNames: readonly string[];
  /** True only for passive non-strobing LED luminaires safe on renderer-local Web Serial (no lasers, atmospherics, or blinders). */
  readonly allowOnRendererSerial: boolean;
  readonly encode: (state: PhysicalUnitState, out: number[]) => number[];
}

export interface PhysicalGroupClassification {
  readonly status: PhysicalDriveStatus;
  readonly label: string;
  readonly reason: string;
  readonly personalityKey?: string;
  readonly personality?: PhysicalPersonality;
}

export interface PhysicalGroupReport {
  readonly id: string;
  readonly modelName: string;
  readonly count: number;
  readonly location: string;
  readonly dmxMode?: string;
  readonly universe: 1 | 2;
  readonly start: number;
  readonly end: number;
  readonly width: number;
  readonly classification: PhysicalGroupClassification;
}

export interface PhysicalDriveSummary {
  readonly implemented: readonly PhysicalGroupReport[];
  readonly genericSimulated: readonly PhysicalGroupReport[];
  readonly simulationOnly: readonly PhysicalGroupReport[];
  readonly hasImplemented: boolean;
  readonly hasGeneric: boolean;
  readonly hasSimulationOnly: boolean;
}

export const GENERIC_SIMULATED_LABEL = 'StageForge simulated channel layout, verify against your fixture';
export const SIMULATION_ONLY_LABEL = 'not driven (simulation only)';

function clampByte(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(255, Math.round(v)));
}

function clampUnit(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function encodeZr45SmokeByte(level: number): number {
  // Martin JEM ZR25/35/45 User Manual: 0–12 = idle/off, 13–240 = proportional 0–100%, 241–255 = max 100%.
  const clamped = clampUnit(level);
  if (clamped <= 0) return 0;
  if (clamped >= 0.999) return 255;
  return Math.min(240, Math.max(13, 13 + Math.round(clamped * 227)));
}

const PERSONALITY_LIST: readonly PhysicalPersonality[] = [
  {
    key: 'etc-colorsource-par::1-Ch',
    catalogId: 'etc-colorsource-par',
    modeName: '1-Ch',
    channels: 1,
    manualRef: 'ETC ColorSource PAR User Manual (1-Ch mode: Ch 1 = Preset 1 Intensity)',
    channelNames: ['Intensity (Preset 1)'],
    allowOnRendererSerial: true,
    encode(state, out) {
      out.length = 1;
      out[0] = state.blackout ? 0 : clampByte(clampUnit(state.dimmer) * 255);
      return out;
    },
  },
  {
    key: 'etc-colorsource-par::RGB (3-Ch)',
    catalogId: 'etc-colorsource-par',
    modeName: 'RGB (3-Ch)',
    channels: 3,
    manualRef: 'ETC ColorSource PAR User Manual (RGB 3-Ch mode: Ch 1 Red, Ch 2 Green, Ch 3 Blue)',
    channelNames: ['Red', 'Green', 'Blue'],
    allowOnRendererSerial: true,
    encode(state, out) {
      out.length = 3;
      const dim = state.blackout ? 0 : clampUnit(state.dimmer);
      out[0] = clampByte(clampUnit(state.r) * dim * 255);
      out[1] = clampByte(clampUnit(state.g) * dim * 255);
      out[2] = clampByte(clampUnit(state.b) * dim * 255);
      return out;
    },
  },
  {
    key: 'etc-colorsource-par::5-Ch (Default)',
    catalogId: 'etc-colorsource-par',
    modeName: '5-Ch (Default)',
    channels: 5,
    manualRef: 'ETC ColorSource PAR User Manual (5-Ch mode: Ch 1 Intensity, Ch 2 Red, Ch 3 Green, Ch 4 Blue, Ch 5 Strobe=0)',
    channelNames: ['Intensity', 'Red', 'Green', 'Blue', 'Strobe'],
    allowOnRendererSerial: true,
    encode(state, out) {
      out.length = 5;
      const dim = state.blackout ? 0 : clampUnit(state.dimmer);
      if (dim <= 0) {
        out[0] = 0;
        out[1] = 0;
        out[2] = 0;
        out[3] = 0;
        out[4] = 0;
        return out;
      }
      out[0] = clampByte(dim * 255);
      out[1] = clampByte(clampUnit(state.r) * 255);
      out[2] = clampByte(clampUnit(state.g) * 255);
      out[3] = clampByte(clampUnit(state.b) * 255);
      // Keep hardware strobe at 0 (no strobe) so external fixtures never exceed the photosensitivity cap.
      out[4] = 0;
      return out;
    },
  },
  {
    key: 'chauvet-strike-4::1-Ch',
    catalogId: 'chauvet-strike-4',
    modeName: '1-Ch',
    channels: 1,
    manualRef: 'CHAUVET Professional STRIKE 4 User Manual Rev 1 (1-Ch mode: Ch 1 Dimmer)',
    channelNames: ['Dimmer'],
    allowOnRendererSerial: false,
    encode(state, out) {
      out.length = 1;
      out[0] = state.blackout ? 0 : clampByte(clampUnit(state.blinder) * 255);
      return out;
    },
  },
  {
    key: 'chauvet-strike-4::4-Ch',
    catalogId: 'chauvet-strike-4',
    modeName: '4-Ch',
    channels: 4,
    manualRef: 'CHAUVET Professional STRIKE 4 User Manual Rev 1 (4-Ch mode: Ch 1–4 White Pod 1–4)',
    channelNames: ['White 1', 'White 2', 'White 3', 'White 4'],
    allowOnRendererSerial: false,
    encode(state, out) {
      out.length = 4;
      const byte = state.blackout ? 0 : clampByte(clampUnit(state.blinder) * 255);
      out[0] = byte;
      out[1] = byte;
      out[2] = byte;
      out[3] = byte;
      return out;
    },
  },
  {
    key: 'martin-jem-zr45::1-Ch',
    catalogId: 'martin-jem-zr45',
    modeName: '1-Ch',
    channels: 1,
    manualRef: 'Martin JEM ZR25/35/45 User Manual (1-Ch: 0–12 idle, 13–240 variable, 241–255 max)',
    channelNames: ['Fog Output'],
    allowOnRendererSerial: false,
    encode(state, out) {
      out.length = 1;
      out[0] = state.blackout ? 0 : encodeZr45SmokeByte(clampUnit(state.smoke));
      return out;
    },
  },
];

export const IMPLEMENTED_PHYSICAL_PERSONALITIES: ReadonlyMap<string, PhysicalPersonality> = new Map(
  PERSONALITY_LIST.map((p) => [p.key, p]),
);

export function listImplementedPhysicalPersonalities(): readonly PhysicalPersonality[] {
  return PERSONALITY_LIST;
}

/**
 * Single source of truth deciding whether a fixture group drives physical DMX through an
 * implemented datasheet personality or emits neutral zeros (`simulation-only`).
 * Generic non-catalogue fixtures keep StageForge's simulated layout in `dmxUniverse1/2` (3D sim & SIM monitor),
 * NEVER on physical wire (`SF-H1` / `N1`).
 */
export function classifyPhysicalGroup(
  group: Pick<PhysicalGroup, 'catalogId' | 'dmxMode' | 'dmxChannels' | 'type'>,
): PhysicalGroupClassification {
  if (!group.catalogId) {
    return {
      status: 'simulation-only',
      label: SIMULATION_ONLY_LABEL,
      reason: 'Generic non-catalogue fixture — not driven on physical DMX (outputs neutral zeros).',
    };
  }
  const entry = getCatalogEntry(group.catalogId);
  if (!entry) {
    return {
      status: 'simulation-only',
      label: SIMULATION_ONLY_LABEL,
      reason: 'Unknown catalogue fixture — outputs neutral zeros on physical DMX.',
    };
  }
  const mode = getCatalogMode(entry, group.dmxMode);
  if (!mode || mode.legacy) {
    return {
      status: 'simulation-only',
      label: SIMULATION_ONLY_LABEL,
      reason: 'Unresolved or legacy catalogue mode — outputs neutral zeros on physical DMX.',
    };
  }
  const width = groupFootprint(group);
  const key = `${entry.id}::${mode.name}`;
  const personality = IMPLEMENTED_PHYSICAL_PERSONALITIES.get(key);
  if (personality && width === personality.channels) {
    return {
      status: 'implemented',
      label: 'Implemented personality',
      reason: personality.manualRef,
      personalityKey: personality.key,
      personality,
    };
  }
  return {
    status: 'simulation-only',
    label: SIMULATION_ONLY_LABEL,
    reason: 'Personality not implemented for physical output — outputs neutral zeros.',
  };
}

const SERIAL_BLOCKED_TYPES = new Set(['laser', 'floor_laser', 'co2', 'smoke', 'hazer', 'strobe', 'blinder']);
const SERIAL_BLOCKED_CATEGORIES = new Set(['laser', 'fogger', 'hazer', 'co2', 'sparks', 'strobe', 'blinder']);

/**
 * True when a fixture group represents a hazardous luminaire or atmospheric effect that MUST NOT be
 * armed or driven over renderer-local Web Serial (which lacks an out-of-process crash watchdog).
 */
export function isSerialBlockedFixtureGroup(
  group: Pick<PhysicalGroup, 'catalogId' | 'type'>,
): boolean {
  if (SERIAL_BLOCKED_TYPES.has(group.type)) return true;
  if (group.catalogId) {
    const entry = getCatalogEntry(group.catalogId);
    if (entry && SERIAL_BLOCKED_CATEGORIES.has(entry.category)) return true;
  }
  return false;
}

export function checkSerialTransportSafety(rig: RigConfig): {
  allowed: boolean;
  reason: string | null;
  blockingGroupIds: string[];
} {
  const blockingGroupIds: string[] = [];
  for (const pod of rig.trussPods) {
    for (const g of pod.fixtures) {
      if (g.count > 0 && isSerialBlockedFixtureGroup(g)) blockingGroupIds.push(g.id);
    }
  }
  for (const fx of rig.floorFx) {
    if (fx.count > 0 && isSerialBlockedFixtureGroup(fx)) blockingGroupIds.push(fx.id);
  }
  if (blockingGroupIds.length > 0) {
    return {
      allowed: false,
      reason:
        'USB Serial DMX lacks an out-of-process crash watchdog and is blocked when lasers, blinders, strobes, or atmospheric effects (smoke, haze, CO2) are patched. Remove hazardous fixtures or switch to desktop sACN / Art-Net 4.',
      blockingGroupIds,
    };
  }
  return { allowed: true, reason: null, blockingGroupIds: [] };
}

/**
 * Write physical DMX bytes for one patched unit into `physBuf`, never overwriting neighbours.
 * - `implemented`: encodes via the verified personality encoder (unless `serialOnlySafe` rejects non-serial personalities).
 * - All other groups (`simulation-only`, including generic non-catalogue fixtures): zeroes `width` bytes.
 */
export function writePhysicalUnitBytes(
  physBuf: Uint8Array,
  _simBuf: Uint8Array,
  start: number,
  width: number,
  classification: PhysicalGroupClassification,
  state: PhysicalUnitState,
  scratch: number[] = [],
  serialOnlySafe = false,
): void {
  const ch = start - 1;
  if (ch < 0 || width <= 0 || ch >= physBuf.length) return;
  const clampedWidth = Math.min(width, physBuf.length - ch);
  if (classification.status !== 'implemented') {
    physBuf.fill(0, ch, ch + clampedWidth);
    return;
  }
  const personality = classification.personality;
  if (!personality || (serialOnlySafe && !personality.allowOnRendererSerial)) {
    physBuf.fill(0, ch, ch + clampedWidth);
    return;
  }
  const encoded = personality.encode(state, scratch);
  physBuf.fill(0, ch, ch + clampedWidth);
  writeDmxChannels(physBuf, start, clampedWidth, encoded);
}

/**
 * Summarize physical DMX drive coverage across all fixture groups in a rig,
 * used by DmxOutputSection, LiveDmxBadge, and pre-flight reporting.
 */
export function summarizePhysicalDrive(rig: RigConfig): PhysicalDriveSummary {
  const patch = buildDmxPatch(rig);
  const implemented: PhysicalGroupReport[] = [];
  const genericSimulated: PhysicalGroupReport[] = [];
  const simulationOnly: PhysicalGroupReport[] = [];

  for (const row of patch.rows) {
    const classification = classifyPhysicalGroup(row.group);
    const report: PhysicalGroupReport = {
      id: row.group.id,
      modelName: row.group.modelName,
      count: row.group.count,
      location: row.location,
      dmxMode: row.group.dmxMode,
      universe: row.group.dmxUniverse,
      start: row.start,
      end: row.end,
      width: row.width,
      classification,
    };
    if (classification.status === 'implemented') implemented.push(report);
    else if (classification.status === 'generic-simulated') genericSimulated.push(report);
    else simulationOnly.push(report);
  }

  return {
    implemented,
    genericSimulated,
    simulationOnly,
    hasImplemented: implemented.length > 0,
    hasGeneric: genericSimulated.length > 0,
    hasSimulationOnly: simulationOnly.length > 0,
  };
}

/**
 * Pure standalone physical universe builder for deterministic golden-byte unit testing
 * without requiring WebGL or StageEngine.
 */
export function buildPhysicalUniverses(
  rig: RigConfig,
  simU1: Uint8Array,
  simU2: Uint8Array,
  stateForUnit: (group: PhysicalGroup, unitIndex: number) => PhysicalUnitState,
  outU1: Uint8Array = new Uint8Array(512),
  outU2: Uint8Array = new Uint8Array(512),
): { u1: Uint8Array; u2: Uint8Array } {
  outU1.fill(0);
  outU2.fill(0);
  const patch = buildDmxPatch(rig);
  const scratch: number[] = [];

  for (const row of patch.rows) {
    const classification = classifyPhysicalGroup(row.group);
    const simBuf = row.group.dmxUniverse === 1 ? simU1 : simU2;
    const physBuf = row.group.dmxUniverse === 1 ? outU1 : outU2;
    for (let i = 0; i < row.group.count; i++) {
      const start = patch.unitStart(row.group, i);
      if (start <= 0) continue;
      const unitState = stateForUnit(row.group, i);
      writePhysicalUnitBytes(physBuf, simBuf, start, row.width, classification, unitState, scratch);
    }
  }
  return { u1: outU1, u2: outU2 };
}
