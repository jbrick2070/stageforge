import { readFile } from 'node:fs/promises';

const template = JSON.parse(await readFile(new URL('../../public/examples/amber-walk-on.stageforge.show.json', import.meta.url), 'utf8'));
export const schema = (version) => `https://jbrick2070.github.io/stageforge/schemas/show-v${version}.schema.json`;

export function p2Rehearsal() {
  const show = structuredClone(template);
  show.version = 15;
  show.$schema = schema(15);
  const pod = show.rig.trussPods[0];
  const wash = (id, universe) => ({
    id, modelName: id, type: 'wash', count: 1, dmxUniverse: universe, dmxStartChannel: 1,
    catalogId: 'etc-colorsource-par', dmxMode: 'RGB (3-Ch)', dmxChannels: 3,
  });
  const haze = (id, universe, start) => ({
    id, modelName: id, type: 'hazer', count: 1, dmxChannels: 1, dmxUniverse: universe, dmxStartChannel: start,
    x: 0, z: -1, spread: 0,
  });
  show.rig = {
    ...show.rig, name: 'Three universe rehearsal', trussPods: [{
      ...pod, id: 'LX', name: 'Main truss', fixtures: [wash('Wash One', 1), wash('Wash Two', 2), {
        id: 'wide-reserve', modelName: 'Sharpy Vector', type: 'beam', count: 2,
        dmxUniverse: 3, dmxStartChannel: 1, dmxChannels: 20,
      }],
    }],
    floorFx: [haze('Deck Hazer', 3, 101), haze('Last Hazer', 16, 512)],
    ledWall: { ...show.rig.ledWall, enabled: false },
    audioRig: { ...show.rig.audioRig, crowdDensity: 0 },
  };
  Object.assign(show.look, {
    autoDirector: false, audioReactive: false, blackout: false, masterDimmer: 0.8, washIntensity: 0.65, beamIntensity: 0.7,
    manualPan: 0, manualTilt: 0, movementMode: 'manual', focusMarkId: null, strobeRate: 0,
    primaryColor: '#ff0000', accentColor: '#00ffff', colorSplitMode: 'alternate',
    motors: { mode: 'high', speed: 0.25, podTargets: {} },
    atmo: { hazeLevel: 0.62, smokeOutput: 0, co2Active: false, co2AutoOnDrop: false },
  });
  show.cues = [{ id: 'steady', name: 'Steady', state: { beamIntensity: 0.7 }, accent: '#ffffff', tag: 'SHOW' }];
  show.activeCueId = 'steady';
  delete show.timeline;
  delete show.media;
  return show;
}
