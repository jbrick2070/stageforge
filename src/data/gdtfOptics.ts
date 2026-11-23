import { unzipSync, strFromU8 } from 'fflate';
import type { BeamProfile } from '../types/show';
import { MAX_ANGLE, MAX_LUMENS, MIN_ANGLE } from './fixtureOptics';

/** Import only the optics of a chosen physical emitter, independent of its DMX mode. */
export async function readGdtfOptics(file: File): Promise<BeamProfile[]> {
  if (file.size > 128 * 1024 * 1024) throw new Error('Choose a GDTF file smaller than 128 MB.');
  let xml: Uint8Array | undefined;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    xml = unzipSync(bytes, { filter(entry) {
      if (entry.name !== 'description.xml') return false;
      if (entry.originalSize > 8 * 1024 * 1024) throw new Error('Description exceeds 8 MB.');
      return true;
    } })['description.xml'];
  } catch {
    throw new Error('Cannot read this GDTF archive. Its description must fit within 8 MB.');
  }
  if (!xml) throw new Error('The GDTF archive needs a root description.xml.');
  const source = strFromU8(xml);
  if (/<!DOCTYPE/i.test(source)) throw new Error('GDTF descriptions with a DTD are unsupported.');
  const doc = new DOMParser().parseFromString(source, 'application/xml');
  const fixture = doc.querySelector('GDTF > FixtureType');
  if (!fixture || doc.querySelector('parsererror')) throw new Error('Invalid GDTF fixture description.');
  const fixtureName = fixture.getAttribute('Name')?.trim();
  const manufacturer = fixture.getAttribute('Manufacturer')?.trim();
  if (!fixtureName || !manufacturer || [...fixtureName].length > 512 || [...manufacturer].length > 512)
    throw new Error('The GDTF fixture needs a name and manufacturer of up to 512 characters each.');
  const profiles: BeamProfile[] = [];
  for (const beam of fixture.querySelectorAll(':scope > Geometries Beam')) {
    // Object definitions can describe lamps, pixels and projection surfaces too.
    const type = beam.getAttribute('BeamType') ?? 'Wash';
    if (!['Wash', 'Spot', 'PC', 'Fresnel'].includes(type)) continue;
    const geometry = beam.getAttribute('Name')?.trim();
    if (!geometry || [...geometry].length > 512) continue;
    const read = (key: string, min: number, max: number) => {
      const raw = beam.getAttribute(key)?.trim();
      if (!raw) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
    };
    const lumens = read('LuminousFlux', 0, MAX_LUMENS);
    const beamAngle = read('BeamAngle', MIN_ANGLE, MAX_ANGLE);
    if (lumens !== undefined || beamAngle !== undefined)
      profiles.push({ manufacturer, fixture: fixtureName, geometry, lumens, beamAngle });
  }
  if (!profiles.length) throw new Error('No supported beam with a declared luminous flux or beam angle.');
  return profiles;
}
