import type { RigConfig } from '../types/show';
import { computeVenueBounds } from './venueBounds';
import { STEAMBOAT_DEFAULT_PLACEMENT_MODEL_IDS } from './crowdFilmCast';
import {
  CROWD_MAX_AUTHORED_OCCUPANTS,
  CROWD_HUMAN_CLOTHING_COLORS,
  CROWD_HUMAN_SKIN_TONES,
  CROWD_MODEL_IDS_V11,
  CROWD_MODEL_IDS_V12,
  CROWD_MODEL_IDS_V13,
  CROWD_MODEL_REGISTRY,
  CROWD_PLACEMENT_ENVELOPE,
  STAGEFORGE_HUMAN_V1,
  crowdModel,
  crowdResourceAdmission,
  type CrowdModelId,
  type CrowdPose,
} from './crowdModels';

export const CROWD_GENERATOR_VERSION_1 = 1 as const;
export const CROWD_GENERATOR_VERSION_2 = 2 as const;
export type CrowdGeneratorVersion = typeof CROWD_GENERATOR_VERSION_1 | typeof CROWD_GENERATOR_VERSION_2;
export const CROWD_MAX_ZONES = 32;
export const CROWD_MAX_EXCLUSIONS = 32;
export const CROWD_MAX_EXPLICIT = 64;

export interface CrowdRect {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface CrowdModelWeight {
  modelId: CrowdModelId;
  weight: number;
}

export interface CrowdZone {
  id: string;
  kind: CrowdPose;
  rect: CrowdRect;
  occupancy: number;
  modelWeights: CrowdModelWeight[];
}

export interface CrowdExclusion {
  id: string;
  rect: CrowdRect;
}

export type CrowdExplicitPlacement = {
  id: string;
  modelId: CrowdModelId;
  yaw: number;
} & (
  | { pose: 'standing'; position: { x: number; y: number; z: number }; seatId?: never }
  | { pose: 'seated'; seatId: string; position?: never }
);

export interface CrowdLayout {
  generatorVersion: CrowdGeneratorVersion;
  seed: number;
  zones: CrowdZone[];
  exclusions: CrowdExclusion[];
  placements: CrowdExplicitPlacement[];
}

export interface TheatreSeatAnchor {
  id: string;
  row: number;
  column: number;
  x: number;
  y: number;
  z: number;
}

export interface ResolvedCrowdPlacement {
  id: string;
  source: 'generated' | 'explicit';
  zoneId?: string;
  candidateId?: string;
  modelId: CrowdModelId;
  pose: CrowdPose;
  x: number;
  y: number;
  z: number;
  rotY: number;
  scaleY: number;
  phase: number;
  paletteIndex: number;
  humanColors?: { skinToneIndex: number; clothingColorIndex: number };
  gesture: number;
  phone: boolean;
}

export interface CrowdZoneResult {
  id: string;
  capacity: number;
  requested: number;
  placed: number;
  excluded: number;
  occupied: number;
}

export interface ResolvedCrowdLayout {
  generatorVersion: typeof CROWD_GENERATOR_VERSION_1 | typeof CROWD_GENERATOR_VERSION_2;
  placements: ResolvedCrowdPlacement[];
  zones: CrowdZoneResult[];
  attempted: number;
  placed: number;
}

const UINT32_MAX = 0xffff_ffff;
const ID_PATTERN = /^(?!(?:__proto__|prototype|constructor)$)(?=.*\S)[^\u0000-\u001f\u007f]{1,64}$/u;

function fail(path: string, message: string): never {
  throw new Error(`${path} ${message}.`);
}

function finite(value: number, path: string) {
  if (!Number.isFinite(value)) fail(path, 'must be finite');
}

function validId(id: string, path: string) {
  if (!ID_PATTERN.test(id)) fail(path, 'has invalid text');
}

function validRect(rect: CrowdRect, path: string) {
  finite(rect.minX, `${path}.minX`);
  finite(rect.minZ, `${path}.minZ`);
  finite(rect.maxX, `${path}.maxX`);
  finite(rect.maxZ, `${path}.maxZ`);
  if (!(rect.minX < rect.maxX) || !(rect.minZ < rect.maxZ)) fail(path, 'must have positive width and depth');
}

function hashText(seed: number, text: string): number {
  let hash = (seed ^ 0x811c9dc5) >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d) >>> 0;
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** Public for tests: every random concern receives a distinct domain string. */
export function crowdSelection(seed: number, domain: 'location-x' | 'location-z' | 'occupancy' | 'appearance' | 'phone' | 'palette' | 'motion' | 'scale' | 'skin' | 'clothing', id: string): number {
  return hashText(seed, `${domain}\0${id}`) / 0x1_0000_0000;
}

function detailPositions(start: number, end: number, pitch: number, budget: number) {
  const count = Math.min(budget, Math.max(0, Math.floor((end - start) / pitch) + 1));
  const step = count === budget ? (end - start) / (budget - 1) : pitch;
  return Array.from({ length: count }, (_, i) => start + i * step);
}

/** Single pure source for the theatre geometry, resolver and editor. IDs survive density changes. */
export function theatreSeatAnchors(rig: Pick<RigConfig, 'venue' | 'stageWidth' | 'stageDepth'>): TheatreSeatAnchor[] {
  if (rig.venue !== 'theatre') return [];
  const front = rig.stageDepth / 2;
  const openW = Math.max(8, rig.stageWidth - 1.2);
  const houseW = Math.max(18, openW + 8);
  const rows = 14;
  const pitch = 0.95;
  const rise = 0.17;
  const firstZ = front + 3.2;
  const seatW = 0.52;
  const halfUsable = houseW / 2 - 1.3;
  const aisleX = halfUsable * 0.38;
  const xs = detailPositions(-halfUsable + seatW / 2, halfUsable - seatW / 2 + 1e-6, seatW, 96);
  const seats: TheatreSeatAnchor[] = [];
  for (let row = 0; row < rows; row++) {
    const y = row * rise;
    const z = firstZ + row * pitch + 0.05;
    for (let column = 0; column < xs.length; column++) {
      const x = xs[column];
      if (Math.abs(Math.abs(x) - aisleX) < 0.6) continue;
      seats.push({ id: `theatre:r${row + 1}:c${column + 1}`, row, column, x, y, z });
    }
  }
  return seats;
}

function pointInRect(x: number, z: number, rect: CrowdRect, radius = 0) {
  return x - radius >= rect.minX && x + radius <= rect.maxX && z - radius >= rect.minZ && z + radius <= rect.maxZ;
}

function circleHitsRect(x: number, z: number, radius: number, rect: CrowdRect) {
  const px = Math.max(rect.minX, Math.min(x, rect.maxX));
  const pz = Math.max(rect.minZ, Math.min(z, rect.maxZ));
  return Math.hypot(x - px, z - pz) < radius - 1e-9 || pointInRect(x, z, rect);
}

function placementRadius(layout: CrowdLayout, modelId: CrowdModelId, pose: CrowdPose) {
  return layout.generatorVersion === CROWD_GENERATOR_VERSION_2
    ? CROWD_PLACEMENT_ENVELOPE[pose].clearanceRadiusM
    : crowdModel(modelId).poses[pose].clearanceRadiusM;
}

function placementHeight(layout: CrowdLayout, modelId: CrowdModelId, pose: CrowdPose) {
  return layout.generatorVersion === CROWD_GENERATOR_VERSION_2
    ? CROWD_PLACEMENT_ENVELOPE[pose].maxHeightM
    : crowdModel(modelId).poses[pose].maxHeightM;
}

function collides(layout: CrowdLayout, a: CrowdFootprint, b: CrowdFootprint) {
  const ar = placementRadius(layout, a.modelId, a.pose);
  const br = placementRadius(layout, b.modelId, b.pose);
  return Math.hypot(a.x - b.x, a.z - b.z) < ar + br - 1e-6;
}

function chooseModel(layout: CrowdLayout, weights: CrowdModelWeight[], value: number): CrowdModelId {
  const ordered = layout.generatorVersion === CROWD_GENERATOR_VERSION_2
    ? [...weights].sort((a, b) => a.modelId.localeCompare(b.modelId))
    : weights;
  const total = ordered.reduce((sum, item) => sum + item.weight, 0);
  let cursor = value * total;
  for (const item of ordered) {
    cursor -= item.weight;
    if (cursor <= 0) return item.modelId;
  }
  return ordered[ordered.length - 1].modelId;
}

function resolved(
  layout: CrowdLayout,
  id: string,
  source: 'generated' | 'explicit',
  modelId: CrowdModelId,
  pose: CrowdPose,
  x: number,
  y: number,
  z: number,
  rotY: number,
  zoneId?: string,
  candidateId?: string,
): ResolvedCrowdPlacement {
  const key = source === 'explicit' ? `explicit:${id}` : `${zoneId}:${candidateId}`;
  const standing = pose === 'standing';
  return {
    id,
    source,
    ...(zoneId ? { zoneId } : {}),
    ...(candidateId ? { candidateId } : {}),
    modelId,
    pose,
    x,
    y,
    z,
    rotY,
    scaleY: standing ? 0.88 + crowdSelection(layout.seed, 'scale', key) * 0.24 : 0.68 + crowdSelection(layout.seed, 'scale', key) * 0.06,
    phase: crowdSelection(layout.seed, 'motion', key) * Math.PI * 2,
    paletteIndex: Math.floor(crowdSelection(layout.seed, 'palette', key) * 7),
    ...(modelId === 'stageforge-human-v2' ? {
      humanColors: {
        skinToneIndex: Math.floor(crowdSelection(layout.seed, 'skin', key) * CROWD_HUMAN_SKIN_TONES.length),
        clothingColorIndex: Math.floor(crowdSelection(layout.seed, 'clothing', key) * CROWD_HUMAN_CLOTHING_COLORS.length),
      },
    } : {}),
    gesture: crowdSelection(layout.seed, 'appearance', `${key}:gesture`),
    phone: standing && crowdModel(modelId).poses.standing.handset !== null && crowdSelection(layout.seed, 'phone', key) < 0.09,
  };
}

function validateHeader(layout: CrowdLayout) {
  if (layout.generatorVersion !== CROWD_GENERATOR_VERSION_1 && layout.generatorVersion !== CROWD_GENERATOR_VERSION_2) {
    fail('crowd.generatorVersion', 'has an unsupported value');
  }
  if (!Number.isSafeInteger(layout.seed) || layout.seed < 0 || layout.seed > UINT32_MAX) fail('crowd.seed', 'must be an unsigned 32-bit integer');
  if (layout.zones.length > CROWD_MAX_ZONES) fail('crowd.zones', `cannot contain more than ${CROWD_MAX_ZONES} entries`);
  if (layout.exclusions.length > CROWD_MAX_EXCLUSIONS) fail('crowd.exclusions', `cannot contain more than ${CROWD_MAX_EXCLUSIONS} entries`);
  if (layout.placements.length > CROWD_MAX_EXPLICIT) fail('crowd.placements', `cannot contain more than ${CROWD_MAX_EXPLICIT} entries`);
  const ids = new Set<string>();
  const addId = (id: string, path: string) => {
    validId(id, path);
    if (ids.has(id)) fail(path, 'duplicates another crowd ID');
    ids.add(id);
  };
  layout.zones.forEach((zone, index) => {
    const path = `crowd.zones[${index}]`;
    addId(zone.id, `${path}.id`);
    validRect(zone.rect, `${path}.rect`);
    if (!Number.isFinite(zone.occupancy) || zone.occupancy < 0 || zone.occupancy > 1) fail(`${path}.occupancy`, 'must be between 0 and 1');
    if (!zone.modelWeights.length || zone.modelWeights.length > Object.keys(CROWD_MODEL_REGISTRY).length) fail(`${path}.modelWeights`, 'has an invalid number of entries');
    const models = new Set<string>();
    let total = 0;
    zone.modelWeights.forEach((item, weightIndex) => {
      crowdModel(item.modelId);
      if (models.has(item.modelId)) fail(`${path}.modelWeights[${weightIndex}].modelId`, 'duplicates another weight');
      models.add(item.modelId);
      if (!Number.isFinite(item.weight) || item.weight <= 0 || item.weight > 1000) fail(`${path}.modelWeights[${weightIndex}].weight`, 'must be greater than zero and at most 1000');
      total += item.weight;
    });
    if (!(total > 0)) fail(`${path}.modelWeights`, 'must have positive total weight');
  });
  layout.exclusions.forEach((exclusion, index) => {
    addId(exclusion.id, `crowd.exclusions[${index}].id`);
    validRect(exclusion.rect, `crowd.exclusions[${index}].rect`);
  });
  layout.placements.forEach((placement, index) => {
    addId(placement.id, `crowd.placements[${index}].id`);
    crowdModel(placement.modelId);
    finite(placement.yaw, `crowd.placements[${index}].yaw`);
    if (placement.yaw < -360 || placement.yaw > 360) fail(`crowd.placements[${index}].yaw`, 'must be between -360 and 360 degrees');
    const raw = placement as CrowdExplicitPlacement & { position?: unknown; seatId?: unknown };
    if (placement.pose === 'standing' && (!raw.position || typeof raw.position !== 'object' || raw.seatId !== undefined)) {
      fail(`crowd.placements[${index}]`, 'must give only a floor position for a standing pose');
    }
    if (placement.pose === 'seated' && (typeof raw.seatId !== 'string' || raw.position !== undefined)) {
      fail(`crowd.placements[${index}]`, 'must give only a real seat ID for a seated pose');
    }
  });
  if (layout.generatorVersion === CROWD_GENERATOR_VERSION_1) {
    const extendedZone = layout.zones.find((zone) => zone.modelWeights.some((item) => item.modelId !== STAGEFORGE_HUMAN_V1.id));
    const extendedPlacement = layout.placements.find((placement) => placement.modelId !== STAGEFORGE_HUMAN_V1.id);
    if (extendedZone || extendedPlacement) {
      fail('crowd.generatorVersion', 'version 1 only supports stageforge-human-v1');
    }
  }
}

export function resolveCrowdLayout(rig: Pick<RigConfig, 'venue' | 'stageWidth' | 'stageDepth'>, layout: CrowdLayout): ResolvedCrowdLayout {
  validateHeader(layout);
  const bounds = computeVenueBounds(rig);
  const venueRect: CrowdRect = {
    minX: bounds.audienceZone.minX,
    minZ: bounds.audienceZone.minZ,
    maxX: bounds.audienceZone.maxX,
    maxZ: bounds.audienceZone.maxZ,
  };
  const seats = theatreSeatAnchors(rig);
  const seatById = new Map(seats.map((seat) => [seat.id, seat]));
  const exclusions = [...layout.exclusions].sort((a, b) => a.id.localeCompare(b.id));
  for (const [index, exclusion] of exclusions.entries()) {
    if (!pointInRect(exclusion.rect.minX, exclusion.rect.minZ, venueRect) || !pointInRect(exclusion.rect.maxX, exclusion.rect.maxZ, venueRect)) {
      fail(`crowd.exclusions[${index}].rect`, 'must stay inside the venue audience bounds');
    }
  }
  const placements: ResolvedCrowdPlacement[] = [];
  const usedSeats = new Set<string>();
  for (const placement of [...layout.placements].sort((a, b) => a.id.localeCompare(b.id))) {
    const model = crowdModel(placement.modelId);
    let x: number, y: number, z: number;
    if (placement.pose === 'seated') {
      const seat = seatById.get(placement.seatId);
      if (!seat) fail(`crowd.placements.${placement.id}.seatId`, 'must identify a real theatre seat');
      if (usedSeats.has(seat.id)) fail(`crowd.placements.${placement.id}.seatId`, 'duplicates another deliberate seat');
      usedSeats.add(seat.id);
      ({ x, y, z } = seat);
    } else {
      ({ x, y, z } = placement.position);
      finite(x, `crowd.placements.${placement.id}.position.x`);
      finite(y, `crowd.placements.${placement.id}.position.y`);
      finite(z, `crowd.placements.${placement.id}.position.z`);
      if (Math.abs(y) > 1e-6) fail(`crowd.placements.${placement.id}.position.y`, 'must be zero on the audience floor');
    }
    const radius = placementRadius(layout, model.id, placement.pose);
    if (!pointInRect(x, z, venueRect, radius)) fail(`crowd.placements.${placement.id}`, 'falls outside the venue audience bounds');
    if (bounds.ceilingY !== null && y + placementHeight(layout, model.id, placement.pose) > bounds.ceilingY + 1e-6) fail(`crowd.placements.${placement.id}`, 'exceeds the venue height');
    if (exclusions.some((item) => circleHitsRect(x, z, radius, item.rect))) fail(`crowd.placements.${placement.id}`, 'conflicts with an exclusion');
    const next = resolved(layout, `explicit:${placement.id}`, 'explicit', placement.modelId, placement.pose, x, y, z, placement.yaw * Math.PI / 180);
    if (placements.some((other) => collides(layout, next, other))) fail(`crowd.placements.${placement.id}`, 'collides with another deliberate placement');
    placements.push(next);
  }

  const ownedCandidates = new Set<string>();
  const zoneResults: CrowdZoneResult[] = [];
  for (const zone of [...layout.zones].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!pointInRect(zone.rect.minX, zone.rect.minZ, venueRect) || !pointInRect(zone.rect.maxX, zone.rect.maxZ, venueRect)) {
      fail(`crowd.zones.${zone.id}.rect`, 'must stay inside the venue audience bounds');
    }
    if (zone.kind === 'seated' && rig.venue !== 'theatre') fail(`crowd.zones.${zone.id}.kind`, 'requires a theatre venue');
    type Candidate = { id: string; x: number; y: number; z: number };
    const candidates: Candidate[] = [];
    if (zone.kind === 'seated') {
      const radius = layout.generatorVersion === CROWD_GENERATOR_VERSION_2
        ? CROWD_PLACEMENT_ENVELOPE.seated.clearanceRadiusM
        : 0;
      for (const seat of seats) if (pointInRect(seat.x, seat.z, zone.rect, radius)) candidates.push(seat);
    } else {
      const radius = STAGEFORGE_HUMAN_V1.poses.standing.clearanceRadiusM;
      const pitch = radius * 2 + 0.04;
      const minX = Math.ceil((zone.rect.minX + radius) / pitch);
      const maxX = Math.floor((zone.rect.maxX - radius) / pitch);
      const minZ = Math.ceil((zone.rect.minZ + radius) / pitch);
      const maxZ = Math.floor((zone.rect.maxZ - radius) / pitch);
      for (let gz = minZ; gz <= maxZ; gz++) for (let gx = minX; gx <= maxX; gx++) {
        const id = `standing:${gx}:${gz}`;
        const jitter = 0.018;
        const rawX = gx * pitch + (crowdSelection(layout.seed, 'location-x', id) * 2 - 1) * jitter;
        const rawZ = gz * pitch + (crowdSelection(layout.seed, 'location-z', id) * 2 - 1) * jitter;
        candidates.push({
          id,
          x: layout.generatorVersion === CROWD_GENERATOR_VERSION_2
            ? Math.max(zone.rect.minX + radius, Math.min(rawX, zone.rect.maxX - radius))
            : rawX,
          y: 0,
          z: layout.generatorVersion === CROWD_GENERATOR_VERSION_2
            ? Math.max(zone.rect.minZ + radius, Math.min(rawZ, zone.rect.maxZ - radius))
            : rawZ,
        });
      }
    }
    let excluded = 0;
    let occupied = 0;
    const eligible: Candidate[] = [];
    const radius = layout.generatorVersion === CROWD_GENERATOR_VERSION_2
      ? CROWD_PLACEMENT_ENVELOPE[zone.kind].clearanceRadiusM
      : crowdModel(zone.modelWeights[0].modelId).poses[zone.kind].clearanceRadiusM;
    for (const candidate of candidates) {
      const ownershipKey = zone.kind === 'seated' ? `seat:${candidate.id}` : candidate.id;
      if (ownedCandidates.has(ownershipKey)) { occupied++; continue; }
      ownedCandidates.add(ownershipKey);
      if (exclusions.some((item) => circleHitsRect(candidate.x, candidate.z, radius, item.rect))) { excluded++; continue; }
      eligible.push(candidate);
    }
    const ranked = eligible.sort((a, b) => {
      const ah = crowdSelection(layout.seed, 'occupancy', `${zone.id}:${a.id}`);
      const bh = crowdSelection(layout.seed, 'occupancy', `${zone.id}:${b.id}`);
      return ah - bh || a.id.localeCompare(b.id);
    });
    const requested = Math.floor(ranked.length * zone.occupancy + 1e-9);
    let placed = 0;
    for (const candidate of ranked.slice(0, requested)) {
      const key = `${zone.id}:${candidate.id}`;
      const modelId = chooseModel(layout, zone.modelWeights, crowdSelection(layout.seed, 'appearance', key));
      if (bounds.ceilingY !== null && candidate.y + placementHeight(layout, modelId, zone.kind) > bounds.ceilingY + 1e-6) {
        fail(`crowd.zones.${zone.id}`, 'places a model above the venue height');
      }
      const rotY = Math.atan2(-candidate.x, -candidate.z);
      const next = resolved(layout, `zone:${zone.id}:${candidate.id}`, 'generated', modelId, zone.kind, candidate.x, candidate.y, candidate.z, rotY, zone.id, candidate.id);
      if (placements.some((other) => collides(layout, next, other))) { occupied++; continue; }
      placements.push(next);
      placed++;
      if (placements.length > CROWD_MAX_AUTHORED_OCCUPANTS) fail('crowd', `resolves more than ${CROWD_MAX_AUTHORED_OCCUPANTS} occupants`);
    }
    zoneResults.push({ id: zone.id, capacity: candidates.length, requested, placed, excluded, occupied });
  }
  placements.sort((a, b) => a.id.localeCompare(b.id));
  return {
    generatorVersion: layout.generatorVersion,
    placements,
    zones: zoneResults,
    attempted: zoneResults.reduce((sum, zone) => sum + zone.requested, layout.placements.length),
    placed: placements.length,
  };
}

type CrowdPlannerRig = Pick<RigConfig, 'venue' | 'stageWidth' | 'stageDepth'>;
type CrowdPlanPoint = { x: number; z: number };
type CrowdFootprint = Pick<ResolvedCrowdPlacement, 'x' | 'z' | 'modelId' | 'pose'>;
type CrowdPlacementTarget = ({ pose: 'standing' } & CrowdPlanPoint) | { pose: 'seated'; seatId: string };
type PlannedCastMember = { id: string; modelId: CrowdModelId };
type CrowdSpot = { x: number; y: number; z: number; seatId?: string };

export type CrowdPlacementRequest = (
  | { kind: 'single'; modelId: CrowdModelId; target: CrowdPlacementTarget }
  | { kind: 'cast'; pose: CrowdPose; anchor: CrowdPlanPoint }
) & { yaw?: number; approveV1Upgrade?: boolean };

export interface CrowdV1UpgradePreview {
  peopleBefore: number;
  peopleAfter: number;
  generatedBefore: number;
  generatedAfter: number;
  generatedRemoved: number;
  generatedAdded: number;
  generatedChangedInPlace: number;
}

export type CrowdPlacementBlock =
  | 'invalid-layout' | 'invalid-target' | 'explicit-capacity' | 'total-capacity'
  | 'spot-unavailable' | 'area-exhausted' | 'search-limit' | 'would-displace' | 'render-budget';

export type CrowdPlacementPlan =
  | { status: 'added'; layout: CrowdLayout; addedIds: string[]; upgradedFromV1: boolean }
  | { status: 'unchanged'; message: string }
  | { status: 'needs-v1-approval'; message: string; preview: CrowdV1UpgradePreview }
  | { status: 'blocked'; reason: CrowdPlacementBlock; message: string };

const CAST_SCAN_LIMIT = 8192;
const CAST_FLOOR_PITCH_M = 1;
const SEAT_PICK_RADIUS_M = 0.26;

function placementBlocked(reason: CrowdPlacementBlock, message: string): CrowdPlacementPlan {
  return { status: 'blocked', reason, message };
}

/** Input is an unsnapped plan point. An occupied picked seat is reported by the planner. */
export function pickCrowdTheatreSeat(rig: CrowdPlannerRig, point: CrowdPlanPoint): TheatreSeatAnchor | undefined {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.z)) return undefined;
  let best: TheatreSeatAnchor | undefined;
  let bestDistance = Infinity;
  // The source enumerates real seats in row/column order, which breaks equal-distance ties.
  for (const seat of theatreSeatAnchors(rig)) {
    const distance = Math.hypot(point.x - seat.x, point.z - seat.z);
    if (distance <= SEAT_PICK_RADIUS_M + 1e-9 && distance < bestDistance - 1e-9) {
      best = seat;
      bestDistance = distance;
    }
  }
  return best;
}

function availableCrowdId(base: string, usedIds: Set<string>): string {
  let id = base;
  for (let suffix = 2; usedIds.has(id); suffix++) id = base + '-' + suffix;
  usedIds.add(id);
  return id;
}

function missingCastMembers(layout: CrowdLayout, usedIds: Set<string>): PlannedCastMember[] {
  const missing: PlannedCastMember[] = [];
  // Released slot order is an identity contract. Separate ordinal slots retain both light piglets.
  for (const [index, modelId] of STEAMBOAT_DEFAULT_PLACEMENT_MODEL_IDS.entries()) {
    const base = 'sw1928-cast-' + String(index + 1).padStart(2, '0');
    const slotPattern = new RegExp('^' + base + '(?:-(?:[2-9]|[1-9][0-9]+))?$');
    if (layout.placements.some(person => person.modelId === modelId && slotPattern.test(person.id))) continue;
    missing.push({ id: availableCrowdId(base, usedIds), modelId });
  }
  return missing;
}

function personStayedInPlace(a: ResolvedCrowdPlacement, b?: ResolvedCrowdPlacement): boolean {
  return !!b && a.id === b.id && a.source === b.source && a.modelId === b.modelId && a.pose === b.pose
    && a.x === b.x && a.y === b.y && a.z === b.z && a.rotY === b.rotY;
}

function crowdUpgradePreview(before: ResolvedCrowdLayout, after: ResolvedCrowdLayout): CrowdV1UpgradePreview {
  const old = before.placements.filter(person => person.source === 'generated');
  const next = after.placements.filter(person => person.source === 'generated');
  const byId = new Map(next.map(person => [person.id, person]));
  let generatedRemoved = 0;
  let generatedChangedInPlace = 0;
  for (const person of old) {
    const replacement = byId.get(person.id);
    if (!replacement) generatedRemoved++;
    else if (!personStayedInPlace(person, replacement)) generatedChangedInPlace++;
  }
  return {
    peopleBefore: before.placed, peopleAfter: after.placed, generatedBefore: old.length, generatedAfter: next.length,
    generatedRemoved, generatedAdded: next.length - (old.length - generatedRemoved), generatedChangedInPlace,
  };
}

type CrowdSpotSearch = { count: number; spots: Iterable<CrowdSpot> };

function standingCastSpots(rect: CrowdRect, radius: number, anchor: CrowdPlanPoint): CrowdSpotSearch {
  const left = rect.minX + radius, right = rect.maxX - radius;
  const front = rect.minZ + radius, back = rect.maxZ - radius;
  if (left > right || front > back) return { count: 0, spots: [] };
  const x0 = Math.max(left, Math.min(right, anchor.x));
  const z0 = Math.max(front, Math.min(back, anchor.z));
  const minI = Math.ceil((left - x0) / CAST_FLOOR_PITCH_M), maxI = Math.floor((right - x0) / CAST_FLOOR_PITCH_M);
  const minJ = Math.ceil((front - z0) / CAST_FLOOR_PITCH_M), maxJ = Math.floor((back - z0) / CAST_FLOOR_PITCH_M);
  const count = (maxI - minI + 1) * (maxJ - minJ + 1);
  type Cell = { i: number; j: number; dist2: number };

  function* spots(): Generator<CrowdSpot> {
    // Each row starts at x0 and expands in both directions. Each grid cell has one parent.
    // Keep the nearest candidate at the end, with Z then X breaking distance ties.
    const queue: Cell[] = [{ i: 0, j: 0, dist2: 0 }];
    function offer(i: number, j: number) {
      if (i < minI || i > maxI || j < minJ || j > maxJ) return;
      const dist2 = i * i + j * j;
      let low = 0, high = queue.length;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        const other = queue[mid];
        const order = other.dist2 - dist2 || other.j - j || other.i - i;
        if (order > 0) low = mid + 1;
        else high = mid;
      }
      queue.splice(low, 0, { i, j, dist2 });
    }
    while (queue.length) {
      const { i, j } = queue.pop()!;
      yield { x: x0 + i * CAST_FLOOR_PITCH_M, y: 0, z: z0 + j * CAST_FLOOR_PITCH_M };
      if (i === 0 && j >= 0) offer(0, j + 1);
      if (i === 0 && j <= 0) offer(0, j - 1);
      if (i >= 0) offer(i + 1, j);
      if (i <= 0) offer(i - 1, j);
    }
  }
  return { count, spots: spots() };
}

function searchCastSeats(seats: readonly TheatreSeatAnchor[], anchor: CrowdPlanPoint): CrowdSpotSearch {
  const distance = (seat: TheatreSeatAnchor) => (seat.x - anchor.x) ** 2 + (seat.z - anchor.z) ** 2;
  const ordered = [...seats].sort((a, b) => distance(a) - distance(b) || a.row - b.row || a.column - b.column);
  return { count: ordered.length, spots: ordered.map(seat => ({ x: seat.x, y: seat.y, z: seat.z, seatId: seat.id })) };
}

/** Compute an entire edit without changing the input, its arrays, or editor history. */
export function planCrowdPlacement(rig: CrowdPlannerRig, layout: CrowdLayout, request: CrowdPlacementRequest): CrowdPlacementPlan {
  try {
    const pose = request.kind === 'single' ? request.target.pose : request.pose;
    if (request.yaw !== undefined && (!Number.isFinite(request.yaw) || Math.abs(request.yaw) > 360)) {
      return placementBlocked('invalid-target', 'Enter a finite yaw between -360 and 360 degrees.');
    }
    if (pose !== 'standing' && pose !== 'seated') return placementBlocked('invalid-target', 'Choose standing or seated placement.');
    if (pose === 'seated' && rig.venue !== 'theatre') return placementBlocked('invalid-target', 'A seated placement needs a theatre seat.');
    const before = resolveCrowdLayout(rig, layout);
    const usedIds = new Set([...layout.zones, ...layout.exclusions, ...layout.placements].map(item => item.id));
    const missing = request.kind === 'cast' ? missingCastMembers(layout, usedIds)
      : [{ id: availableCrowdId('crowd-person', usedIds), modelId: request.modelId }];
    if (!missing.length) return { status: 'unchanged', message: 'All cast slots are already placed.' };
    for (const member of missing) crowdModel(member.modelId);
    const freeExplicit = CROWD_MAX_EXPLICIT - layout.placements.length;
    if (missing.length > freeExplicit) {
      return placementBlocked('explicit-capacity', 'This edit needs ' + missing.length + ' deliberate slots. ' + freeExplicit + ' of ' + CROWD_MAX_EXPLICIT + ' are available.');
    }

    const upgrade = layout.generatorVersion === CROWD_GENERATOR_VERSION_1 && missing.some(member => member.modelId !== STAGEFORGE_HUMAN_V1.id);
    const working: CrowdLayout = upgrade ? { ...layout, generatorVersion: CROWD_GENERATOR_VERSION_2 } : layout;
    const baseline = upgrade ? resolveCrowdLayout(rig, working) : before;
    const freePeople = CROWD_MAX_AUTHORED_OCCUPANTS - baseline.placed;
    if (missing.length > freePeople) {
      return placementBlocked('total-capacity', 'This edit adds ' + missing.length + ' people. ' + freePeople + ' of ' + CROWD_MAX_AUTHORED_OCCUPANTS + ' places are available.');
    }

    const bounds = computeVenueBounds(rig);
    const seats = pose === 'seated' ? theatreSeatAnchors(rig) : [];
    let search: CrowdSpotSearch;
    if (request.kind === 'cast') {
      const { anchor } = request;
      if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.z) || !pointInRect(anchor.x, anchor.z, bounds.audienceZone)) {
        return placementBlocked('invalid-target', 'Choose a cast anchor inside the venue audience area.');
      }
      search = pose === 'seated' ? searchCastSeats(seats, anchor)
        : standingCastSpots(bounds.audienceZone, placementRadius(working, missing[0].modelId, pose), anchor);
    } else if (request.target.pose === 'seated') {
      const { seatId } = request.target;
      const seat = seats.find(item => item.id === seatId);
      if (!seat) return placementBlocked('invalid-target', 'Choose an existing theatre seat.');
      search = { count: 1, spots: [{ x: seat.x, y: seat.y, z: seat.z, seatId }] };
    } else {
      const { x, z } = request.target;
      if (!Number.isFinite(x) || !Number.isFinite(z)) return placementBlocked('invalid-target', 'Enter finite floor coordinates.');
      search = { count: 1, spots: [{ x, y: 0, z }] };
    }

    const occupied: CrowdFootprint[] = [...baseline.placements];
    const additions: CrowdExplicitPlacement[] = [];
    let examined = 0;
    for (const spot of search.spots) {
      const { id, modelId } = missing[additions.length];
      const footprint: CrowdFootprint = { x: spot.x, z: spot.z, modelId, pose };
      const radius = placementRadius(working, modelId, pose);
      let conflict: string | undefined;
      if (!pointInRect(spot.x, spot.z, bounds.audienceZone, radius)) conflict = 'The character extends outside the venue audience area.';
      else if (bounds.ceilingY !== null && spot.y + placementHeight(working, modelId, pose) > bounds.ceilingY + 1e-6) conflict = 'The character exceeds the venue ceiling.';
      else if (working.exclusions.some(item => circleHitsRect(spot.x, spot.z, radius, item.rect))) conflict = 'The position intersects a crowd exclusion.';
      else if (occupied.some(other => collides(working, footprint, other))) conflict = 'The position is occupied or lacks clearance from another person.';
      examined++;
      if (!conflict) {
        const yaw = request.yaw ?? Math.atan2(-spot.x, -spot.z) * 180 / Math.PI;
        additions.push(spot.seatId !== undefined
          ? { id, modelId, yaw, pose: 'seated', seatId: spot.seatId }
          : { id, modelId, yaw, pose: 'standing', position: { x: spot.x, y: 0, z: spot.z } });
        occupied.push(footprint);
        if (additions.length === missing.length) break;
      } else if (request.kind === 'single') {
        return placementBlocked('spot-unavailable', conflict);
      }
      if (examined === CAST_SCAN_LIMIT) break;
    }

    if (additions.length !== missing.length) {
      const summary = 'Found ' + additions.length + ' of ' + missing.length + ' needed locations. No characters were added.';
      if (examined < search.count) return placementBlocked('search-limit', 'Checked the nearest ' + examined + ' positions. ' + summary + ' Choose a different cast anchor.');
      const area = pose === 'seated' ? 'Checked all real theatre seats. ' : 'Checked the full 1 m placement grid for this anchor. ';
      return placementBlocked('area-exhausted', area + summary);
    }
    const next = { ...working, placements: [...working.placements, ...additions] };
    const final = resolveCrowdLayout(rig, next);
    const byId = new Map(final.placements.map(person => [person.id, person]));
    if (final.placed !== baseline.placed + additions.length ||
        baseline.placements.some(person => !personStayedInPlace(person, byId.get(person.id)))) {
      return placementBlocked('would-displace', 'The edit would move or replace existing crowd members. Choose another location.');
    }
    if (!crowdResourceAdmission(final.placements, 'xr').admitted) {
      return placementBlocked('render-budget', 'This model combination exceeds the stereo crowd rendering budget. No characters were added.');
    }
    if (upgrade && before.placed > 0 && !request.approveV1Upgrade) {
      return {
        status: 'needs-v1-approval',
        preview: crowdUpgradePreview(before, baseline),
        message: 'These characters require crowd generator 2. Review its effect on the existing crowd and its animation before adding them.',
      };
    }
    return { status: 'added', layout: next, addedIds: additions.map(person => person.id), upgradedFromV1: upgrade };
  } catch (error) {
    return placementBlocked('invalid-layout', error instanceof Error ? error.message : 'The crowd layout could not be resolved.');
  }
}

export function makeDefaultCrowd(rig: Pick<RigConfig, 'venue' | 'stageWidth' | 'stageDepth'>): CrowdLayout {
  const bounds = computeVenueBounds(rig).audienceZone;
  const marginX = Math.min(1.5, Math.max(0.5, (bounds.maxX - bounds.minX) * 0.08));
  const marginZ = Math.min(2, Math.max(0.5, (bounds.maxZ - bounds.minZ) * 0.08));
  const layout: CrowdLayout = {
    generatorVersion: CROWD_GENERATOR_VERSION_1,
    seed: 249057,
    zones: [{
      id: rig.venue === 'theatre' ? 'stalls' : 'floor',
      kind: rig.venue === 'theatre' ? 'seated' : 'standing',
      rect: { minX: bounds.minX + marginX, minZ: bounds.minZ + marginZ, maxX: bounds.maxX - marginX, maxZ: bounds.maxZ - marginZ },
      occupancy: 0,
      modelWeights: [{ modelId: 'stageforge-human-v1', weight: 1 }],
    }],
    exclusions: [],
    placements: [],
  };
  const capacity = resolveCrowdLayout(rig, layout).zones[0]?.capacity ?? 0;
  layout.zones[0].occupancy = capacity ? Math.min(0.65, 640 / capacity) : 0;
  return layout;
}

export const CROWD_MODEL_PRESETS = {
  'human-only': {
    label: 'StageForge human',
    weights: [{ modelId: 'stageforge-human-v1', weight: 1 }],
  },
  'original-trio': {
    label: 'Original human, robot and alien',
    weights: [
      { modelId: 'stageforge-human-v1', weight: 6 },
      { modelId: 'stageforge-robot-v1', weight: 2 },
      { modelId: 'stageforge-alien-v1', weight: 2 },
    ],
  },
  'original-library': {
    label: 'Original characters and human variants',
    weights: [
      { modelId: 'stageforge-human-v1', weight: 2 },
      { modelId: 'stageforge-human-v2', weight: 5 },
      { modelId: 'stageforge-robot-v1', weight: 1 },
      { modelId: 'stageforge-alien-v1', weight: 1 },
      { modelId: 'stageforge-fox-v1', weight: 1 },
    ],
  },
  'original-with-cartoons': {
    label: 'Original crowd with monochrome characters',
    weights: [
      { modelId: 'stageforge-human-v1', weight: 2 },
      { modelId: 'stageforge-human-v2', weight: 4 },
      { modelId: 'stageforge-robot-v1', weight: 1 },
      { modelId: 'stageforge-alien-v1', weight: 1 },
      { modelId: 'stageforge-fox-v1', weight: 1 },
      { modelId: 'stageforge-moth-v1', weight: 1 },
      { modelId: 'stageforge-ticket-taker-v1', weight: 1 },
    ],
  },
} as const satisfies Record<string, { label: string; weights: readonly CrowdModelWeight[] }>;

export type CrowdModelMix = keyof typeof CROWD_MODEL_PRESETS;

function totalModelWeight(weights: readonly CrowdModelWeight[]): number {
  return weights.reduce((sum, item) => sum + item.weight, 0);
}

export function crowdModelMix(layout: CrowdLayout): CrowdModelMix | 'custom' {
  if (!layout.zones.length) return layout.placements.length ? 'custom' : 'human-only';
  const presetIds = Object.keys(CROWD_MODEL_PRESETS) as CrowdModelMix[];
  return presetIds.find(mix => {
    const { weights } = CROWD_MODEL_PRESETS[mix];
    const presetTotal = totalModelWeight(weights);
    return layout.placements.every(placement => weights.some(item => item.modelId === placement.modelId))
      && layout.zones.every(zone => {
        if (zone.modelWeights.length !== weights.length) return false;
        const zoneTotal = totalModelWeight(zone.modelWeights);
        return weights.every(({ modelId, weight }) => {
          const stored = zone.modelWeights.find(item => item.modelId === modelId);
          return stored && Math.abs(stored.weight / zoneTotal - weight / presetTotal) < 1e-9;
        });
      });
  }) ?? 'custom';
}

/** Applying generated zone weights leaves deliberate placements in place. */
export function withCrowdModelMix(layout: CrowdLayout, mix: CrowdModelMix): CrowdLayout {
  if (!layout.zones.length) return layout;
  const { weights } = CROWD_MODEL_PRESETS[mix];
  return {
    ...layout,
    generatorVersion: mix === 'human-only' ? layout.generatorVersion : CROWD_GENERATOR_VERSION_2,
    zones: layout.zones.map(zone => ({ ...zone, modelWeights: weights.map(item => ({ ...item })) })),
  };
}

export function crowdShowVersion(layout: CrowdLayout): 10 | 11 | 12 | 13 | 14 {
  const modelIds = [
    ...layout.zones.flatMap(zone => zone.modelWeights.map(item => item.modelId)),
    ...layout.placements.map(placement => placement.modelId),
  ];
  if (modelIds.some(modelId => !CROWD_MODEL_IDS_V13.some(known => known === modelId))) return 14;
  if (modelIds.some(modelId => !CROWD_MODEL_IDS_V12.some(known => known === modelId))) return 13;
  if (modelIds.some(modelId => !CROWD_MODEL_IDS_V11.some(known => known === modelId))) return 12;
  if (layout.generatorVersion === CROWD_GENERATOR_VERSION_2
    || modelIds.some(modelId => modelId !== STAGEFORGE_HUMAN_V1.id)) return 11;
  return 10;
}
