import type { FixtureType, FloorFxType } from '../../types/show';
import { readArchive, utf8, writeArchive } from './archive';
import { attr, buildXml, child, list, parseXml, type XmlNode } from './xml';
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

export function profileFor(type: Hardware): Profile {
  return PROFILES[type];
}

/** description.xml for a generic profile (validated against the official GDTF 1.2 XSD in development). */
export function profileDescription(profile: Profile): string {
  const attributes = [...new Set(profile.channels.flatMap((c) => [c.attribute, ...(c.functions?.map((f) => f.attribute) ?? [])]))];
  const needsShutter = attributes.includes('Shutter1Strobe') && !attributes.includes('Shutter1');
  if (needsShutter) attributes.push('Shutter1');
  const features = new Map<string, Set<string>>();
  const activations = new Set<string>();
  for (const name of attributes) {
    const meta = FEATURES[name];
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
            const meta = FEATURES[name];
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

/** What the importer needs from a GDTF file. */
export interface GdtfSummary {
  name: string;
  manufacturer: string;
  modes: Array<{ name: string; footprint: number; attributes: string[] }>;
  beamType?: string;
  beamAngle?: number;
  hasLaser: boolean;
}

/** Read the fixture type, modes (footprint from the highest Offset) and beam of a GDTF archive. */
export function readGdtf(bytes: Uint8Array): GdtfSummary {
  const files = readArchive(bytes, 'GDTF');
  const description = files.get('description.xml');
  if (!description) throw new Error('The GDTF archive needs a root description.xml.');
  const doc = parseXml(utf8.decode(description.data));
  const fixture = child(child(doc, 'GDTF'), 'FixtureType');
  if (!fixture) throw new Error('Invalid GDTF fixture description.');
  const modes = list(child(fixture, 'DMXModes'), 'DMXMode').map((mode) => {
    let footprint = 0;
    const attributes: string[] = [];
    for (const channel of list(child(mode, 'DMXChannels'), 'DMXChannel')) {
      // Slots come from Offset ("1" or "1,2" for 16-bit), never from document order.
      const offsets = (attr(channel, 'Offset') ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
      footprint = Math.max(footprint, ...offsets, 0);
      for (const logical of list(channel, 'LogicalChannel')) {
        const name = attr(logical, 'Attribute');
        if (name) attributes.push(name);
      }
    }
    return { name: attr(mode, 'Name') ?? '', footprint, attributes };
  });
  let beamType: string | undefined, beamAngle: number | undefined, hasLaser = false;
  const visit = (node: XmlNode) => {
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith('@_') || !value || typeof value !== 'object') continue;
      for (const item of Array.isArray(value) ? value : [value]) {
        if (key === 'Laser') hasLaser = true;
        if (key === 'Beam' && beamType === undefined) {
          beamType = attr(item, 'BeamType') ?? 'Wash';
          const angle = Number(attr(item, 'BeamAngle'));
          if (Number.isFinite(angle)) beamAngle = angle;
        }
        if (item && typeof item === 'object') visit(item as XmlNode);
      }
    }
  };
  visit(child(fixture, 'Geometries') ?? {});
  return {
    name: attr(fixture, 'Name') ?? 'Fixture', manufacturer: attr(fixture, 'Manufacturer') ?? '',
    modes, beamType, beamAngle, hasLaser,
  };
}

/** Best StageForge hardware type for a third-party GDTF mode. */
export function classifyGdtf(summary: GdtfSummary, modeName: string | undefined, standing: boolean): Hardware {
  const mode = summary.modes.find((m) => m.name === modeName) ?? summary.modes[0];
  const attrs = new Set((mode?.attributes ?? []).map((a) => a.toLowerCase()));
  const text = `${summary.manufacturer} ${summary.name}`.toLowerCase();
  if (summary.hasLaser || /laser/.test(text)) return standing ? 'floor_laser' : 'laser';
  if (/haze/.test(text)) return 'hazer';
  if (/co2|cryo/.test(text)) return 'co2';
  if (/smoke|fog/.test(text) || [...attrs].some((a) => a.startsWith('fog'))) return 'smoke';
  if (attrs.has('pan') || attrs.has('tilt')) {
    if (standing) return 'floor_beam';
    const wash = summary.beamType === 'Wash' || summary.beamType === 'PC' || summary.beamType === 'Fresnel' || (summary.beamAngle ?? 0) > 15;
    return wash ? 'wash' : 'beam';
  }
  if (/strobe/.test(text) || [...attrs].some((a) => a.includes('strobe'))) return 'strobe';
  return 'blinder';
}
