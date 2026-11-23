import { VENUE_TYPES, type RigConfig } from '../types/show';
import { MAX_ANGLE, MAX_LUMENS, MIN_ANGLE } from './fixtureOptics';
import { FIXTURE_CATALOG, FLOOR_FX_CATALOG } from './presets';
import { SPEAKER_PROFILES } from './speakerProfiles';
import { requestedWallSize } from './stageEquipment';
import { isStageProp } from './stageProps';
import { MAX_PLATFORMS, MAX_PATH_POINTS, MIN_TRUSS_SPAN, normalizeDesign } from './stageDesign';

type Fields = Record<string, unknown>;
type Check = (value: unknown) => boolean;

const text: Check = (value) => typeof value === 'string' && value.trim().length > 0;
const bool: Check = (value) => typeof value === 'boolean';
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const positive: Check = (value) => number(value) && value > 0;
const integer =
  (min: number, max = Number.MAX_SAFE_INTEGER): Check =>
  (value) =>
    number(value) && Number.isSafeInteger(value) && value >= min && value <= max;
const catalogKey =
  (catalog: object): Check =>
  (value) =>
    typeof value === 'string' && Object.hasOwn(catalog, value);
const optional =
  (check: Check): Check =>
  (value) =>
    value === undefined || check(value);

function checkFields(value: unknown, path: string, rules: Record<string, Check>): asserts value is Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Expected an object at ${path}.`);
  const fields = value as Fields;
  for (const [key, valid] of Object.entries(rules)) {
    if (!valid(fields[key])) throw new Error(`Missing or invalid ${path}.${key}.`);
  }
}

function checkList(value: unknown, path: string, checkItem: (entry: Fields, path: string) => void) {
  if (!Array.isArray(value)) throw new Error(`Expected a list at ${path}.`);
  const ids = new Set<string>();
  value.forEach((entry: unknown, i) => {
    const itemPath = `${path}[${i}]`;
    checkFields(entry, itemPath, { id: text });
    const id = entry.id as string;
    if (ids.has(id)) throw new Error(`Duplicate ID at ${itemPath}.id.`);
    ids.add(id);
    checkItem(entry, itemPath);
  });
}

const equipment = {
  modelName: text,
  count: integer(1, 512),
  dmxUniverse: integer(1, 2),
  dmxStartChannel: integer(1, 512),
};

function checkOptics(item: Fields, path: string) {
  if (item.optics === undefined) return;
  if (item.type !== 'beam' && item.type !== 'wash' && item.type !== 'floor_beam')
    throw new Error(`Unsupported fixture optics at ${path}.`);
  const limits = {
    lumens: optional(v => number(v) && v >= 0 && v <= MAX_LUMENS),
    beamAngle: optional(v => number(v) && v >= MIN_ANGLE && v <= MAX_ANGLE),
  };
  checkFields(item.optics, path + '.optics', limits);
  if (item.optics.profile !== undefined) {
    const name: Check = v => typeof v === 'string' && !!v.trim() && [...v].length <= 512;
    checkFields(item.optics.profile, path + '.optics.profile', {
      ...limits, manufacturer: name, fixture: name, geometry: name, source: optional(v => v === 'datasheet'),
    });
  }
}

function checkRig(value: unknown): asserts value is RigConfig {
  let fixtureCount = 0;
  checkFields(value, 'rig', {
    schemaVersion: optional((v) => v === 1),
    name: text,
    venue: (v) => (VENUE_TYPES as readonly unknown[]).includes(v),
    stageWidth: positive,
    stageDepth: positive,
    stageHeight: positive,
  });
  if (value.platforms !== undefined) {
    if (!Array.isArray(value.platforms) || value.platforms.length > MAX_PLATFORMS)
      throw new Error('A design can contain up to 24 deck modules.');
    checkList(value.platforms, 'platforms', (platform, path) => {
      checkFields(platform, path, {
        name: text,
        x: number,
        z: number,
        width: positive,
        depth: positive,
        height: positive,
      });
    });
  }
  checkFields(value.ledWall, 'ledWall', {
    enabled: bool,
    width: positive,
    height: positive,
    curved: bool,
    sideWings: bool,
  });
  if (value.ledWall.cabinets !== undefined) {
    checkFields(value.ledWall.cabinets, 'ledWall.cabinets', {
      columns: integer(1, 256), rows: integer(1, 256),
      widthMm: integer(50, 2000), heightMm: integer(50, 2000),
      pixelsWide: integer(1, 4096), pixelsHigh: integer(1, 4096),
    });
  }
  checkFields(value.audioRig, 'audioRig', {
    lineArrays: bool,
    subWall: bool,
    djBooth: bool,
    subCount: integer(0, 16),
    crowdDensity: (v) => number(v) && v >= 0 && v <= 1,
    speakerProfile: optional(catalogKey(SPEAKER_PROFILES)),
    boxesPerSide: optional(integer(4, 12)),
    monitorCount: optional(integer(0, 8)),
  });
  checkList(value.trussPods, 'trussPods', (pod, path) => {
    checkFields(pod, path, {
      name: text,
      shape: (v) => v === 'box' || v === 'circle' || v === 'chevron' || v === 'path',
      width: positive,
      x: number,
      baseY: number,
      z: number,
      rotationY: number,
      motorized: bool,
      motorMinY: number,
      motorMaxY: number,
    });
    if (Number(pod.motorMinY) > Number(pod.motorMaxY))
      throw new Error(`Motor height limits are reversed at ${path}.`);
    if (pod.shape === 'path') {
      if (!Array.isArray(pod.path) || pod.path.length < 2 || pod.path.length > MAX_PATH_POINTS) {
        throw new Error(`Expected 2–64 vertices at ${path}.path.`);
      }
      let last: { x: number; z: number } | undefined;
      pod.path.forEach((point: unknown, i: number) => {
        checkFields(point, `${path}.path[${i}]`, { x: number, z: number });
        const x = Number(point.x),
          z = Number(point.z);
        if (last && Math.hypot(last.x - x, last.z - z) < MIN_TRUSS_SPAN)
          throw new Error(`Truss segment ${i} is shorter than 0.25 m at ${path}.`);
        last = { x, z };
      });
    }
    checkList(pod.fixtures, `${path}.fixtures`, (fixture, fixturePath) => {
      checkFields(fixture, fixturePath, { ...equipment, type: catalogKey(FIXTURE_CATALOG) });
      checkOptics(fixture, fixturePath);
      fixtureCount += Number(fixture.count);
    });
  });
  checkList(value.floorFx, 'floorFx', (unit, path) => {
    checkFields(unit, path, {
      ...equipment,
      type: catalogKey(FLOOR_FX_CATALOG),
      x: number,
      z: number,
      spread: (v) => number(v) && v >= 0,
    });
    checkOptics(unit, path);
    fixtureCount += Number(unit.count);
  });
  if (fixtureCount > 1024)
    throw new Error('This rig exceeds the 1,024 fixtures supported across two universes.');
  if (value.props !== undefined) {
    checkList(value.props, 'props', (prop, path) => {
      if (!isStageProp(prop)) throw new Error(`Invalid scenery settings at ${path}.`);
    });
  }
}

export function parseRigJson(source: string): RigConfig {
  let rig: unknown;
  try {
    rig = JSON.parse(source);
  } catch {
    throw new Error('Choose a valid JSON file.');
  }
  checkRig(rig);
  if (rig.ledWall.cabinets) Object.assign(rig.ledWall, requestedWallSize(rig.ledWall.cabinets));
  return rig.platforms !== undefined || rig.trussPods.some((pod) => pod.shape === 'path')
    ? normalizeDesign(rig)
    : rig;
}

export function downloadRig(rig: RigConfig) {
  downloadStageFile(rig.name, 'stageforge.json', new Blob([JSON.stringify(rig, null, 2)], { type: 'application/json' }));
}

export function downloadStageFile(name: string, extension: string, blob: Blob) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  const filename = name.toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '');
  link.download = `${filename || 'stage'}.${extension}`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
