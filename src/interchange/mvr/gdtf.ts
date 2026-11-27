import type { FixtureType, FloorFxType } from '../../types/show';
import { readArchive, utf8, writeArchive } from './archive';
import { cieXyYToSrgb, parseCieXyY, type CieXyY, type SrgbColor } from './color';
import { attr, buildXml, child, list, MAX_XML_BYTES, MAX_XML_DEPTH, parseXml, type XmlNode } from './xml';
import { uuidV5 } from './uuid';

/**
 * Generic GDTF 1.2 profiles for StageForge's simulated hardware, plus a reader for the parts of
 * third-party GDTF files the importer needs. Channel order matches what StageEngine writes into
 * its DMX universes, so a console patched from an exported MVR drives the same controls.
 */

export type Hardware = FixtureType | FloorFxType;

interface Channel {
  attribute: string;
  /** Name of the first channel function (defaults to `<attribute> 1`). */
  name?: string;
  geometry: string;
  default: number;
  from?: number;
  to?: number;
  highlight?: number;
  /** Extra channel functions after the first (DMX start value, attribute, name). */
  functions?: Array<{ dmxFrom: number; attribute: string; name: string; from: number; to: number }>;
}

interface Profile {
  file: string;
  name: string;
  shortName: string;
  description: string;
  moving: boolean;
  beam: { type: 'Spot' | 'Wash'; angle: number; flux: number } | null;
  channels: Channel[];
}

const PAN_TILT: Channel[] = [
  { attribute: 'Pan', geometry: 'Yoke', default: 128, from: -270, to: 270 },
  { attribute: 'Tilt', geometry: 'Head', default: 128, from: -135, to: 135 },
];
const RGB = (geometry: string): Channel[] => ['ColorAdd_R', 'ColorAdd_G', 'ColorAdd_B'].map((attribute) => ({
  attribute, geometry, default: 255, from: 0, to: 1, highlight: 255,
}));
// StageEngine writes 0 for no strobe and scales the strobe rate over 1-255, so DMX 0 is Open.
const SHUTTER = (geometry: string): Channel => ({
  attribute: 'Shutter1', name: 'Open', geometry, default: 0, from: 1, to: 1,
  functions: [{ dmxFrom: 1, attribute: 'Shutter1Strobe', name: 'Strobe', from: 0.5, to: 25 }],
});
const DIMMER = (geometry: string): Channel => ({ attribute: 'Dimmer', geometry, default: 0, from: 0, to: 1, highlight: 255 });

const movingHead = (kind: 'Beam' | 'Wash', angle: number, flux: number): Profile => ({
  file: `StageForge@Moving_${kind}.gdtf`,
  name: `Moving ${kind}`,
  shortName: `SF ${kind}`,
  description: `StageForge generic RGB moving ${kind.toLowerCase()}: pan, tilt, dimmer, RGB, zoom, shutter`,
  moving: true,
  beam: { type: kind === 'Beam' ? 'Spot' : 'Wash', angle, flux },
  channels: [...PAN_TILT, DIMMER('Beam'), ...RGB('Beam'), { attribute: 'Zoom', geometry: 'Beam', default: 128, from: 3, to: 45 }, SHUTTER('Beam')],
});

/** One profile per StageForge hardware type (moving beams and floor beams share a profile). */
export const PROFILES: Record<Hardware, Profile> = {
  beam: movingHead('Beam', 4, 6000),
  floor_beam: movingHead('Beam', 4, 6000),
  wash: movingHead('Wash', 25, 9000),
  strobe: {
    file: 'StageForge@Strobe.gdtf', name: 'Strobe', shortName: 'SF Strobe',
    description: 'StageForge generic strobe: intensity, strobe rate', moving: false,
    beam: { type: 'Wash', angle: 110, flux: 40000 },
    channels: [DIMMER('Beam'), SHUTTER('Beam')],
  },
  blinder: {
    file: 'StageForge@Blinder.gdtf', name: 'Blinder', shortName: 'SF Blinder',
    description: 'StageForge generic blinder: intensity', moving: false,
    beam: { type: 'Wash', angle: 90, flux: 30000 },
    channels: [DIMMER('Beam')],
  },
  laser: {
    file: 'StageForge@Laser.gdtf', name: 'Laser', shortName: 'SF Laser',
    description: 'StageForge generic laser projector: intensity, pattern, size X/Y, speed, rotation, beam count, strobe',
    moving: false, beam: { type: 'Spot', angle: 0.5, flux: 2000 },
    channels: [
      DIMMER('Beam'),
      { attribute: 'Gobo1', geometry: 'Beam', default: 0, from: 0, to: 7 },
      { attribute: 'Effects1Adjust1', geometry: 'Beam', default: 128, from: 0, to: 1 },
      { attribute: 'Effects1Adjust2', geometry: 'Beam', default: 128, from: 0, to: 1 },
      { attribute: 'Effects1Rate', geometry: 'Beam', default: 128, from: 0, to: 1 },
      { attribute: 'Effects1Pos', geometry: 'Beam', default: 0, from: 0, to: 360 },
      { attribute: 'Effects1Adjust3', geometry: 'Beam', default: 128, from: 4, to: 32 },
      SHUTTER('Beam'),
    ],
  },
  hazer: fx('Hazer', 'StageForge generic hazer: haze output'),
  smoke: fx('Smoke_Machine', 'StageForge generic smoke machine: smoke output'),
  co2: fx('CO2_Jet', 'StageForge generic CO2 jet: jet output'),
  floor_laser: {
    file: 'StageForge@Laser.gdtf', name: 'Laser', shortName: 'SF Laser', description: '', moving: false, beam: null, channels: [],
  },
};
PROFILES.floor_laser = PROFILES.laser;

function fx(name: string, description: string): Profile {
  return {
    file: `StageForge@${name}.gdtf`, name: name.replace(/_/g, ' '), shortName: `SF ${name.split('_')[0]}`,
    description, moving: false, beam: null,
    channels: [{ attribute: 'Dimmer', geometry: 'Base', default: 0, from: 0, to: 1 }],
  };
}

export const MODE_NAME = 'StageForge';

const FEATURES: Record<string, { feature: string; activation?: string; unit?: string; main?: string; pretty: string }> = {
  Pan: { feature: 'Position.PanTilt', activation: 'PanTilt', unit: 'Angle', pretty: 'P' },
  Tilt: { feature: 'Position.PanTilt', activation: 'PanTilt', unit: 'Angle', pretty: 'T' },
  Dimmer: { feature: 'Dimmer.Dimmer', pretty: 'Dim' },
  ColorAdd_R: { feature: 'Color.RGB', activation: 'ColorRGB', unit: 'ColorComponent', pretty: 'R' },
  ColorAdd_G: { feature: 'Color.RGB', activation: 'ColorRGB', unit: 'ColorComponent', pretty: 'G' },
  ColorAdd_B: { feature: 'Color.RGB', activation: 'ColorRGB', unit: 'ColorComponent', pretty: 'B' },
  Zoom: { feature: 'Focus.Focus', unit: 'Angle', pretty: 'Zoom' },
  Shutter1: { feature: 'Beam.Beam', pretty: 'Sh1' },
  Shutter1Strobe: { feature: 'Beam.Beam', unit: 'Frequency', main: 'Shutter1', pretty: 'Strobe1' },
  Gobo1: { feature: 'Gobo.Gobo', pretty: 'G1' },
  Effects1Adjust1: { feature: 'Beam.Beam', pretty: 'Size X' },
  Effects1Adjust2: { feature: 'Beam.Beam', pretty: 'Size Y' },
  Effects1Adjust3: { feature: 'Beam.Beam', pretty: 'Beams' },
  Effects1Rate: { feature: 'Beam.Beam', pretty: 'Speed' },
  Effects1Pos: { feature: 'Beam.Beam', unit: 'Angle', pretty: 'Rotation' },
};

const dmx = (value: number) => `${Math.round(value)}/1`;
const upper = (id: string) => id.toUpperCase();
const ident = '{1,0,0,0}{0,1,0,0}{0,0,1,0}{0,0,0,1}';
const offsetZ = (z: number) => `{1,0,0,0}{0,1,0,0}{0,0,1,${z}}{0,0,0,1}`;

export function profileFor(type: Hardware, width = PROFILES[type].channels.length): Profile {
  const profile = PROFILES[type];
  if (!Number.isSafeInteger(width) || width < 1 || width > 512) throw new Error(`Cannot export a GDTF mode reserving ${width} channels.`);
  if (width === profile.channels.length) return profile;
  const reservationOnly = width < profile.channels.length;
  const channels = reservationOnly ? [] : profile.channels.slice();
  for (let offset = channels.length + 1; offset <= width; offset++) {
    channels.push({ attribute: `Reserved_${offset}`, geometry: 'Base', default: 0, from: 0, to: 0 });
  }
  return {
    ...profile,
    file: profile.file.replace(/\.gdtf$/i, `_${width}ch.gdtf`),
    name: `${profile.name} ${width}ch`,
    description: `Generic ${profile.name}, ${width} reserved slots${reservationOnly ? ' (reservation only)' : ', unused offsets unmapped'}.`,
    moving: !reservationOnly && profile.moving,
    beam: reservationOnly ? null : profile.beam,
    channels,
  };
}

function attributeFeature(name: string): typeof FEATURES[string] {
  return FEATURES[name] ?? { feature: 'Control.Reserved', pretty: name.replace('_', ' ') };
}

/** description.xml for a generic profile (validated against the official GDTF 1.2 XSD in development). */
export function profileDescription(profile: Profile): string {
  const attributes = [...new Set(profile.channels.flatMap((c) => [c.attribute, ...(c.functions?.map((f) => f.attribute) ?? [])]))];
  const needsShutter = attributes.includes('Shutter1Strobe') && !attributes.includes('Shutter1');
  if (needsShutter) attributes.push('Shutter1');
  const features = new Map<string, Set<string>>();
  const activations = new Set<string>();
  for (const name of attributes) {
    const meta = attributeFeature(name);
    const [group, feature] = meta.feature.split('.');
    if (!features.has(group)) features.set(group, new Set());
    features.get(group)!.add(feature);
    if (meta.activation) activations.add(meta.activation);
  }
  const beam = profile.beam && {
    '@_Name': 'Beam', '@_Model': 'Beam', '@_Position': offsetZ(profile.moving ? -0.15 : -0.1), '@_LampType': 'LED',
    '@_PowerConsumption': '300', '@_LuminousFlux': String(profile.beam.flux), '@_ColorTemperature': '6500',
    '@_BeamAngle': String(profile.beam.angle), '@_FieldAngle': String(profile.beam.angle * 1.3),
    '@_BeamRadius': '0.05', '@_BeamType': profile.beam.type, '@_ColorRenderingIndex': '80',
  };
  const geometry = profile.moving
    ? { '@_Name': 'Base', '@_Model': 'Base',
        Axis: [{ '@_Name': 'Yoke', '@_Model': 'Yoke', '@_Position': offsetZ(-0.12),
          Axis: [{ '@_Name': 'Head', '@_Model': 'Head', '@_Position': offsetZ(-0.2), Beam: [beam] }] }] }
    : { '@_Name': 'Base', '@_Model': 'Base', ...(beam ? { Beam: [beam] } : {}) };
  const models = [
    { '@_Name': 'Base', '@_Length': '0.3', '@_Width': '0.25', '@_Height': '0.12', '@_PrimitiveType': 'Base' },
    ...(profile.moving ? [
      { '@_Name': 'Yoke', '@_Length': '0.3', '@_Width': '0.12', '@_Height': '0.3', '@_PrimitiveType': 'Yoke' },
      { '@_Name': 'Head', '@_Length': '0.2', '@_Width': '0.2', '@_Height': '0.3', '@_PrimitiveType': 'Head' },
    ] : []),
    ...(beam ? [{ '@_Name': 'Beam', '@_Length': '0.1', '@_Width': '0.1', '@_Height': '0.01', '@_PrimitiveType': 'Cylinder' }] : []),
  ];
  const channels = profile.channels.map((c, i) => {
    const firstName = c.name ?? `${c.attribute} 1`;
    const first = { '@_Name': firstName, '@_Attribute': c.attribute, '@_DMXFrom': '0/1', '@_Default': dmx(c.default),
      '@_PhysicalFrom': String(c.from ?? 0), '@_PhysicalTo': String(c.to ?? 1) };
    const extra = (c.functions ?? []).map((f) => ({ '@_Name': f.name, '@_Attribute': f.attribute, '@_DMXFrom': dmx(f.dmxFrom),
      '@_Default': dmx(f.dmxFrom), '@_PhysicalFrom': String(f.from), '@_PhysicalTo': String(f.to) }));
    const initial = c.functions?.find((f) => f.dmxFrom === c.default)?.name ?? firstName;
    return {
      '@_DMXBreak': '1', '@_Offset': String(i + 1), ...(c.highlight !== undefined ? { '@_Highlight': dmx(c.highlight) } : {}),
      '@_Geometry': c.geometry, '@_InitialFunction': `${c.geometry}_${c.attribute}.${c.attribute}.${initial}`,
      LogicalChannel: [{ '@_Attribute': c.attribute, ...(c.attribute === 'Dimmer' ? { '@_Master': 'Grand' } : {}),
        ChannelFunction: [first, ...extra] }],
    };
  });
  return buildXml({
    GDTF: {
      '@_DataVersion': '1.2',
      FixtureType: {
        '@_Name': profile.name, '@_ShortName': profile.shortName, '@_LongName': `StageForge ${profile.name}`,
        '@_Manufacturer': 'StageForge', '@_Description': profile.description,
        '@_FixtureTypeID': upper(uuidV5(`gdtf:${profile.file}`)), '@_CanHaveChildren': 'No',
        AttributeDefinitions: {
          ...(activations.size ? { ActivationGroups: { ActivationGroup: [...activations].map((name) => ({ '@_Name': name })) } } : {}),
          FeatureGroups: { FeatureGroup: [...features].map(([group, set]) => ({
            '@_Name': group, '@_Pretty': group, Feature: [...set].map((name) => ({ '@_Name': name })) })) },
          Attributes: { Attribute: attributes.map((name) => {
            const meta = attributeFeature(name);
            return { '@_Name': name, '@_Pretty': meta.pretty, ...(meta.activation ? { '@_ActivationGroup': meta.activation } : {}),
              ...(meta.main ? { '@_MainAttribute': meta.main } : {}), '@_Feature': meta.feature,
              ...(meta.unit ? { '@_PhysicalUnit': meta.unit } : {}) };
          }) },
        },
        Wheels: '',
        PhysicalDescriptions: '',
        Models: { Model: models },
        Geometries: { Geometry: [geometry] },
        DMXModes: { DMXMode: [{ '@_Name': MODE_NAME, '@_Geometry': 'Base', DMXChannels: { DMXChannel: channels } }] },
        Revisions: { Revision: [{ '@_Text': 'Generated by StageForge', '@_Date': '2026-01-01T00:00:00', '@_UserID': '0', '@_ModifiedBy': 'StageForge' }] },
        FTPresets: '',
        Protocols: '',
      },
    },
  });
}

/** A complete .gdtf archive for a generic profile. */
export function profileArchive(profile: Profile): Uint8Array {
  return writeArchive([{ name: 'description.xml', data: utf8.encode(profileDescription(profile)) }]);
}

export interface GdtfChannelFunction {
  name: string;
  attribute: string;
  /** Start DMX value in the channel's native resolution (0 .. 256^bytes - 1). */
  dmxFrom: number;
  /** Inclusive end DMX value in the channel's native resolution. */
  dmxTo: number;
  /** Channel byte resolution (1..4). */
  bytes: number;
  physicalFrom: number;
  physicalTo: number;
}

export interface GdtfModeBreak {
  /** 1-based GDTF DMXBreak (maps to MVR 0-based break = dmxBreak - 1). */
  dmxBreak: number;
  /** Highest occupied DMX slot (1..512) on this break. */
  footprint: number;
}

export interface GdtfModeSummary {
  name: string;
  /** Highest slot on primary break (DMXBreak 1, or lowest break present). */
  footprint: number;
  /** Per-break footprints sorted ascending by 1-based dmxBreak. */
  breaks: GdtfModeBreak[];
  /** Sum of footprints across all breaks. */
  totalSlots: number;
  attributes: string[];
  /** Parsed channel functions (present when the mode defines ChannelFunction elements). */
  functions?: GdtfChannelFunction[];
  /** Diagnostic flags for malformed breaks, cycles or out-of-range slots. */
  flags?: string[];
}

export interface GdtfEmitterColor {
  name: string;
  color: CieXyY;
  srgb: SrgbColor;
}

/** What the importer needs from a GDTF file. */
export interface GdtfSummary {
  name: string;
  manufacturer: string;
  modes: GdtfModeSummary[];
  beamType?: string;
  beamAngle?: number;
  hasLaser: boolean;
  emitters?: GdtfEmitterColor[];
}

/** A single supported break is required to reserve or export one physical address span. */
export function singleBreakGdtfMode(summary: GdtfSummary, modeName?: string): GdtfModeSummary | undefined {
  const mode = modeName ? summary.modes.find(candidate => candidate.name === modeName) : summary.modes[0];
  if (mode?.name && !mode.flags?.length && mode.breaks.length === 1 && mode.breaks[0].dmxBreak === 1 && mode.footprint > 0) return mode;
}

const MAX_DMX_BREAK = 64;
const MAX_GEOMETRY_REFS = 4096;
const MAX_REF_TEMPLATE_OPS = 200_000;

export interface GdtfReadBudget {
  remaining: number;
  /** Shared GeometryReference expansion/template work budget across modes and files. */
  opsRemaining?: number;
}

/**
 * Parse a GDTF DMX value string ("v/n", n in 1..4) and scale it to `targetBytes` (1..4).
 * Returns undefined on malformed strings.
 */
export function parseGdtfDmxValue(raw: string | undefined, targetBytes = 1): number | undefined {
  if (!raw) return undefined;
  const match = /^\s*(\d+)\s*\/\s*([1-4])\s*$/.exec(raw);
  if (!match) return undefined;
  const value = Number(match[1]);
  const bytes = Number(match[2]);
  const maxSrc = Math.pow(256, bytes);
  if (!Number.isSafeInteger(value) || value < 0 || value >= maxSrc) return undefined;
  const dst = Math.max(1, Math.min(4, Math.trunc(targetBytes)));
  if (bytes === dst) return value;
  if (bytes < dst) return value * Math.pow(256, dst - bytes);
  return Math.floor(value / Math.pow(256, bytes - dst));
}

/**
 * Interpolate a physical value for a GDTF channel function at `dmx`.
 * Reversed ranges (physicalFrom > physicalTo) are preserved without swapping.
 */
export function physicalAt(
  fn: Pick<GdtfChannelFunction, 'dmxFrom' | 'dmxTo' | 'physicalFrom' | 'physicalTo'>,
  dmx: number,
): number {
  const clamped = Math.max(fn.dmxFrom, Math.min(fn.dmxTo, dmx));
  const span = fn.dmxTo - fn.dmxFrom;
  if (span <= 0) return fn.physicalFrom;
  return fn.physicalFrom + (fn.physicalTo - fn.physicalFrom) * ((clamped - fn.dmxFrom) / span);
}

interface RefBreak {
  dmxBreak: number;
  dmxOffset: number;
}

interface ResolvedRef {
  target: string;
  breaks: RefBreak[];
}

/** Collect all non-GeometryReference geometry names within a geometry subtree. */
function collectSubtreeNames(node: XmlNode, out: Set<string>, depth = 0): void {
  if (depth > MAX_XML_DEPTH) return;
  const ownName = attr(node, 'Name');
  if (ownName) out.add(ownName);
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_') || key === 'GeometryReference' || !value || typeof value !== 'object') continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item && typeof item === 'object') collectSubtreeNames(item as XmlNode, out, depth + 1);
    }
  }
}

function parseRefBreaks(refNode: XmlNode, flags: Set<string>): RefBreak[] {
  const rawBreaks = list(refNode, 'Break');
  if (!rawBreaks.length) return [{ dmxBreak: 1, dmxOffset: 1 }];
  const out: RefBreak[] = [];
  for (const brk of rawBreaks.slice(0, MAX_DMX_BREAK)) {
    const rawBreak = attr(brk, 'DMXBreak');
    const dmxBreak = rawBreak === undefined || rawBreak === '' ? 1 : Number(rawBreak);
    const rawOffset = attr(brk, 'DMXOffset');
    const dmxOffset = rawOffset === undefined || rawOffset === '' ? 1 : Number(rawOffset);
    if (!Number.isInteger(dmxBreak) || dmxBreak < 1 || dmxBreak > MAX_DMX_BREAK) {
      flags.add('invalidBreak');
      continue;
    }
    if (!Number.isInteger(dmxOffset) || dmxOffset < 1 || dmxOffset > 512) {
      flags.add('slotOutOfRange');
      continue;
    }
    out.push({ dmxBreak, dmxOffset });
  }
  return out;
}

/**
 * Walk a geometry subtree collecting GeometryReference instances (including nested 2D arrays like
 * Wall -> Row -> Pixel) with cycle detection and strict expansion/work caps.
 */
function collectGeometryRefs(
  node: XmlNode,
  topGeos: Map<string, XmlNode>,
  parentBreaks: RefBreak[] | undefined,
  ancestors: Set<string>,
  out: ResolvedRef[],
  flags: Set<string>,
  ops: { remaining: number },
  depth = 0,
): void {
  if (depth > MAX_XML_DEPTH || out.length >= MAX_GEOMETRY_REFS || ops.remaining <= 0) {
    if (out.length >= MAX_GEOMETRY_REFS || ops.remaining <= 0) flags.add('refLimitExceeded');
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_') || !value || typeof value !== 'object') continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (!item || typeof item !== 'object') continue;
      if (--ops.remaining <= 0) {
        flags.add('refLimitExceeded');
        return;
      }
      const childNode = item as XmlNode;
      if (key === 'GeometryReference') {
        const target = attr(childNode, 'Geometry');
        if (!target) continue;
        if (ancestors.has(target)) {
          flags.add('cyclicReference');
          continue;
        }
        const ownBreaks = parseRefBreaks(childNode, flags);
        let effectiveBreaks: RefBreak[];
        if (!parentBreaks) {
          effectiveBreaks = ownBreaks;
        } else {
          // Compose nested GeometryReference offsets: (parentOffset - 1) + ownOffset on parent's break.
          effectiveBreaks = [];
          for (const pb of parentBreaks) {
            const match = ownBreaks.find((ob) => ob.dmxBreak === pb.dmxBreak) ?? ownBreaks[0];
            if (!match) continue;
            effectiveBreaks.push({ dmxBreak: pb.dmxBreak, dmxOffset: pb.dmxOffset + match.dmxOffset - 1 });
          }
        }
        if (out.length >= MAX_GEOMETRY_REFS) {
          flags.add('refLimitExceeded');
          return;
        }
        out.push({ target, breaks: effectiveBreaks });
        const targetNode = topGeos.get(target);
        if (targetNode) {
          ancestors.add(target);
          collectGeometryRefs(targetNode, topGeos, effectiveBreaks, ancestors, out, flags, ops, depth + 1);
          ancestors.delete(target);
        }
      } else {
        collectGeometryRefs(childNode, topGeos, parentBreaks, ancestors, out, flags, ops, depth + 1);
      }
    }
  }
}

/** Read the fixture type, modes (with per-break and multi-instance GeometryReference footprints) and optics of a GDTF archive. */
export function readGdtf(bytes: Uint8Array, budget?: GdtfReadBudget): GdtfSummary {
  const maxInflated = budget ? Math.min(MAX_XML_BYTES, Math.max(0, budget.remaining)) : MAX_XML_BYTES;
  const files = readArchive(bytes, 'GDTF', {
    only: (baseNameLower) => baseNameLower === 'description.xml',
    maxInflated,
  });
  const description = files.get('description.xml');
  if (!description) throw new Error('The GDTF archive needs a root description.xml.');
  if (budget) budget.remaining = Math.max(0, budget.remaining - description.data.byteLength);
  const doc = parseXml(utf8.decode(description.data));
  const fixture = child(child(doc, 'GDTF'), 'FixtureType');
  if (!fixture) throw new Error('Invalid GDTF fixture description.');

  // Index top-level geometries under <Geometries> by @Name so GeometryReference targets resolve cleanly.
  const topGeos = new Map<string, XmlNode>();
  const geometriesNode = child(fixture, 'Geometries') ?? {};
  for (const [key, value] of Object.entries(geometriesNode)) {
    if (key.startsWith('@_') || !value || typeof value !== 'object') continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (!item || typeof item !== 'object') continue;
      const gName = attr(item, 'Name');
      if (gName && !topGeos.has(gName)) topGeos.set(gName, item as XmlNode);
    }
  }

  const subtreeCache = new Map<string, Set<string>>();
  const getSubtreeNames = (geoName: string): Set<string> => {
    let set = subtreeCache.get(geoName);
    if (!set) {
      set = new Set<string>();
      const node = topGeos.get(geoName);
      if (node) collectSubtreeNames(node, set);
      subtreeCache.set(geoName, set);
    }
    return set;
  };

  // Share a single ops budget across all DMXModes (and across GDTF files when caller passes budget.opsRemaining),
  // and cache GeometryReference resolution per root geometry so repeated modes never re-walk the tree.
  const ops = { remaining: budget?.opsRemaining ?? MAX_REF_TEMPLATE_OPS };
  const rootRefCache = new Map<string, {
    refsByTarget: Map<string, ResolvedRef[]>;
    templateOwner: Map<string, string[]>;
    flags: string[];
  }>();
  const getRootRefs = (rootName: string | undefined) => {
    const cacheKey = rootName ?? '';
    const cached = rootRefCache.get(cacheKey);
    if (cached) return cached;
    const refFlags = new Set<string>();
    const rootNode = (rootName ? topGeos.get(rootName) : undefined) ?? topGeos.values().next().value;
    const refs: ResolvedRef[] = [];
    if (rootNode) {
      const ancestors = new Set<string>();
      if (rootName) ancestors.add(rootName);
      collectGeometryRefs(rootNode, topGeos, undefined, ancestors, refs, refFlags, ops);
    }
    const refsByTarget = new Map<string, ResolvedRef[]>();
    const templateOwner = new Map<string, string[]>();
    for (const ref of refs) {
      let bucket = refsByTarget.get(ref.target);
      if (!bucket) {
        bucket = [];
        refsByTarget.set(ref.target, bucket);
        for (const subName of getSubtreeNames(ref.target)) {
          const owners = templateOwner.get(subName);
          if (owners) owners.push(ref.target);
          else templateOwner.set(subName, [ref.target]);
        }
      }
      bucket.push(ref);
    }
    const entry = { refsByTarget, templateOwner, flags: [...refFlags] };
    rootRefCache.set(cacheKey, entry);
    return entry;
  };

  const modes: GdtfModeSummary[] = list(child(fixture, 'DMXModes'), 'DMXMode').map((mode) => {
    const rootResolved = getRootRefs(attr(mode, 'Geometry'));
    const flags = new Set<string>(rootResolved.flags);
    const perBreak = new Map<number, number>();
    const attributes: string[] = [];
    const functions: GdtfChannelFunction[] = [];
    const { refsByTarget, templateOwner } = rootResolved;

    for (const channel of list(child(mode, 'DMXChannels'), 'DMXChannel')) {
      // Slots come from Offset ("1" or "1,2" for 16-bit), never from document order.
      // Empty or "None" denotes a virtual channel (attributes only, no DMX slots).
      const rawOffsetAttr = (attr(channel, 'Offset') ?? '').trim();
      const offsets: number[] = [];
      if (rawOffsetAttr && rawOffsetAttr.toLowerCase() !== 'none') {
        const rawOffsets = rawOffsetAttr.split(',');
        for (let i = 0; i < rawOffsets.length && i < 512; i++) {
          const n = Number(rawOffsets[i].trim());
          if (Number.isInteger(n) && n > 0 && n <= 512) offsets.push(n);
        }
      }

      const rawBreakAttr = (attr(channel, 'DMXBreak') ?? '').trim();
      let channelBreak: number | 'Overwrite' | undefined;
      if (!rawBreakAttr) {
        channelBreak = 1;
      } else if (rawBreakAttr === 'Overwrite') {
        channelBreak = 'Overwrite';
      } else {
        const parsedBreak = Number(rawBreakAttr);
        if (Number.isInteger(parsedBreak) && parsedBreak >= 1 && parsedBreak <= MAX_DMX_BREAK) {
          channelBreak = parsedBreak;
        } else {
          flags.add('invalidBreak');
        }
      }

      const channelBytes = Math.max(1, Math.min(4, offsets.length || 1));
      const maxDmx = Math.pow(256, channelBytes) - 1;
      for (const logical of list(channel, 'LogicalChannel')) {
        const attrName = attr(logical, 'Attribute');
        if (attrName) attributes.push(attrName);
        const rawFns = list(logical, 'ChannelFunction');
        if (rawFns.length) {
          const parsedFns: GdtfChannelFunction[] = [];
          for (const fn of rawFns) {
            const fnAttr = attr(fn, 'Attribute') ?? attrName ?? '';
            const dmxFrom = parseGdtfDmxValue(attr(fn, 'DMXFrom'), channelBytes) ?? 0;
            const rawFrom = Number(attr(fn, 'PhysicalFrom'));
            const rawTo = Number(attr(fn, 'PhysicalTo'));
            parsedFns.push({
              name: attr(fn, 'Name') ?? fnAttr,
              attribute: fnAttr,
              dmxFrom,
              dmxTo: maxDmx,
              bytes: channelBytes,
              physicalFrom: Number.isFinite(rawFrom) ? rawFrom : 0,
              physicalTo: Number.isFinite(rawTo) ? rawTo : 1,
            });
          }
          parsedFns.sort((a, b) => a.dmxFrom - b.dmxFrom);
          for (let i = 0; i < parsedFns.length; i++) {
            if (i + 1 < parsedFns.length) {
              parsedFns[i].dmxTo = Math.max(parsedFns[i].dmxFrom, parsedFns[i + 1].dmxFrom - 1);
            } else {
              parsedFns[i].dmxTo = maxDmx;
            }
          }
          functions.push(...parsedFns);
        }
      }

      if (!offsets.length || channelBreak === undefined) continue;

      const geoName = attr(channel, 'Geometry') ?? '';
      const owners = geoName ? templateOwner.get(geoName) : undefined;
      if (owners?.length) {
        // Dedupe & sort offsets once per channel so each GeometryReference instance is O(1) (or O(log k) on overflow).
        const sortedOffsets = [...new Set(offsets)].sort((a, b) => a - b);
        const maxOff = sortedOffsets[sortedOffsets.length - 1];
        for (const target of owners) {
          const instances = refsByTarget.get(target) ?? [];
          for (const instance of instances) {
            if (--ops.remaining < 0) {
              flags.add('refLimitExceeded');
              break;
            }
            const brk = channelBreak === 'Overwrite'
              ? instance.breaks[0]
              : instance.breaks.find((b) => b.dmxBreak === channelBreak);
            if (!brk) {
              flags.add('missingBreak');
              continue;
            }
            const maxSlot = maxOff + brk.dmxOffset - 1;
            if (maxSlot <= 512) {
              const prev = perBreak.get(brk.dmxBreak) ?? 0;
              if (maxSlot > prev) perBreak.set(brk.dmxBreak, maxSlot);
            } else {
              flags.add('slotOutOfRange');
              const limitOff = 513 - brk.dmxOffset;
              // Binary search for the largest offset <= limitOff.
              let lo = 0, hi = sortedOffsets.length - 1, best = -1;
              while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (sortedOffsets[mid] <= limitOff) { best = sortedOffsets[mid]; lo = mid + 1; }
                else hi = mid - 1;
              }
              if (best > 0) {
                const slot = best + brk.dmxOffset - 1;
                const prev = perBreak.get(brk.dmxBreak) ?? 0;
                if (slot > prev) perBreak.set(brk.dmxBreak, slot);
              }
            }
          }
        }
      } else {
        if (channelBreak === 'Overwrite') {
          flags.add('invalidBreak');
          continue;
        }
        let maxOff = 0;
        for (const off of offsets) if (off > maxOff) maxOff = off;
        const prev = perBreak.get(channelBreak) ?? 0;
        if (maxOff > prev) perBreak.set(channelBreak, maxOff);
      }
    }

    const breaks: GdtfModeBreak[] = [...perBreak.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([dmxBreak, footprint]) => ({ dmxBreak, footprint }));
    const totalSlots = breaks.reduce((sum, b) => sum + b.footprint, 0);
    const footprint = perBreak.get(1) ?? breaks[0]?.footprint ?? 0;

    return {
      name: attr(mode, 'Name') ?? '',
      footprint,
      breaks,
      totalSlots,
      attributes,
      ...(functions.length ? { functions } : {}),
      ...(flags.size ? { flags: [...flags].sort() } : {}),
    };
  });
  if (budget && budget.opsRemaining !== undefined) budget.opsRemaining = Math.max(0, ops.remaining);

  let beamType: string | undefined, beamAngle: number | undefined, hasLaser = false;
  const visit = (node: XmlNode, depth = 0) => {
    if (depth > MAX_XML_DEPTH) return;
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith('@_') || !value || typeof value !== 'object') continue;
      for (const item of Array.isArray(value) ? value : [value]) {
        if (key === 'Laser') hasLaser = true;
        if (key === 'Beam' && beamType === undefined) {
          beamType = attr(item, 'BeamType') ?? 'Wash';
          const angle = Number(attr(item, 'BeamAngle'));
          if (Number.isFinite(angle)) beamAngle = angle;
        }
        if (item && typeof item === 'object') visit(item as XmlNode, depth + 1);
      }
    }
  };
  visit(geometriesNode);

  const emitters: GdtfEmitterColor[] = [];
  for (const emitter of list(child(child(fixture, 'PhysicalDescriptions'), 'Emitters'), 'Emitter').slice(0, 64)) {
    const rawColor = attr(emitter, 'Color');
    if (!rawColor) continue;
    try {
      const color = parseCieXyY(rawColor);
      emitters.push({ name: attr(emitter, 'Name') ?? 'Emitter', color, srgb: cieXyYToSrgb(color) });
    } catch {
      // Ignore malformed emitter colours.
    }
  }

  return {
    name: attr(fixture, 'Name') ?? 'Fixture', manufacturer: attr(fixture, 'Manufacturer') ?? '',
    modes, beamType, beamAngle, hasLaser,
    ...(emitters.length ? { emitters } : {}),
  };
}

/** Best StageForge hardware type for a third-party GDTF mode. */
export function classifyGdtf(summary: GdtfSummary, modeName: string | undefined, standing: boolean): Hardware {
  const mode = summary.modes.find((m) => m.name === modeName) ?? summary.modes[0];
  const attrs = new Set((mode?.attributes ?? []).map((a) => a.toLowerCase()));
  const text = `${summary.manufacturer} ${summary.name}`.toLowerCase();
  if (summary.hasLaser || /laser/.test(text)) return standing ? 'floor_laser' : 'laser';
  if ([...attrs].some((a) => a.startsWith('haze')) || /haze/.test(text)) return 'hazer';
  if (/co2|cryo/.test(text)) return 'co2';
  if ([...attrs].some((a) => a.startsWith('fog')) || /smoke|fog/.test(text)) return 'smoke';
  if (attrs.has('pan') || attrs.has('tilt')) {
    if (standing) return 'floor_beam';
    const wash = summary.beamType === 'Wash' || summary.beamType === 'PC' || summary.beamType === 'Fresnel' || (summary.beamAngle ?? 0) > 15;
    return wash ? 'wash' : 'beam';
  }
  const hasColor = [...attrs].some((a) => a.startsWith('color'));
  if (/strobe/.test(text) || (!hasColor && [...attrs].some((a) => a.includes('strobe')))) return 'strobe';
  return 'blinder';
}
