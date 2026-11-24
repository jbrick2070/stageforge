import type { NativeStage } from '../../data/showFile';
import type { PlanPoint, RigConfig, TrussPodConfig } from '../../types/show';
import { getPlatforms, stageSurfaceHeight } from '../../data/stageDesign';
import { resolveStudioGeometry } from '../../data/studioGeometry';
import { effectiveHangs, planWalls } from '../../data/stagePlan';
import { placeFixtures, type FixturePlacement } from '../../data/fixturePlacement';
import { focusMarks } from '../../engine/focusAim';
import { writeArchive, utf8, type ArchiveEntry } from './archive';
import { IDENTITY, matrixText, poseMatrix, toMvrPoint, type MvrMatrix } from './coords';
import { MODE_NAME, profileArchive, profileFor } from './gdtf';
import { boxGlb } from './glb';
import { uuidV5 } from './uuid';
import { buildXml, type XmlNode } from './xml';

/**
 * Lossless re-import: the full StageForge rig and stage travel as an extra root file in the
 * archive, flagged by an empty provider marker in UserData. (MVR 1.6's XSD gives UserData/Data
 * an empty content model, so keeping the payload out of the XML keeps the scene strictly valid.)
 */
export const PAYLOAD_PROVIDER = 'StageForge';
export const PAYLOAD_FILE = 'StageForge_show.json';

export interface MvrPayload {
  format: 'stageforge-mvr';
  version: 1;
  rig: RigConfig;
  stage?: NativeStage;
}

/** StageForge's deterministic object UUID for a key, upper case as MVR files write it. */
export const stageforgeUuid = (name: string) => uuidV5(name).toUpperCase();
const id = stageforgeUuid;

/** UUID key of a fixture unit; JSON keeps IDs containing ':' from colliding. */
export const fixtureKey = (unit: Pick<FixturePlacement, 'podId' | 'group' | 'index'>) =>
  'fixture:' + JSON.stringify(unit.podId !== undefined ? ['pod', unit.podId, unit.group.id, unit.index] : ['floor', unit.group.id, unit.index]);
const RAD = 180 / Math.PI;
const mm = (n: number) => Math.round(n * 1000);

const CLASSES = ['Lighting', 'Rigging', 'Video', 'Audio', 'Staging', 'Scenery', 'Focus'] as const;
type ClassName = (typeof CLASSES)[number];
const classUuid = (name: ClassName) => id(`class:${name}`);

/** Object fields in the XSD's sequence order for Truss, VideoScreen and SceneObject. */
function placed(name: string, uuid: string, matrix: MvrMatrix, cls: ClassName, geometries: XmlNode, fixtureId = '', numeric = 0): XmlNode {
  return {
    '@_uuid': uuid, '@_name': name,
    Matrix: matrixText(matrix),
    Classing: classUuid(cls),
    Geometries: geometries,
    FixtureID: fixtureId,
    FixtureIDNumeric: String(numeric),
  };
}

/** Straight spans of a truss in its local plan frame (rings become 16 chords). */
function spans(pod: TrussPodConfig): Array<[PlanPoint, PlanPoint]> {
  const r = pod.width / 2;
  const points: PlanPoint[] = pod.shape === 'path' ? pod.path ?? []
    : pod.shape === 'circle' ? Array.from({ length: 17 }, (_, i) => ({ x: r * Math.cos((i / 16) * 2 * Math.PI), z: r * Math.sin((i / 16) * 2 * Math.PI) }))
    : pod.shape === 'chevron' ? [{ x: -r, z: -r * Math.tan(0.36) }, { x: 0, z: 0 }, { x: r, z: -r * Math.tan(0.36) }]
    : [{ x: -r, z: 0 }, { x: r, z: 0 }];
  const out: Array<[PlanPoint, PlanPoint]> = [];
  for (let i = 1; i < points.length; i++) {
    if (Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z) > 0.001) out.push([points[i - 1], points[i]]);
  }
  return out;
}

export function exportMvr(sourceRig: RigConfig, stage?: NativeStage, providerVersion = '1'): Uint8Array {
  const { rig, props: layoutProps } = resolveStudioGeometry(sourceRig, stage?.layout);
  const files = new Map<string, Uint8Array>();
  const glb = (name: string, make: () => Uint8Array) => {
    if (!files.has(name)) files.set(name, make());
    return { Geometry3D: [{ '@_fileName': name }] };
  };
  const children: Record<'FocusPoint' | 'SceneObject' | 'Truss' | 'VideoScreen' | 'Fixture', XmlNode[]> = {
    FocusPoint: [], SceneObject: [], Truss: [], VideoScreen: [], Fixture: [],
  };

  for (const mark of focusMarks(rig)) {
    children.FocusPoint.push({
      '@_uuid': id(`focus:${mark.id}`), '@_name': mark.name,
      Matrix: matrixText(poseMatrix({ x: mark.x, y: mark.y, z: mark.z }, 0)),
      Classing: classUuid('Focus'),
      Geometries: '',
    });
  }

  for (const deck of getPlatforms(rig)) {
    const file = `deck-${mm(deck.width)}x${mm(deck.depth)}x${mm(deck.height)}.glb`;
    children.SceneObject.push(placed(deck.name, id(`deck:${deck.id}`), poseMatrix({ x: deck.x, y: 0, z: deck.z }, 0), 'Staging',
      glb(file, () => boxGlb(deck.width, deck.height, deck.depth, { base: true, color: [0.17, 0.32, 0.3] }))));
  }

  for (const prop of rig.props ?? []) {
    const size = 1.5 * prop.scale, tall = 2.2 * prop.scale;
    const file = `scenery-${prop.kind}-${mm(size)}.glb`;
    const y = stageSurfaceHeight(rig, prop.x, prop.z);
    children.SceneObject.push(placed(`Scenery ${prop.kind}`, id(`scenery:${prop.id}`), poseMatrix({ x: prop.x, y, z: prop.z }, prop.rotation), 'Scenery',
      glb(file, () => boxGlb(size, tall, size, { base: true, color: [0.6, 0.5, 0.75] }))));
  }
  layoutProps.forEach((prop, i) => {
    const file = `prop-${prop.type}-${mm(prop.height)}.glb`;
    const y = stageSurfaceHeight(rig, prop.x, prop.z);
    children.SceneObject.push(placed(`${prop.type === 'inflatable' ? 'Inflatable' : 'Scenic'} prop ${i + 1}`, id(`prop:${i}`),
      poseMatrix({ x: prop.x, y, z: prop.z }, 0), 'Scenery',
      glb(file, () => boxGlb(1, prop.height, 1, { base: true, color: [0.76, 0.6, 0.92] }))));
  });

  for (const [i, hang] of effectiveHangs(sourceRig, stage).hangs.entries()) {
    const height = hang.count * 0.42;
    const file = `pa-hang-${hang.count}.glb`;
    // The array hangs from its pick point; tilt and splay travel in the StageForge payload.
    children.SceneObject.push(placed(`PA hang ${i + 1} (${hang.count} boxes)`, id(`hang:${i}`),
      poseMatrix({ x: hang.x, y: hang.y - height / 2, z: hang.z }, hang.yaw), 'Audio',
      glb(file, () => boxGlb(1.34, height, 0.7, { color: [0.12, 0.12, 0.13] }))));
  }

  for (const pod of rig.trussPods) {
    const pieces = spans(pod).map(([a, b]) => {
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      const centre = toMvrPoint({ x: (a.x + b.x) / 2, y: 0, z: (a.z + b.z) / 2 });
      const local: MvrMatrix = { ...poseMatrix({ x: 0, y: 0, z: 0 }, -Math.atan2(b.z - a.z, b.x - a.x) * RAD), o: centre };
      const file = `truss-${mm(length)}.glb`;
      if (!files.has(file)) files.set(file, boxGlb(length, 0.3, 0.3, { color: [0.75, 0.77, 0.8] }));
      return { '@_fileName': file, Matrix: matrixText(local) };
    });
    children.Truss.push(placed(pod.name, id(`truss:${pod.id}`), poseMatrix({ x: pod.x, y: pod.baseY, z: pod.z }, pod.rotationY * RAD),
      'Rigging', { Geometry3D: pieces }));
  }

  for (const { wall, frame, primary } of planWalls(rig, stage)) {
    const file = `screen-${mm(frame.width)}x${mm(frame.height)}.glb`;
    children.VideoScreen.push(placed(wall.label ?? (primary ? 'Main LED wall' : wall.id), id(`wall:${wall.id}`),
      poseMatrix({ x: frame.x, y: frame.y, z: frame.z }, frame.yaw), 'Video',
      glb(file, () => boxGlb(frame.width, frame.height, 0.12, { color: [0.05, 0.08, 0.12] }))));
  }

  const used = new Set<string>();
  placeFixtures(rig).forEach((unit, n) => {
    const profile = profileFor(unit.group.type);
    used.add(unit.group.type);
    const fixtureId = String(n + 1);
    children.Fixture.push({
      '@_uuid': id(fixtureKey(unit)),
      '@_name': `${unit.group.modelName} ${unit.index + 1}`,
      Matrix: matrixText(poseMatrix(unit.position, unit.yaw * RAD, unit.floor)),
      Classing: classUuid('Lighting'),
      GDTFSpec: profile.file,
      GDTFMode: MODE_NAME,
      FixtureID: fixtureId,
      FixtureIDNumeric: fixtureId,
      UnitNumber: String(unit.index + 1),
      // Absolute address: (universe − 1) × 512 + channel. Unpatched units carry no address.
      ...(unit.patched ? { Addresses: { Address: [{ '@_break': '0', '#text': String((unit.universe - 1) * 512 + unit.address) }] } } : {}),
      CustomIdType: '1',
      CustomId: fixtureId,
    });
  });
  for (const type of used) {
    const profile = profileFor(type as Parameters<typeof profileFor>[0]);
    if (!files.has(profile.file)) files.set(profile.file, profileArchive(profile));
  }

  const payload: MvrPayload = { format: 'stageforge-mvr', version: 1, rig: sourceRig, ...(stage ? { stage } : {}) };
  const xml = buildXml({
    GeneralSceneDescription: {
      '@_verMajor': '1', '@_verMinor': '6', '@_provider': 'StageForge', '@_providerVersion': providerVersion,
      UserData: { Data: [{ '@_provider': PAYLOAD_PROVIDER, '@_ver': '1' }] },
      Scene: {
        AUXData: { Class: CLASSES.map((name) => ({ '@_uuid': classUuid(name), '@_name': name })) },
        Layers: { Layer: [{ '@_uuid': id('layer:stageforge'), '@_name': sourceRig.name || 'StageForge',
          Matrix: matrixText(IDENTITY), ChildList: children }] },
      },
    },
  });
  const entries: ArchiveEntry[] = [
    { name: 'GeneralSceneDescription.xml', data: utf8.encode(xml) },
    { name: PAYLOAD_FILE, data: utf8.encode(JSON.stringify(payload)) },
  ];
  for (const [name, data] of files) entries.push({ name, data });
  return writeArchive(entries);
}
