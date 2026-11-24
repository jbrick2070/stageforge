import { DxfWriter, LWPolylineFlags, Units, point2d, point3d } from '@tarikjabiri/dxf';
import type { DxfBlock, ExtendedData } from '@tarikjabiri/dxf';
import type { FixtureType, FloorFxType, PlanPoint, RigConfig, StagePropKind, TrussPodConfig } from '../types/show';
import { buildDmxPatch } from './dmxPatch';
import { getPlatforms, podWorldPoint, stageSurfaceHeight } from './stageDesign';
import { PROP_CATALOG } from './stageProps';
import { placeFixtures } from './fixturePlacement';
import { bodyFamilyFor, symbolForHardware } from './equipmentSymbols';
import type { NativeStage } from './showFile';
import { authoredWallFrames, resolveStudioGeometry } from './studioGeometry';

type Equipment = FixtureType | FloorFxType;
type ShapeWriter = Pick<DxfWriter, 'addLWPolyline' | 'addLine' | 'addCircle'>;
const degrees = 180 / Math.PI;

// StageForge uses Y up, Z downstage. CAD model space uses Z up, Y upstage.
function cad(p: PlanPoint, elevation: number) {
  return point3d(p.x, -p.z, elevation);
}
function labelText(value: string) {
  // Keep the ASCII exchange stream intact, including for Unicode names and pasted newlines.
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/[\\%\u0080-\uffff]/g, ch =>
    '\\U+' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));
}
function addProperty(data: ExtendedData, value: string) {
  // Writer 2.10.1 discards each chunk's final character. Supply a terminator for
  // each 255-byte DXF group so the full original ASCII value survives round-trip.
  const encoded = labelText(value);
  for (let i = 0; i < Math.max(encoded.length, 1); i += 255) {
    data.string(encoded.slice(i, i + 255) + ' ');
  }
}
function outline(writer: ShapeWriter, points: PlanPoint[], elevation: number, layerName: string, closed: boolean) {
  writer.addLWPolyline(points.map(p => ({ point: point2d(p.x, -p.z) })), {
    layerName, elevation, flags: closed ? LWPolylineFlags.Closed : LWPolylineFlags.None,
  });
}
function rectangle(x: number, z: number, width: number, depth: number): PlanPoint[] {
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => ({ x: x+a*width/2, z: z+b*depth/2 }));
}
function centerLine(pod: TrussPodConfig): PlanPoint[] {
  if (pod.shape === 'path') return pod.path ?? [];
  const half = pod.width / 2;
  if (pod.shape === 'chevron') {
    const endZ = -half * Math.tan(0.36);
    return [{ x: -half, z: endZ }, { x: 0, z: 0 }, { x: half, z: endZ }];
  }
  return [{ x: -half, z: 0 }, { x: half, z: 0 }];
}

// Drafting symbols come from equipmentSymbols (same silhouettes as 3D models, 2D plan and picker).
function fixtureSymbol(block: DxfBlock, type: Equipment, catalogId?: string) {
  const symbol = symbolForHardware(type, catalogId);
  for (const spec of symbol.plan) {
    if (spec.kind === 'circle') {
      block.addCircle(point3d(spec.cx, -spec.cy, 0), spec.r);
    } else if (spec.kind === 'rect') {
      const pts: PlanPoint[] = [
        { x: spec.x, z: spec.y },
        { x: spec.x + spec.w, z: spec.y },
        { x: spec.x + spec.w, z: spec.y + spec.h },
        { x: spec.x, z: spec.y + spec.h },
      ];
      outline(block, pts, 0, '0', true);
    } else if (spec.pts.length >= 2) {
      if (spec.pts.length === 2 && !spec.closed) {
        block.addLine(point3d(spec.pts[0][0], -spec.pts[0][1], 0), point3d(spec.pts[1][0], -spec.pts[1][1], 0));
      } else {
        outline(block, spec.pts.map(([x, z]) => ({ x, z })), 0, '0', spec.closed);
      }
    }
  }
}

// Installed support footprints from the scenic models, in local metres.
function propSymbol(block: DxfBlock, kind: StagePropKind) {
  const foot = (x: number, width: number, depth: number, elevation=0) =>
    outline(block, rectangle(x,0,width,depth), elevation,'0',true);
  switch (kind) {
    case 'arch': foot(-3.5,1.3,1.3); foot(3.5,1.3,1.3); break;
    case 'star': foot(-1.12,0.48,0.36); foot(1.12,0.48,0.36); break;
    case 'tentacle': foot(0,1.85,1.85); break;
    case 'marquee': foot(0,1.45,1.05); break;
    case 'riser': foot(0,4,2.35,0.98); break;
  }
}

/** Editable R2010 model-space plan. All dimensions, block coordinates and elevations are metres. */
export function exportStageDxf(sourceRig: RigConfig, stage?: NativeStage): string {
  const { rig, hangs, props: authoredProps } = resolveStudioGeometry(sourceRig, stage?.layout);
  const drawing = new DxfWriter();
  drawing.setVariable('$ACADVER', { 1: 'AC1024' });
  drawing.setUnits(Units.Meters);
  drawing.setVariable('$MEASUREMENT', { 70: 1 });
  for (const [name, color] of [['DECKS',4],['TRUSSES',2],['FIXTURES',1],['PROPS',3],['LABELS',7],['PATCH_TAGS',-7]] as const) {
    drawing.addLayer(name, color, 'Continuous');
  }
  // Same frames StageEngine builds: every secondary wall plus a custom main-led (stock fallbacks filled in).
  const walls = authoredWallFrames(rig, stage);
  if (hangs?.length) drawing.addLayer('PA', 5, 'Continuous');
  if (walls.length) drawing.addLayer('VIDEO_WALLS', 6, 'Continuous');
  drawing.tables.addAppId('STAGEFORGE');
  const patch = buildDmxPatch(rig);
  const footprint = new Map(patch.rows.map(row => [row.group, row.width]));
  const defined = new Set<string>();
  let minX = 0, downstage = 0;
  function include(p: PlanPoint) {
    minX = Math.min(minX, p.x);
    downstage = Math.max(downstage, p.z);
  }
  function label(name: string, p: PlanPoint, elevation: number, size=0.19, layerName='LABELS') {
    drawing.addText(cad(p,elevation),size,labelText(name),{ layerName });
  }
  function fixture(group: RigConfig['floorFx'][number] | TrussPodConfig['fixtures'][number],
    i: number, p: PlanPoint, elevation: number, rotation: number) {
    const defaultFamily = bodyFamilyFor(group.type);
    const family = bodyFamilyFor(group.type, group.catalogId);
    const name = family === defaultFamily
      ? 'SF_' + group.type.toUpperCase()
      : 'SF_' + group.type.toUpperCase() + '_' + family.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    if (!defined.has(name)) { fixtureSymbol(drawing.addBlock(name), group.type, group.catalogId); defined.add(name); }
    const insert = drawing.addInsert(name,cad(p,elevation),{layerName:'FIXTURES',rotationAngle: rotation * degrees});
    const metadata = insert.addXData('STAGEFORGE');
    addProperty(metadata,group.modelName);
    addProperty(metadata,group.id);
    const address = group.dmxStartChannel + i * footprint.get(group)!;
    const patchLabel = `U${group.dmxUniverse}.${String(address).padStart(3,'0')}${patch.unitStart(group,i) ? '' : ' (invalid patch)'}`;
    addProperty(metadata,patchLabel);
    if (group.catalogId !== undefined) addProperty(metadata, group.catalogId);
    label(patchLabel,{x:p.x+0.18,z:p.z+0.1},elevation,0.13,'PATCH_TAGS');
    include(p);
  }

  for (const deck of getPlatforms(rig)) {
    const corners = rectangle(deck.x,deck.z,deck.width,deck.depth);
    outline(drawing,corners,deck.height,'DECKS',true);
    corners.forEach(include);
    label(deck.name,{x:corners[0].x+0.12,z:corners[0].z+0.30},deck.height);
  }
  for (const pod of rig.trussPods) {
    let labelAt: PlanPoint;
    if (pod.shape === 'circle') {
      drawing.addCircle(cad(pod,pod.baseY),pod.width/2,{layerName:'TRUSSES'});
      include({x:pod.x-pod.width/2,z:pod.z+pod.width/2});
      labelAt = {x:pod.x,z:pod.z-pod.width/2};
    } else {
      const points = centerLine(pod).map(p => podWorldPoint(pod,p));
      if (points.length < 2) continue;
      const first = points[0], last = points[points.length-1];
      const closed = points.length > 2 && Math.hypot(first.x-last.x,first.z-last.z)<0.0001;
      outline(drawing,closed ? points.slice(0,-1) : points,pod.baseY,'TRUSSES',closed);
      points.forEach(include);
      labelAt = first;
    }
    label(pod.name,{x:labelAt.x,z:labelAt.z-0.24},pod.baseY);
  }
  // Shared with the MVR export and StageEngine's mount distribution.
  for (const unit of placeFixtures(rig)) {
    fixture(unit.group,unit.index,{x:unit.position.x,z:unit.position.z},unit.position.y,unit.yaw);
  }
  for (const prop of rig.props ?? []) {
    const name = 'PROP_' + prop.kind.toUpperCase();
    if (!defined.has(name)) { propSymbol(drawing.addBlock(name),prop.kind); defined.add(name); }
    const elevation = stageSurfaceHeight(rig,prop.x,prop.z);
    const insert = drawing.addInsert(name,cad(prop,elevation),{layerName:'PROPS',rotationAngle:prop.rotation,
      scaleFactor:point3d(prop.scale,prop.scale,prop.scale)});
    addProperty(insert.addXData('STAGEFORGE'),prop.id);
    include(prop);
    label(PROP_CATALOG[prop.kind].label,{x:prop.x+0.12,z:prop.z+0.4*prop.scale},elevation);
  }
  for (const [i, prop] of authoredProps.entries()) {
    const name = prop.type === 'inflatable' ? 'SF_INFLATABLE' : 'SF_SCENIC';
    if (!defined.has(name)) {
      const block = drawing.addBlock(name);
      if (prop.type === 'inflatable') block.addCircle(point3d(0, 0, 0), 0.5);
      else outline(block, rectangle(0, 0, 0.95, 0.7), 0, '0', true);
      defined.add(name);
    }
    const elevation = stageSurfaceHeight(rig, prop.x, prop.z);
    drawing.addInsert(name, cad(prop, elevation), { layerName: 'PROPS' });
    include(prop);
    label(`${prop.type === 'inflatable' ? 'Inflatable' : 'Scenic'} ${i + 1}`, { x: prop.x + 0.15, z: prop.z + 0.3 }, elevation);
  }
  if (hangs?.length) {
    const block = drawing.addBlock('SF_PA_HANG');
    outline(block, rectangle(0, 0, 1.1, 0.55), 0, '0', true);
    block.addLine(point3d(0, 0, 0), point3d(0, -0.8, 0));
    hangs.forEach((hang, i) => {
      const insert = drawing.addInsert('SF_PA_HANG', cad(hang, hang.y), { layerName: 'PA', rotationAngle: hang.yaw });
      const data = insert.addXData('STAGEFORGE');
      addProperty(data, `PA Hang ${i + 1}`);
      addProperty(data, `${hang.count} boxes · yaw ${hang.yaw} · tilt ${hang.tilt} · splay ${hang.splay}`);
      include(hang);
      label(`PA ${i + 1} (${hang.count}x)`, { x: hang.x + 0.2, z: hang.z + 0.3 }, hang.y);
    });
  }
  for (const wall of walls) {
    const { width: w, x, y, z } = wall;
    // Three.js yaw about +Y maps local +X to (cos, -sin) in plan; cad() then flips Z.
    const rad = (wall.yaw * Math.PI) / 180;
    const dx = Math.cos(rad) * (w / 2), dz = -Math.sin(rad) * (w / 2);
    const pts: PlanPoint[] = [{ x: x - dx, z: z - dz }, { x: x + dx, z: z + dz }];
    outline(drawing, pts, y, 'VIDEO_WALLS', false);
    pts.forEach(include);
    label(wall.label || wall.id, { x: x + 0.15, z: z - 0.25 }, y);
  }
  label(`${rig.name}   |   PLAN IN METRES   |   +Y UPSTAGE`,{x:minX,z:downstage+1.2},0,0.3);
  return drawing.stringify().replace(/\r?\n/g,'\r\n') + '\r\n';
}
