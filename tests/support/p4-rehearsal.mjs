import { p2Rehearsal } from './p2-rehearsal.mjs';

export function p4Rehearsal({ stock = false, sibling = false } = {}) {
  const show = p2Rehearsal();
  const pod = show.rig.trussPods[0];
  const generic = {
    id: 'preview-blinders', type: 'blinder', modelName: 'Preview blinders', count: 2,
    dmxUniverse: 3, dmxStartChannel: 1, ...(stock ? {} : { dmxChannels: 1 }),
  };
  show.rig = {
    ...show.rig, name: stock ? 'P4 stock control' : 'P4 external levels rehearsal',
    trussPods: [
      { ...pod, name: 'Preview truss', shape: 'box', x: 0, z: 0, width: 7, baseY: 4.6, rotationY: 0,
        motorized: false, fixtures: [generic, ...(sibling ? [{
          id: 'desk-blinders', type: 'blinder', modelName: 'Desk sibling', count: 1, dmxUniverse: 4, dmxStartChannel: 1,
        }] : [])] },
      { ...pod, id: 'controls', name: 'Control truss', shape: 'box', width: 7, x: 0, z: -3,
        baseY: 7.5, rotationY: 0, motorized: false, fixtures: pod.fixtures.slice(0, 2) },
    ],
    floorFx: [],
  };
  Object.assign(show.look, {
    masterDimmer: 1, blinderLevel: 0, bloomStrength: 0.35, audioReactive: false,
    atmo: { hazeLevel: 0, smokeOutput: 0, co2Active: false, co2AutoOnDrop: false },
  });
  show.cues = [
    { id: 'parked', name: 'Parked', state: { blinderLevel: 0 }, accent: '#ffffff', tag: 'SHOW' },
    { id: 'warm', name: 'Desk full', state: { blinderLevel: 1 }, accent: '#ffffff', tag: 'SHOW' },
  ];
  show.activeCueId = 'parked';
  return show;
}

export const P4_CAMERA = [[0, 4.6, 11], [0, 4.1, 0.15]];
