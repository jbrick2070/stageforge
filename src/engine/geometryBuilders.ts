import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PlanPoint, RigConfig, TrussShape, VenueType } from '../types/show';
import { stageSurfaceHeight } from '../data/stageDesign';
import { SPEAKER_PROFILES, type SpeakerProfileId } from '../data/speakerProfiles';

// Shared high-quality PBR materials for authentic touring hardware
export interface SharedMaterials {
  aluminumTruss: THREE.MeshStandardMaterial;
  darkSteel: THREE.MeshStandardMaterial;
  fixtureBody: THREE.MeshStandardMaterial;
  hoistOrange: THREE.MeshStandardMaterial;
  stageDeck: THREE.MeshStandardMaterial;
  speakerCabinet: THREE.MeshStandardMaterial;
  speakerGrille: THREE.MeshStandardMaterial;
  speakerFabric: THREE.MeshStandardMaterial;
  speakerCone: THREE.MeshStandardMaterial;
  speakerRim: THREE.MeshStandardMaterial;
  chrome: THREE.MeshStandardMaterial;
}

export function createSharedMaterials(): SharedMaterials {
  // Procedural subtle brushed stage marley texture
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#373b40';
  ctx.fillRect(0, 0, 512, 512);
  // Deck panel seams
  ctx.strokeStyle = '#222429';
  ctx.lineWidth = 1.8;
  for (let i = 0; i <= 512; i += 256) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 512);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(512, i);
    ctx.stroke();
  }
  // Subtle micro-scuff variation for specular realism
  for (let i = 0; i < 650; i++) {
    const x = Math.random() * 512;
    const y = Math.random() * 512;
    const len = 8 + Math.random() * 24;
    ctx.strokeStyle = `rgba(255,255,255,${0.01 + Math.random() * 0.025})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (Math.random() - 0.5) * len, y + (Math.random() - 0.5) * len);
    ctx.stroke();
  }
  const deckTex = new THREE.CanvasTexture(canvas);
  deckTex.colorSpace = THREE.SRGBColorSpace;
  deckTex.wrapS = THREE.RepeatWrapping;
  deckTex.wrapT = THREE.RepeatWrapping;
  deckTex.repeat.set(6, 3);

  // Stamp the perforations into a mipmapped surface so the grille resolves at FOH distance.
  const perforations = document.createElement('canvas');
  perforations.width = perforations.height = 128;
  const grille = perforations.getContext('2d')!;
  grille.fillStyle = '#575c62';
  grille.fillRect(0, 0, 128, 128);
  grille.globalCompositeOperation = 'destination-out';
  grille.fillStyle = 'rgba(0,0,0,0.94)';
  for (let row = 0; row < 16; row++) {
    for (let col = -1; col <= 16; col++) {
      grille.beginPath();
      grille.arc(col * 8 + (row % 2) * 4, row * 8 + 4, 3.15, 0, Math.PI * 2);
      grille.fill();
    }
  }
  const grilleTex = new THREE.CanvasTexture(perforations);
  grilleTex.colorSpace = THREE.SRGBColorSpace;
  grilleTex.wrapS = grilleTex.wrapT = THREE.RepeatWrapping;
  grilleTex.repeat.set(5, 3);

  const cloth = document.createElement('canvas');
  cloth.width = cloth.height = 128;
  const fabric = cloth.getContext('2d')!;
  fabric.drawImage(perforations, 0, 0);
  fabric.globalCompositeOperation = 'destination-over';
  fabric.fillStyle = 'rgba(31,34,35,0.73)';
  fabric.fillRect(0, 0, 128, 128);
  const clothTex = new THREE.CanvasTexture(cloth);
  clothTex.colorSpace = THREE.SRGBColorSpace;
  clothTex.wrapS = clothTex.wrapT = THREE.RepeatWrapping;
  clothTex.repeat.copy(grilleTex.repeat);

  return {
    aluminumTruss: new THREE.MeshStandardMaterial({
      color: 0xc2cad6,
      metalness: 0.88,
      roughness: 0.26,
    }),
    darkSteel: new THREE.MeshStandardMaterial({
      color: 0x1b1e26,
      metalness: 0.82,
      roughness: 0.36,
    }),
    fixtureBody: new THREE.MeshStandardMaterial({
      color: 0x14161c,
      metalness: 0.65,
      roughness: 0.38,
    }),
    hoistOrange: new THREE.MeshStandardMaterial({
      color: 0xff6a00,
      metalness: 0.45,
      roughness: 0.42,
    }),
    stageDeck: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: deckTex,
      metalness: 0.08,
      roughness: 0.55,
    }),
    speakerCabinet: new THREE.MeshStandardMaterial({
      color: 0x27292e,
      metalness: 0.10,
      roughness: 0.74,
    }),
    speakerGrille: new THREE.MeshStandardMaterial({
      map: grilleTex,
      color: 0xe4e7eb,
      metalness: 0.46,
      roughness: 0.56,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
    }),
    speakerCone: new THREE.MeshStandardMaterial({ color: 0x505053, roughness: 0.79, metalness: 0.04 }),
    speakerRim: new THREE.MeshStandardMaterial({ color: 0x393c40, roughness: 0.43, metalness: 0.3 }),
    speakerFabric: new THREE.MeshStandardMaterial({ color: 0xb4b1aa, map: clothTex,
      roughness: 0.78, metalness: 0.18, transparent: true, depthWrite: false }),
    chrome: new THREE.MeshStandardMaterial({
      color: 0xe6edf7,
      metalness: 0.95,
      roughness: 0.14,
    }),
  };
}

// Bake static assemblies in local coordinates. The engine still moves the whole
// assembly (and any separately attached fixtures) through its original group.
function batchHardware(group: THREE.Group) {
  group.updateMatrixWorld(true);
  const local = group.matrixWorld.clone().invert();
  const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const parts = batches.get(object.material) ?? [];
    const geometry = object.geometry.clone();
    geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(local, object.matrixWorld));
    parts.push(geometry);
    batches.set(object.material, parts);
  });
  const looseObjects = group.children.filter(child => !(child instanceof THREE.Mesh || child instanceof THREE.Group));
  group.clear();
  for (const object of looseObjects) group.add(object);
  for (const [material, parts] of batches) {
    const indexed = parts.every(geometry => geometry.index !== null);
    const attributes = indexed ? parts : parts.map(geometry => geometry.index ? geometry.toNonIndexed() : geometry);
    const geometry = mergeGeometries(attributes, false)!;
    group.add(new THREE.Mesh(geometry, material));
  }
}

function addBox(group: THREE.Group, material: THREE.Material, x: number, y: number, z: number,
                width: number, height: number, depth: number) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  mesh.position.set(x, y, z);
  group.add(mesh);
  return mesh;
}

// Helper to create a strut between two 3D points
function addTubeStrut(
  group: THREE.Group,
  a: THREE.Vector3,
  b: THREE.Vector3,
  radius: number,
  mat: THREE.Material
) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  if (len < 0.001) return;
  const geom = new THREE.CylinderGeometry(radius, radius, len, 6, 1, false);
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  group.add(mesh);
}

/** Build the exposed walkable tops and fascia of a set of rectangular stage modules. */
export function buildPlatformDeck(rig: RigConfig, mats: SharedMaterials): THREE.Group {
  const group = new THREE.Group();
  const modules = rig.platforms ?? [];
  const coordinates = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
  const xs = coordinates(modules.flatMap(p => [p.x - p.width / 2, p.x + p.width / 2]));
  const zs = coordinates(modules.flatMap(p => [p.z - p.depth / 2, p.z + p.depth / 2]));
  const heights = xs.slice(1).map((x, i) => zs.slice(1).map((z, j) =>
    stageSurfaceHeight(rig, (xs[i] + x) / 2, (zs[j] + z) / 2)));
  const tops: number[] = [];
  const sides: number[] = [];
  const quad = (out: number[], a: number[], b: number[], c: number[], d: number[]) =>
    out.push(...a, ...b, ...d, ...b, ...c, ...d);
  for (let i = 0; i < heights.length; i++) {
    for (let j = 0; j < heights[i].length; j++) {
      const h = heights[i][j];
      if (h <= 0) continue;
      const corners = [[xs[i], h, zs[j]], [xs[i], h, zs[j + 1]], [xs[i + 1], h, zs[j + 1]], [xs[i + 1], h, zs[j]]];
      quad(tops, corners[0], corners[1], corners[2], corners[3]);
      const neighbours = [heights[i - 1]?.[j], heights[i][j + 1], heights[i + 1]?.[j], heights[i][j - 1]];
      neighbours.forEach((height, edge) => {
        const below = height ?? 0;
        if (below >= h) return;
        const a = corners[edge], b = corners[(edge + 1) % 4];
        quad(sides, a, [a[0], below, a[2]], [b[0], below, b[2]], b);
      });
    }
  }
  for (const [faces, material] of [[tops, mats.stageDeck], [sides, mats.fixtureBody]] as const) {
    if (!faces.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(faces, 3));
    if (faces === tops) {
      const uv: number[] = [];
      for (let i = 0; i < faces.length; i += 3) uv.push(faces[i] / 18, faces[i + 2] / 9);
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    }
    geo.computeVertexNormals();
    group.add(new THREE.Mesh(geo, material));
  }
  return group;
}

// Span dimensions remain in metres. Limit the repeated visual detail on oversized runs.
const MAX_TRUSS_BAYS = 192;
const MAX_COUPLER_SECTIONS = 64;
const MAX_BARRICADE_BAYS = 96;

// Draw four continuous chords through the corners. Both adjoining spans use
// the same mitred cross-section, including the closing joint on a loop.
function buildTrussPath(path: readonly PlanPoint[], mats: SharedMaterials, slotCount: number) {
  const group = new THREE.Group();
  const anchorPoints: THREE.Vector3[] = [];
  const mountSlots: { pos: THREE.Vector3; rotY: number }[] = [];
  const points: THREE.Vector2[] = [];
  for (const p of path) {
    const point = new THREE.Vector2(p.x, p.z);
    if (!points.length || points[points.length - 1].distanceToSquared(point) > 1e-8) points.push(point);
  }
  if (points.length < 2) return { group, anchorPoints, mountSlots };
  const closed = points[0].distanceToSquared(points[points.length - 1]) < 1e-8;
  const segments = points.slice(1).map((end, i) => {
    const direction = end.clone().sub(points[i]);
    const length = direction.length();
    direction.divideScalar(length);
    return { start: points[i], end, length, direction, normal: new THREE.Vector2(-direction.y, direction.x) };
  });
  const joints = points.map((_, i) => {
    const before = (segments[i - 1] ?? (closed ? segments[segments.length - 1] : segments[0])).normal;
    const after = (segments[i] ?? (closed ? segments[0] : segments[segments.length - 1])).normal;
    const dot = before.dot(after);
    return dot < -0.92 ? after : before.clone().add(after).divideScalar(Math.max(0.4, 1 + dot));
  });
  const total = segments.reduce((length, seg) => length + seg.length, 0);
  // Long festival runs keep their full length while sharing a finite bracing budget.
  const bayLength = Math.max(0.85, total / MAX_TRUSS_BAYS);
  const ring = (p: THREE.Vector2, n: THREE.Vector2) => [
    new THREE.Vector3(p.x + n.x * 0.24, -0.24, p.y + n.y * 0.24),
    new THREE.Vector3(p.x + n.x * 0.24,  0.24, p.y + n.y * 0.24),
    new THREE.Vector3(p.x - n.x * 0.24,  0.24, p.y - n.y * 0.24),
    new THREE.Vector3(p.x - n.x * 0.24, -0.24, p.y - n.y * 0.24),
  ];
  for (const [i, seg] of segments.entries()) {
    let from = ring(seg.start, joints[i]);
    const bays = Math.max(1, Math.round(seg.length / bayLength));
    for (let j = 1; j <= bays; j++) {
      const to = ring(seg.start.clone().lerp(seg.end, j / bays), j === bays ? joints[i + 1] : seg.normal);
      for (let corner = 0; corner < 4; corner++) {
        const next = (corner + 1) % 4;
        addTubeStrut(group, from[corner], to[corner], 0.038, mats.aluminumTruss);
        addTubeStrut(group, from[j % 2 ? corner : next], to[j % 2 ? next : corner], 0.023, mats.aluminumTruss);
        if (j === 1) addTubeStrut(group, from[corner], from[next], 0.026, mats.chrome);
        if (!closed && i === segments.length - 1 && j === bays) addTubeStrut(group, to[corner], to[next], 0.026, mats.chrome);
      }
      from = to;
    }
  }
  const anchors = new Set<string>();
  for (const p of points) {
    const key = `${p.x},${p.y}`;
    if (anchors.has(key)) continue;
    anchors.add(key);
    anchorPoints.push(new THREE.Vector3(p.x, 0.29, p.y));
  }
  let index = 0, offset = 0;
  for (let i = 0; i < slotCount; i++) {
    const distance = (i + 0.5) * total / slotCount;
    while (index < segments.length - 1 && distance > offset + segments[index].length) {
      offset += segments[index++].length;
    }
    const seg = segments[index];
    const p = seg.start.clone().addScaledVector(seg.direction, distance - offset);
    mountSlots.push({ pos: new THREE.Vector3(p.x, -0.28, p.y), rotY: -Math.atan2(seg.direction.y, seg.direction.x) });
  }
  batchHardware(group);
  return { group, anchorPoints, mountSlots };
}

/** Four-chord touring truss with diagonal lacing and underside fixture mounts. */
export function buildTrussGeometry(
  shape: TrussShape,
  width: number,
  mats: SharedMaterials,
  path: readonly PlanPoint[] = [],
  fixtureCount?: number
): { group: THREE.Group; anchorPoints: THREE.Vector3[]; mountSlots: { pos: THREE.Vector3; rotY: number }[] } {
  if (shape === 'path') return buildTrussPath(path, mats, fixtureCount ?? 32);
  const group = new THREE.Group();
  const anchorPoints: THREE.Vector3[] = [];
  const mountSlots: { pos: THREE.Vector3; rotY: number }[] = [];

  const chordR = 0.038;
  const braceR = 0.023;
  const hSize = shape === 'circle' ? Math.min(0.24, width * 0.14) : 0.24;

  if (shape === 'box') {
    const halfW = width / 2;
    const corners = [
      [-hSize, -hSize],
      [hSize, -hSize],
      [hSize, hSize],
      [-hSize, hSize],
    ];

    // 4 longitudinal main aluminum tubes
    const tubeGeo = new THREE.CylinderGeometry(chordR, chordR, width, 8);
    tubeGeo.rotateZ(Math.PI / 2);
    for (const [cy, cz] of corners) {
      const m = new THREE.Mesh(tubeGeo, mats.aluminumTruss);
      m.position.set(0, cy, cz);
      group.add(m);
    }

    // Diagonal lacing bays along the truss
    const bayCount = THREE.MathUtils.clamp(Math.round(width / 0.85), 4, MAX_TRUSS_BAYS);
    const bayW = width / bayCount;
    for (let i = 0; i < bayCount; i++) {
      const x0 = -halfW + i * bayW;
      const x1 = x0 + bayW;
      const flip = i % 2 === 0;

      // Front & Back face diagonals
      addTubeStrut(
        group,
        new THREE.Vector3(x0, flip ? -hSize : hSize, hSize),
        new THREE.Vector3(x1, flip ? hSize : -hSize, hSize),
        braceR,
        mats.aluminumTruss
      );
      addTubeStrut(
        group,
        new THREE.Vector3(x0, flip ? hSize : -hSize, -hSize),
        new THREE.Vector3(x1, flip ? -hSize : hSize, -hSize),
        braceR,
        mats.aluminumTruss
      );
      // Top & Bottom face diagonals
      addTubeStrut(
        group,
        new THREE.Vector3(x0, hSize, flip ? -hSize : hSize),
        new THREE.Vector3(x1, hSize, flip ? hSize : -hSize),
        braceR,
        mats.aluminumTruss
      );
      addTubeStrut(
        group,
        new THREE.Vector3(x0, -hSize, flip ? hSize : -hSize),
        new THREE.Vector3(x1, -hSize, flip ? -hSize : hSize),
        braceR,
        mats.aluminumTruss
      );
    }

    // Join modular sections with coupler collars. These catch the side light on long spans.
    const baySections = THREE.MathUtils.clamp(Math.round(width / 3), 1, MAX_COUPLER_SECTIONS);
    const coupler = new THREE.CylinderGeometry(chordR * 1.45, chordR * 1.45, 0.095, 8);
    coupler.rotateZ(Math.PI / 2);
    for (let j = 1; j < baySections; j++) {
      for (const [cy, cz] of corners) {
        const joint = new THREE.Mesh(coupler, mats.chrome);
        joint.position.set(-halfW + width * (j / baySections), cy, cz);
        group.add(joint);
      }
    }

    // End square frame plates
    for (const ex of [-halfW, halfW]) {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.06, hSize * 2.1, hSize * 2.1), mats.darkSteel);
      plate.position.set(ex, 0, 0);
      group.add(plate);
    }

    // Hoist anchor points (2 or 3 depending on span)
    if (width >= 14) {
      anchorPoints.push(
        new THREE.Vector3(-halfW * 0.78, hSize + 0.05, 0),
        new THREE.Vector3(0, hSize + 0.05, 0),
        new THREE.Vector3(halfW * 0.78, hSize + 0.05, 0)
      );
    } else {
      anchorPoints.push(
        new THREE.Vector3(-halfW * 0.72, hSize + 0.05, 0),
        new THREE.Vector3(halfW * 0.72, hSize + 0.05, 0)
      );
    }

    // Pre-generate evenly distributed underside mounting slots
    const slotCount = Math.max(32, fixtureCount ?? 0);
    const inset = Math.min(0.65, halfW * 0.2);
    for (let i = 0; i < slotCount; i++) {
      const t = i / (slotCount - 1);
      const sx = THREE.MathUtils.lerp(-halfW + inset, halfW - inset, t);
      mountSlots.push({ pos: new THREE.Vector3(sx, -hSize - 0.04, 0), rotY: 0 });
    }
  } else if (shape === 'circle') {
    const radius = width / 2;
    const ringOffsets = [
      [radius - hSize, hSize],
      [radius + hSize, hSize],
      [radius - hSize, -hSize],
      [radius + hSize, -hSize],
    ];
    for (const [r, y] of ringOffsets) {
      const torus = new THREE.Mesh(new THREE.TorusGeometry(r, chordR, 8, 48), mats.aluminumTruss);
      torus.rotation.x = Math.PI / 2;
      torus.position.y = y;
      group.add(torus);
    }

    // Radial + diagonal cross-bracing around the circle
    const segs = 28;
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      const outer0 = new THREE.Vector3(Math.cos(a0) * (radius + hSize), hSize, Math.sin(a0) * (radius + hSize));
      const outer1 = new THREE.Vector3(Math.cos(a1) * (radius + hSize), -hSize, Math.sin(a1) * (radius + hSize));
      const inner0 = new THREE.Vector3(Math.cos(a0) * (radius - hSize), -hSize, Math.sin(a0) * (radius - hSize));
      const inner1 = new THREE.Vector3(Math.cos(a1) * (radius - hSize), hSize, Math.sin(a1) * (radius - hSize));
      addTubeStrut(group, outer0, outer1, braceR, mats.aluminumTruss);
      addTubeStrut(group, inner0, inner1, braceR, mats.aluminumTruss);
      addTubeStrut(group, outer0, new THREE.Vector3(Math.cos(a0) * (radius - hSize), hSize, Math.sin(a0) * (radius - hSize)), braceR, mats.aluminumTruss);
    }

    // 4 hoist anchor points around circle
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      anchorPoints.push(new THREE.Vector3(Math.cos(a) * radius, hSize + 0.05, Math.sin(a) * radius));
    }

    const slotCount = Math.max(24, fixtureCount ?? 0);
    for (let i = 0; i < slotCount; i++) {
      const a = (i / slotCount) * Math.PI * 2;
      mountSlots.push({
        pos: new THREE.Vector3(Math.cos(a) * radius, -hSize - 0.04, Math.sin(a) * radius),
        rotY: -a + Math.PI / 2,
      });
    }
  } else {
    // Chevron / Angled Kinetic Wing truss
    const angle = 0.36;
    const armLen = width / (2 * Math.cos(angle));
    const armDepth = Math.sin(angle) * armLen;
    const leftArm = buildTrussGeometry('box', armLen, mats);
    leftArm.group.position.set(-width / 4, 0, -armDepth / 2);
    leftArm.group.rotation.y = -angle;
    group.add(leftArm.group);

    const rightArm = buildTrussGeometry('box', armLen, mats);
    rightArm.group.position.set(width / 4, 0, -armDepth / 2);
    rightArm.group.rotation.y = angle;
    group.add(rightArm.group);

    // Center steel corner junction block
    const hub = new THREE.Mesh(new THREE.BoxGeometry(0.62, hSize * 2.2, hSize * 2.2), mats.darkSteel);
    group.add(hub);

    anchorPoints.push(
      new THREE.Vector3(-width * 0.42, hSize + 0.05, -armDepth * 0.84),
      new THREE.Vector3(0, hSize + 0.05, 0.05),
      new THREE.Vector3(width * 0.42, hSize + 0.05, -armDepth * 0.84)
    );

    const slotsPerSide = Math.max(8, Math.ceil((fixtureCount ?? 0) / 2));
    for (let i = 0; i < slotsPerSide; i++) {
      const t = (i + 0.5) / slotsPerSide;
      const sx = -width * 0.46 + t * (width * 0.42);
      const sz = -Math.abs(sx) * Math.tan(angle);
      mountSlots.push({ pos: new THREE.Vector3(sx, -hSize - 0.04, sz), rotY: -angle });
    }
    for (let i = 0; i < slotsPerSide; i++) {
      const t = (i + 0.5) / slotsPerSide;
      const sx = width * 0.04 + t * (width * 0.42);
      const sz = -Math.abs(sx) * Math.tan(angle);
      mountSlots.push({ pos: new THREE.Vector3(sx, -hSize - 0.04, sz), rotY: angle });
    }
  }

  batchHardware(group);
  return { group, anchorPoints, mountSlots };
}

/**
 * CM Lodestar / Kinesys-style Chain Hoist Motor Unit + dynamic steel chain mesh
 */
export function createChainHoistUnit(mats: SharedMaterials) {
  const root = new THREE.Group();

  // Motor body sitting on the truss anchor
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.42, 12), mats.darkSteel);
  body.rotation.z = Math.PI / 2;
  body.position.y = 0.24;
  root.add(body);

  // Orange safety housing cap (classic CM Lodestar accent)
  const capL = new THREE.Mesh(new THREE.CylinderGeometry(0.165, 0.165, 0.06, 12), mats.hoistOrange);
  capL.rotation.z = Math.PI / 2;
  capL.position.set(-0.2, 0.24, 0);
  root.add(capL);
  const capR = capL.clone();
  capR.position.set(0.2, 0.24, 0);
  root.add(capR);

  // Chain bag hanging slightly beside motor
  const bag = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.34, 0.14), mats.fixtureBody);
  bag.position.set(0.24, 0.05, 0.12);
  root.add(bag);

  // Shackle connecting to truss
  const shackle = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.018, 6, 12), mats.chrome);
  shackle.position.y = 0.05;
  root.add(shackle);

  // Dynamic steel hoist chain extending upward from motor to roof grid (unit height 1, scaled live every frame!)
  batchHardware(root);
  const chainGeo = new THREE.CylinderGeometry(0.022, 0.022, 1.0, 6);
  chainGeo.translate(0, 0.5, 0); // origin at bottom, grows +Y
  const chainMesh = new THREE.Mesh(chainGeo, mats.chrome);
  chainMesh.position.y = 0.32;
  root.add(chainMesh);

  return { root, chainMesh };
}

/** Build a plywood enclosure from its side elevation (depth, height). */
function speakerCase(width: number, profile: [number, number][], material: THREE.Material) {
  const outline = new THREE.Shape(profile.map(([z, y]) => new THREE.Vector2(z, y)));
  const geometry = new THREE.ExtrudeGeometry(outline, {
    depth: width - 0.02, bevelEnabled: true, bevelSegments: 1, bevelSize: 0.01, bevelThickness: 0.01,
  });
  geometry.translate(0, 0, -(width - 0.02) / 2).rotateY(-Math.PI / 2);
  return new THREE.Mesh(geometry, material);
}

// The driver front is +Z. A concave paper cone, dust cap and rolled surround
// sit behind the grille rather than being painted on the plywood face.
function addDriver(group: THREE.Group, mats: SharedMaterials, x: number, y: number, z: number, radius: number) {
  const section = [
    [1, 0.16], [0.96, 0.22], [0.90, 0.23], [0.86, 0.16], [0.36, 0.012],
    [0.28, 0.064], [0.16, 0.12], [0, 0.145],
  ].map(([r, depth]) => new THREE.Vector2(r * radius, depth * radius));
  const cone = new THREE.Mesh(new THREE.LatheGeometry(section, 24), mats.speakerCone);
  cone.rotation.x = Math.PI / 2;
  cone.position.set(x, y, z);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(radius, radius * 0.048, 6, 24), mats.speakerRim);
  rim.position.set(x, y, z + radius * 0.17);
  group.add(cone, rim);
}

function addWaveguide(group: THREE.Group, mats: SharedMaterials, w: number, h: number, z: number) {
  const geo = new THREE.PlaneGeometry(w, h, 3, 3);
  const vertices = geo.getAttribute('position');
  for (let i = 0; i < vertices.count; i++) {
    const inside = i % 4 === 1 || i % 4 === 2;
    if (inside && (Math.floor(i / 4) === 1 || Math.floor(i / 4) === 2)) {
      vertices.setXYZ(i, vertices.getX(i) * 0.35, vertices.getY(i) * 0.95, -h * 0.2);
    }
  }
  geo.computeVertexNormals();
  const horn = new THREE.Mesh(geo, mats.speakerRim);
  horn.position.z = z;
  group.add(horn);
}

function addGrille(group: THREE.Group, mats: SharedMaterials, w: number, h: number, z: number,
                   frontMaterial = mats.speakerGrille) {
  const grille = new THREE.Mesh(new THREE.PlaneGeometry(w, h), frontMaterial);
  grille.position.z = z;
  group.add(grille);
  const fastener = new THREE.CylinderGeometry(0.009, 0.009, 0.005, 6);
  fastener.rotateX(Math.PI / 2);
  for (const x of [-w * 0.48, w * 0.48]) {
    for (const y of [-h * 0.45, h * 0.45]) {
      const screw = new THREE.Mesh(fastener, mats.speakerRim);
      screw.position.set(x, y, z + 0.003);
      group.add(screw);
    }
  }
  addBox(group, mats.darkSteel, 0, -h * 0.38, z + 0.0035, w * 0.078, Math.min(0.027, h * 0.08), 0.006);
  addBox(group, mats.aluminumTruss, 0, -h * 0.38, z + 0.007, w * 0.046, 0.007, 0.002);
}

function touringArrayCabinet(mats: SharedMaterials) {
  const cab = new THREE.Group();
  cab.add(speakerCase(1.34, [
    [-0.33, -0.16], [0.30, -0.197], [0.30, 0.197], [-0.33, 0.16],
  ], mats.speakerCabinet));
  for (const x of [-0.418, 0.418]) addDriver(cab, mats, x, 0, 0.312, 0.143);
  addWaveguide(cab, mats, 0.38, 0.27, 0.35);
  addGrille(cab, mats, 1.28, 0.358, 0.37);
  for (const direction of [-1, 1]) {
    addBox(cab, mats.speakerRim, direction * 0.65, 0, 0.337, 0.036, 0.393, 0.075);
    addBox(cab, mats.darkSteel, direction * 0.676, 0, -0.21, 0.023, 0.34, 0.14);
    addBox(cab, mats.fixtureBody, direction * 0.682, 0, 0.01, 0.017, 0.097, 0.23);
    const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.039, 8), mats.chrome);
    pin.rotation.z = Math.PI / 2;
    pin.position.set(direction * 0.68, -0.121, -0.215);
    cab.add(pin);
    addBox(cab, mats.speakerRim, 0, direction * 0.19, 0.338, 1.30, 0.020, 0.058);
  }
  return cab;
}

// Match the published outer envelope including grille, runners and side hardware.
// Apply the calibration before rotating the cabinet into its installed orientation.
function fitCabinet(group: THREE.Group, w: number, h: number, d: number) {
  batchHardware(group);
  const bounds = new THREE.Box3().setFromObject(group);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  for (const child of group.children as THREE.Mesh[]) {
    child.geometry.translate(-center.x, -center.y, -center.z);
    child.geometry.scale(w / size.x, h / size.y, d / size.z);
  }
  return group;
}

function k2Cabinet(mats: SharedMaterials) {
  const cab = new THREE.Group();
  cab.add(speakerCase(1.315, [
    [-0.195, -0.132], [0.125, -0.168], [0.125, 0.168], [-0.195, 0.132],
  ], mats.speakerCabinet));
  for (const side of [-1, 1]) {
    addDriver(cab, mats, side * 0.46, 0, 0.141, 0.1524);
    for (const y of [-0.083, 0.083]) {
      addDriver(cab, mats, side * 0.217, y, 0.141, 0.08255);
    }
    const wing = new THREE.Group();
    addGrille(wing, mats, 0.532, 0.32, 0.19, mats.speakerFabric);
    wing.position.x = side * 0.391;
    cab.add(wing);
    const fin = addBox(cab, mats.speakerRim, side * 0.102, 0, 0.16, 0.052, 0.31, 0.024);
    fin.rotation.y = side * 0.36;
    addBox(cab, mats.darkSteel, side * 0.659, 0, -0.024, 0.014, 0.09, 0.15);
    for (const y of [-0.119, 0.119]) {
      addBox(cab, mats.speakerRim, side * 0.66, y, -0.12, 0.012, 0.057, 0.11);
    }
  }
  // The two HF compression drivers feed the central waveguide behind the fixed fins.
  for (const y of [-0.077, 0.077]) {
    const throat = new THREE.Group();
    addWaveguide(throat, mats, 0.18, 0.15, 0.178);
    throat.position.y = y;
    cab.add(throat);
  }
  const spec = SPEAKER_PROFILES.k2.array;
  return fitCabinet(cab, spec.width, spec.height, spec.depth);
}

// An optional pickup height sets the suspension termination relative to the fly frame.
export function createLineArray(side: -1 | 1, mats: SharedMaterials, boxCount = 9,
                                pickupHeight = 4.4, profile: SpeakerProfileId = 'touring') {
  const group = new THREE.Group();
  const referenced = profile === 'k2';
  const front = referenced ? SPEAKER_PROFILES.k2.array.depth / 2 : 0.365;
  const halfHeight = referenced ? SPEAKER_PROFILES.k2.array.height / 2 : 0.21;
  const frameDepth = referenced ? 0.49 : 0.88;
  for (const x of [-0.65, 0.65]) addBox(group, mats.darkSteel, x, 0, 0, 0.10, 0.16, frameDepth);
  for (const z of [-1, 1].map(direction => direction * (frameDepth / 2 - 0.06))) {
    addBox(group, mats.darkSteel, 0, 0, z, 1.38, 0.15, 0.10);
    const eye = new THREE.Vector3(0, 0.78, z * 0.63);
    for (const x of [-0.55, 0.55]) {
      addTubeStrut(group, new THREE.Vector3(x, 0.08, z), eye, 0.017, mats.chrome);
    }
    addTubeStrut(group, eye, new THREE.Vector3(0, Math.max(0.80, pickupHeight), eye.z), 0.017, mats.chrome);
  }

  const count = THREE.MathUtils.clamp(Math.round(boxCount) || 9, 4, 12);
  const prototype = referenced ? k2Cabinet(mats) : touringArrayCabinet(mats);
  const k2Angles = [0.25, 1, 2, 3, 4, 5, 7.5, 10];
  let pitch = 0.025;
  let hingeY = -0.095;
  let hingeZ = front;
  for (let i = 0; i < count; i++) {
    const cab = prototype.clone();
    cab.rotation.x = pitch;
    cab.position.set(0, hingeY - halfHeight * Math.cos(pitch) + front * Math.sin(pitch),
      hingeZ - halfHeight * Math.sin(pitch) - front * Math.cos(pitch));
    group.add(cab);
    hingeY -= 2 * halfHeight * Math.cos(pitch);
    hingeZ -= 2 * halfHeight * Math.sin(pitch);
    const depth = i / (count - 1);
    const angle = referenced ? k2Angles[Math.round(depth * (k2Angles.length - 1))] : 1.0 + 6.5 * depth * depth;
    pitch += THREE.MathUtils.degToRad(angle);
  }
  batchHardware(group);
  group.rotation.y = -side * 0.14;
  return group;
}

/** Ground-stack dual-18 sub. Origin at cabinet center, front at +Z. */
export function createSubwoofer(mats: SharedMaterials, profile: SpeakerProfileId = 'touring'): THREE.Group {
  const group = new THREE.Group();
  if (profile === 'k2') {
    group.add(speakerCase(1.318, [
      [-0.351, -0.241], [-0.337, -0.253], [0.282, -0.253], [0.282, 0.255], [-0.351, 0.255],
    ], mats.speakerCabinet));
    for (const side of [-1, 1]) {
      addDriver(group, mats, side * 0.355, 0, 0.287, 0.2286);
      const wing = new THREE.Group();
      addGrille(wing, mats, 0.555, 0.486, 0.35, mats.speakerFabric);
      wing.position.x = side * 0.355;
      group.add(wing);
      const vent = addBox(group, mats.speakerRim, side * 0.075, 0, 0.307, 0.025, 0.476, 0.078);
      vent.rotation.y = side * 0.28;
      addBox(group, mats.fixtureBody, side * 0.43, -0.264, -0.01, 0.093, 0.022, 0.62);
      for (const z of [-0.21, 0.05]) {
        addBox(group, mats.darkSteel, side * 0.663, 0, z, 0.014, 0.115, 0.16);
      }
    }
    addBox(group, mats.fixtureBody, 0, 0, 0.293, 0.115, 0.476, 0.012);
    const spec = SPEAKER_PROFILES.k2.sub;
    return fitCabinet(group, spec.width, spec.height, spec.depth);
  }
  const cab = speakerCase(1.38, [
    [-0.47, -0.395], [-0.43, -0.428], [0.425, -0.428], [0.425, 0.428], [-0.47, 0.428],
  ], mats.speakerCabinet);
  group.add(cab);
  for (const side of [-1, 1]) {
    addDriver(group, mats, side * 0.326, 0.040, 0.437, 0.235);
    // The recessed vent mouth and lower lip sit below each front-loaded driver.
    addBox(group, mats.fixtureBody, side * 0.33, -0.292, 0.441, 0.49, 0.088, 0.020);
    addBox(group, mats.speakerRim, side * 0.33, -0.340, 0.452, 0.52, 0.012, 0.055);
    addBox(group, mats.speakerRim, side * 0.676, 0, 0.461, 0.027, 0.85, 0.07);
    addBox(group, mats.darkSteel, side * 0.696, -0.009, -0.02, 0.014, 0.18, 0.34);
    addBox(group, mats.speakerRim, side * 0.705, 0.025, -0.02, 0.013, 0.04, 0.25);
    for (const z of [-0.31, 0.32]) addBox(group, mats.fixtureBody, side * 0.53, -0.437, z, 0.12, 0.03, 0.1);
  }
  addBox(group, mats.speakerRim, 0, 0, 0.466, 0.026, 0.79, 0.035);
  addGrille(group, mats, 1.33, 0.80, 0.493);
  // Bumper rails protect the front grille and remain visible from FOH.
  for (const y of [-0.41, 0.41]) addBox(group, mats.speakerRim, 0, y, 0.463, 1.36, 0.029, 0.07);
  batchHardware(group);
  return group;
}

/** Coaxial floor monitor, local origin on the deck, aiming up towards −Z. */
export function createMonitorWedge(mats: SharedMaterials, profile: SpeakerProfileId = 'touring'): THREE.Group {
  const group = new THREE.Group();
  if (profile === 'k2') {
    // Along X lies the original upright cabinet's long axis. Rotate its side bevel
    // onto the floor, leaving the acoustic axis 35 degrees from vertical.
    const cab = new THREE.Group();
    cab.add(speakerCase(0.49, [
      [-0.179, -0.150], [-0.025, -0.207], [0.128, -0.207],
      [0.128, 0.207], [0.041, 0.207], [-0.179, -0.107],
    ], mats.speakerCabinet));
    addDriver(cab, mats, 0, 0, 0.138, 0.1524);
    const ellipse = new THREE.LatheGeometry([
      new THREE.Vector2(1, 0), new THREE.Vector2(0.78, -0.005),
      new THREE.Vector2(0.41, -0.018), new THREE.Vector2(0.20, -0.028),
    ], 20);
    ellipse.rotateX(Math.PI / 2).scale(0.073, 0.05, 1);
    const horn = new THREE.Mesh(ellipse, mats.speakerRim);
    horn.position.z = 0.171;
    cab.add(horn);
    addGrille(cab, mats, 0.473, 0.405, 0.18, mats.speakerFabric);
    for (const side of [-1, 1]) {
      addBox(cab, mats.darkSteel, side * 0.24, 0, -0.055, 0.012, 0.068, 0.092);
      addBox(cab, mats.fixtureBody, side * 0.204, 0, 0.141, 0.026, 0.20, 0.025);
    }
    const spec = SPEAKER_PROFILES.k2.monitor;
    fitCabinet(cab, spec.height, spec.width, spec.depth);
    cab.rotation.x = THREE.MathUtils.degToRad(-125);
    cab.position.y = -new THREE.Box3().setFromObject(cab, true).min.y;
    group.add(cab);
    return group;
  }
  group.add(speakerCase(0.59, [
    [-0.34, 0.035], [0.33, 0.035], [0.33, 0.40], [0.19, 0.55], [-0.34, 0.105],
  ], mats.speakerCabinet));
  const face = new THREE.Group();
  face.rotation.x = -Math.atan2(0.53, -0.445);
  face.position.set(0, 0.331, -0.080);
  addDriver(face, mats, 0, 0, 0.015, 0.198);
  addWaveguide(face, mats, 0.102, 0.092, 0.057);
  addGrille(face, mats, 0.55, 0.625, 0.067);
  for (const y of [-0.315, 0.315]) addBox(face, mats.speakerRim, 0, y, 0.059, 0.56, 0.017, 0.025);
  group.add(face);
  for (const side of [-1, 1]) {
    addBox(group, mats.darkSteel, side * 0.298, 0.19, 0.08, 0.016, 0.09, 0.23);
    for (const z of [-0.22, 0.22]) addBox(group, mats.fixtureBody, side * 0.19, 0.016, z, 0.08, 0.033, 0.075);
  }
  batchHardware(group);
  return group;
}

/**
 * DJ / Live Console Booth with glowing CDJ platters & silhouette artist
 */
export function createDjBooth(mats: SharedMaterials): { group: THREE.Group; stripMat: THREE.MeshBasicMaterial } {
  const group = new THREE.Group();

  // Main black acrylic booth riser
  const table = new THREE.Mesh(new THREE.BoxGeometry(3.8, 1.15, 1.45), mats.fixtureBody);
  table.position.y = 0.575;
  group.add(table);

  // Illuminated front accent trim strip (reacts to primary show color!)
  const stripMat = new THREE.MeshBasicMaterial({ color: 0x00f0ff });
  const frontStrip = new THREE.Mesh(new THREE.BoxGeometry(3.62, 0.06, 0.04), stripMat);
  frontStrip.position.set(0, 1.04, 0.74);
  group.add(frontStrip);
  const bottomStrip = new THREE.Mesh(new THREE.BoxGeometry(3.62, 0.04, 0.04), stripMat);
  bottomStrip.position.set(0, 0.08, 0.74);
  group.add(bottomStrip);

  // 4 CDJ decks + DJM mixer on top
  const mixer = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.09, 0.52), mats.darkSteel);
  mixer.position.set(0, 1.19, 0.05);
  group.add(mixer);

  for (const dx of [-1.05, -0.58, 0.58, 1.05]) {
    const cdj = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.08, 0.48), mats.darkSteel);
    cdj.position.set(dx, 1.185, 0.05);
    const jog = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.02, 16), mats.chrome);
    jog.position.set(dx, 1.235, 0.1);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.125, 0.01, 6, 20), stripMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(dx, 1.24, 0.1);
    group.add(cdj, jog, ring);
  }

  // Stylized artist silhouette standing behind the decks
  const silhouetteMat = new THREE.MeshStandardMaterial({ color: 0x0a0b10, roughness: 0.85, metalness: 0.1 });
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.15, 0.65, 10), silhouetteMat);
  torso.position.set(0, 1.18, -0.58);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.145, 12, 12), silhouetteMat);
  head.position.set(0, 1.66, -0.56);
  const headphones = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.025, 6, 16, Math.PI), mats.chrome);
  headphones.position.set(0, 1.67, -0.56);
  // A bent arm at each deck gives the performer a readable working posture.
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Vector3(side * 0.15, 1.45, -0.54);
    const elbow = new THREE.Vector3(side * 0.28, 1.23, -0.38);
    const hand = new THREE.Vector3(side * (side > 0 ? 0.56 : 0.23), 1.25, -0.09);
    addTubeStrut(group, shoulder, elbow, 0.065, silhouetteMat);
    addTubeStrut(group, elbow, hand, 0.045, silhouetteMat);
  }
  // Removable fluted fascia breaks up grazing reflections across the booth.
  for (let i = -12; i <= 12; i++) {
    addBox(group, mats.darkSteel, i * 0.142, 0.55, 0.735, 0.022, 0.82, 0.03);
  }
  group.add(torso, head, headphones);
  batchHardware(group);
  return { group, stripMat };
}

function crowdGeometry() {
  // Coordinates are in metres. Share the torso, head and legs across all poses.
  const pieces: THREE.BufferGeometry[] = [];
  const part = (geometry: THREE.BufferGeometry, color: number) => {
    const tint = new THREE.Color(color);
    const count = geometry.attributes.position.count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) tint.toArray(colors, i * 3);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    pieces.push(geometry);
  };
  const jacket = new THREE.LatheGeometry([
    new THREE.Vector2(0.16, 0.80), new THREE.Vector2(0.17, 1.07),
    new THREE.Vector2(0.22, 1.35), new THREE.Vector2(0.19, 1.43),
    new THREE.Vector2(0.08, 1.49)
  ], 8).scale(1, 1, 0.75);
  part(jacket, 0xa2a5ad);
  const head = new THREE.LatheGeometry([
    new THREE.Vector2(0.055, 1.44), new THREE.Vector2(0.06, 1.51),
    new THREE.Vector2(0.099, 1.57), new THREE.Vector2(0.111, 1.67),
    new THREE.Vector2(0.09, 1.735), new THREE.Vector2(0.03, 1.765),
    new THREE.Vector2(0, 1.77)
  ], 8).scale(1, 1, 1.05);
  part(head, 0xbda398);
  for (const side of [-1, 1]) {
    const leg = new THREE.CylinderGeometry(0.094, 0.067, 0.86, 6, 1, true);
    leg.rotateZ(side * 0.042).translate(side * 0.09, 0.43, 0);
    part(leg, 0x50555e);
  }

  const limb = (from: THREE.Vector3, to: THREE.Vector3, r1: number, r2: number) => {
    const delta = to.clone().sub(from);
    const geom = new THREE.CylinderGeometry(r2, r1, delta.length(), 5, 1, true);
    geom.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()));
    return geom.translate((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
  };
  const fixedParts = pieces.length;
  const poses: THREE.BufferGeometry[] = [];
  for (let pose = 0; pose < 3; pose++) {
    pieces.length = fixedParts;
    for (const side of [-1, 1]) {
      const raised = pose === 2 || (pose === 1 && side > 0);
      const shoulder = new THREE.Vector3(side * 0.18, 1.39, 0);
      const elbow = new THREE.Vector3(side * (raised ? 0.41 : 0.25), raised ? 1.55 : 1.12, 0.01);
      const wrist = new THREE.Vector3(side * (raised ? 0.37 : 0.21), raised ? 1.85 : 0.96, 0.14);
      part(limb(shoulder, elbow, 0.078, 0.056), 0xa2a5ad);
      part(limb(elbow, wrist, 0.056, 0.038), 0xa88f82);
      const hand = new THREE.SphereGeometry(1, 5, 3);
      hand.scale(0.043, 0.068, 0.039).translate(wrist.x, wrist.y, wrist.z);
      part(hand, 0xbda398);
    }
    poses.push(mergeGeometries(pieces, false)!);
  }
  const geometry = poses[0];
  geometry.morphAttributes.position = poses.slice(1).map(pose => pose.getAttribute('position'));
  geometry.morphAttributes.normal = poses.slice(1).map(pose => pose.getAttribute('normal'));
  return geometry;
}

/** Interior bounds of a small room, so cameras stay inside its walls and under its ceiling. */
export interface VenueRoom {
  halfWidth: number;
  rearZ: number;
  ceilingY: number;
}

interface SeatSlot {
  x: number;
  y: number;
  z: number;
}

/** Hoist/fly grid height: the steel the rig hangs from. */
const VENUE_ROOF: Record<VenueType, number> = {
  arena: 15.8,
  warehouse: 11.2,
  festival: 16.5,
  theatre: 17, // fly-tower grid above the stage house
  club: 5.2, // structural soffit of a low-ceiling room
};

/** Velour hung in soft pleats; faces the audience (+Z). */
function pleatedDrape(width: number, height: number, material: THREE.Material, depth = 0.1) {
  const geometry = new THREE.PlaneGeometry(width, height, Math.max(8, Math.round(width * 6)), 1);
  const folds = geometry.getAttribute('position');
  for (let i = 0; i < folds.count; i++) {
    const x = folds.getX(i);
    folds.setZ(i, Math.cos(x * 5.0 + 0.2 * Math.sin(x * 1.4)) * depth);
  }
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

/**
 * A ~350-seat proscenium house: apron, proscenium arch with gathered house tabs, a fly tower,
 * black legs and borders masking the wings, a cyclorama, an orchestra-pit rail and a raked stalls.
 */
function buildTheatreHouse(
  group: THREE.Group,
  mats: SharedMaterials,
  practicals: THREE.MeshBasicMaterial[],
  houseLamp: THREE.MeshBasicMaterial,
  stageWidth: number,
  stageDepth: number,
  stageHeight: number,
  roofY: number,
): { room: VenueRoom; seats: SeatSlot[] } {
  const front = stageDepth / 2;
  const prosZ = front - 1.5; // 1.5 m apron (forestage) in front of the proscenium line
  const openW = Math.max(8, stageWidth - 1.2);
  const openH = 7.6;
  const houseCeiling = 10.5;
  const houseW = Math.max(18, openW + 8);
  const stageHouseW = Math.max(openW + 9, stageWidth + 3); // wing space either side
  const backZ = -stageDepth / 2 - 1.2;

  const plaster = new THREE.MeshStandardMaterial({ color: 0x2b2627, roughness: 0.92 });
  const velour = new THREE.MeshStandardMaterial({ color: 0x131115, roughness: 0.98 });
  const houseRed = new THREE.MeshStandardMaterial({ color: 0x5e121b, roughness: 0.95 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x6d5734, roughness: 0.55, metalness: 0.35 });
  const cyclorama = new THREE.MeshStandardMaterial({ color: 0xc4c7ce, roughness: 1 });
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x4b1a21, roughness: 0.9 });
  const tierMat = new THREE.MeshStandardMaterial({ color: 0x241c1e, roughness: 0.95 });

  // Proscenium wall, gilded arch trim, and the fly tower above the house ceiling.
  const sideW = (houseW - openW) / 2;
  for (const s of [-1, 1]) {
    addBox(group, plaster, s * (openW / 2 + sideW / 2), houseCeiling / 2, prosZ, sideW, houseCeiling, 0.8);
    addBox(group, trim, s * (openW / 2 + 0.14), openH / 2, prosZ + 0.43, 0.28, openH, 0.08);
  }
  addBox(group, plaster, 0, (openH + houseCeiling) / 2, prosZ, openW, houseCeiling - openH, 0.8);
  addBox(group, trim, 0, openH + 0.14, prosZ + 0.43, openW + 0.56, 0.28, 0.08);
  addBox(group, plaster, 0, (houseCeiling + roofY + 1) / 2, prosZ, stageHouseW, roofY + 1 - houseCeiling, 0.8);

  // House tabs flown out and gathered at the sides, under a matching valance.
  for (const s of [-1, 1]) {
    const tab = pleatedDrape(1.4, openH, houseRed, 0.12);
    tab.position.set(s * (openW / 2 - 0.7), openH / 2, prosZ - 0.5);
    group.add(tab);
  }
  const valance = pleatedDrape(openW, 1.0, houseRed, 0.06);
  valance.position.set(0, openH - 0.5, prosZ - 0.42);
  group.add(valance);

  // Stage house walls and the fly grid the electrics hang from.
  const towerH = roofY + 1;
  for (const s of [-1, 1]) {
    addBox(group, plaster, s * (stageHouseW / 2), towerH / 2, (prosZ + backZ) / 2, 0.6, towerH, prosZ - backZ);
  }
  addBox(group, plaster, 0, towerH / 2, backZ, stageHouseW, towerH, 0.6);
  for (let z = backZ + 0.6; z < prosZ - 0.4; z += 0.6) {
    addBox(group, mats.darkSteel, 0, roofY, z, stageHouseW - 0.8, 0.1, 0.1);
  }

  // Black legs and borders mask the wings and the flies between the electrics.
  for (let z = prosZ - 2.2; z > -stageDepth / 2 + 1.2; z -= 2.6) {
    for (const s of [-1, 1]) {
      const leg = pleatedDrape(1.8, openH + 1.4, velour, 0.08);
      leg.position.set(s * (openW / 2 + 0.6), (openH + 1.4) / 2, z);
      group.add(leg);
    }
    const border = pleatedDrape(openW + 3, 1.6, velour, 0.05);
    border.position.set(0, openH + 1.2, z - 0.25);
    group.add(border);
  }

  // Cyclorama with a black ground row along its base.
  const cycZ = -stageDepth / 2 + 0.45;
  const cyc = new THREE.Mesh(new THREE.PlaneGeometry(openW + 3, 9.5), cyclorama);
  cyc.position.set(0, stageHeight + 4.75, cycZ);
  group.add(cyc);
  addBox(group, velour, 0, stageHeight + 0.25, cycZ + 0.6, openW + 3, 0.5, 0.1);

  // Orchestra-pit rail, then a raked stalls split by two aisles into three banks.
  addBox(group, plaster, 0, 0.5, front + 2.1, houseW - 2, 1.0, 0.25);
  const rows = 14,
    pitch = 0.95,
    rise = 0.17,
    firstZ = front + 3.2,
    seatW = 0.52;
  const halfUsable = houseW / 2 - 1.3; // side aisles along the walls
  const aisleX = halfUsable * 0.38;
  const seats: SeatSlot[] = [];
  for (let r = 0; r < rows; r++) {
    const y = r * rise,
      z = firstZ + r * pitch;
    if (y > 0) addBox(group, tierMat, 0, y / 2, z, houseW - 0.6, y, pitch);
    for (let x = -halfUsable + seatW / 2; x <= halfUsable - seatW / 2 + 1e-6; x += seatW) {
      if (Math.abs(Math.abs(x) - aisleX) < 0.6) continue;
      addBox(group, seatMat, x, y + 0.42, z, seatW - 0.05, 0.1, 0.46);
      addBox(group, seatMat, x, y + 0.72, z + 0.26, seatW - 0.05, 0.6, 0.08);
      seats.push({ x, y, z: z + 0.05 });
    }
    for (const s of [-1, 1]) addBox(group, houseLamp, s * aisleX, y + 0.06, z - 0.42, 0.06, 0.03, 0.06);
  }

  // House shell: side walls with sconces, rear wall with the control-booth window, ceiling.
  const rearZ = firstZ + rows * pitch + 2.0;
  for (const s of [-1, 1]) {
    addBox(group, plaster, s * (houseW / 2), houseCeiling / 2, (prosZ + rearZ) / 2, 0.6, houseCeiling, rearZ - prosZ);
    for (let z = prosZ + 3; z < rearZ - 1.5; z += 3.5) {
      addBox(group, houseLamp, s * (houseW / 2 - 0.32), 3.4, z, 0.06, 0.35, 0.22);
    }
    // FOH box-boom pipes on the side walls.
    addBox(group, mats.darkSteel, s * (houseW / 2 - 0.6), 4.2, prosZ + 2.6, 0.06, 5.5, 0.06);
  }
  addBox(group, plaster, 0, houseCeiling / 2, rearZ, houseW, houseCeiling, 0.6);
  const boothGlass = new THREE.MeshBasicMaterial({ color: 0x1d3550 });
  practicals.push(boothGlass);
  addBox(group, boothGlass, 0, 4.6, rearZ - 0.32, 4, 0.9, 0.04);
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(houseW, rearZ - prosZ), plaster);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(0, houseCeiling, (prosZ + rearZ) / 2);
  group.add(ceiling);

  // Exit signs stay lit through blackouts.
  const exitSign = new THREE.MeshBasicMaterial({ color: 0x2bd46b });
  for (const s of [-1, 1]) {
    addBox(group, exitSign, s * (houseW / 2 - 1.6), 2.6, rearZ - 0.33, 0.6, 0.22, 0.04);
    addBox(group, exitSign, s * (houseW / 2 - 0.33), 2.6, prosZ + 1.6, 0.04, 0.22, 0.6);
  }

  return { room: { halfWidth: houseW / 2, rearZ, ceilingY: houseCeiling }, seats };
}

/**
 * A ~300-capacity club: black box room under a low soffit with unistrut and ductwork,
 * a back bar along one wall, a front-of-house mix riser and a standing floor.
 */
function buildClubRoom(
  group: THREE.Group,
  mats: SharedMaterials,
  practicals: THREE.MeshBasicMaterial[],
  stageWidth: number,
  stageDepth: number,
  roofY: number,
): { room: VenueRoom; floor: { minX: number; maxX: number; minZ: number; maxZ: number } } {
  const front = stageDepth / 2;
  const halfW = Math.max(7.5, stageWidth / 2 + 4.5);
  const backZ = -stageDepth / 2 - 0.9;
  const rearZ = front + 19;
  const wallH = roofY + 0.4;

  const paint = new THREE.MeshStandardMaterial({ color: 0x17181c, roughness: 0.9 });
  const velour = new THREE.MeshStandardMaterial({ color: 0x111014, roughness: 0.98 });
  const galvanised = new THREE.MeshStandardMaterial({ color: 0x5d6168, roughness: 0.45, metalness: 0.6 });
  const barWood = new THREE.MeshStandardMaterial({ color: 0x2e211a, roughness: 0.7 });
  const barTop = new THREE.MeshStandardMaterial({ color: 0x0f0f11, roughness: 0.3 });

  for (const s of [-1, 1]) addBox(group, paint, s * halfW, wallH / 2, (backZ + rearZ) / 2, 0.4, wallH, rearZ - backZ);
  addBox(group, paint, 0, wallH / 2, backZ, 2 * halfW, wallH, 0.4);
  addBox(group, paint, 0, wallH / 2, rearZ, 2 * halfW, wallH, 0.4);
  const soffit = new THREE.Mesh(new THREE.PlaneGeometry(2 * halfW, rearZ - backZ), paint);
  soffit.rotation.x = Math.PI / 2;
  soffit.position.set(0, roofY + 0.35, (backZ + rearZ) / 2);
  group.add(soffit);

  // Unistrut grid and two runs of spiral duct under the soffit.
  for (let x = -halfW + 1; x <= halfW - 1; x += 2) {
    addBox(group, mats.darkSteel, x, roofY - 0.02, (backZ + rearZ) / 2, 0.04, 0.04, rearZ - backZ - 1);
  }
  for (let z = backZ + 1.5; z < rearZ - 1; z += 3) addBox(group, mats.darkSteel, 0, roofY - 0.06, z, 2 * halfW - 1, 0.04, 0.04);
  for (const s of [-1, 1]) {
    const duct = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, rearZ - backZ - 2, 14, 1), galvanised);
    duct.rotation.x = Math.PI / 2;
    duct.position.set(s * (halfW - 1.4), roofY - 0.1, (backZ + rearZ) / 2);
    group.add(duct);
  }

  // Black velour upstage of the deck.
  const drape = pleatedDrape(2 * halfW - 0.8, roofY, velour, 0.1);
  drape.position.set(0, roofY / 2, backZ + 0.35);
  group.add(drape);

  // Back bar along the house-right wall: counter with LED lip, backlit shelves, neon.
  const barX = -halfW + 1.35,
    barZ = front + 10;
  addBox(group, barWood, barX, 0.55, barZ, 0.7, 1.1, 8);
  addBox(group, barTop, barX, 1.12, barZ, 0.8, 0.05, 8.1);
  const barGlow = new THREE.MeshBasicMaterial({ color: 0xff8a3d });
  const bottleGlow = new THREE.MeshBasicMaterial({ color: 0x7fb6c4 });
  practicals.push(barGlow, bottleGlow);
  addBox(group, barGlow, barX + 0.37, 1.0, barZ, 0.03, 0.05, 8);
  for (let level = 0; level < 3; level++) {
    addBox(group, barTop, -halfW + 0.42, 1.3 + level * 0.45, barZ, 0.3, 0.035, 7);
    for (let k = 0; k < 14; k++) {
      addBox(group, bottleGlow, -halfW + 0.42, 1.43 + level * 0.45, barZ - 3.25 + k * 0.5, 0.07, 0.22, 0.07);
    }
  }
  const neon = new THREE.MeshBasicMaterial({ color: 0xff3aa8 });
  const neonX = -halfW + 0.3;
  addBox(group, neon, neonX, 3.5, barZ, 0.03, 0.04, 3.0);
  addBox(group, neon, neonX, 2.7, barZ, 0.03, 0.04, 3.0);
  for (const dz of [-1.5, 1.5]) addBox(group, neon, neonX, 3.1, barZ + dz, 0.03, 0.8, 0.04);

  // Front-of-house mix position on a low riser with a rail.
  const fohZ = front + 13.6;
  addBox(group, paint, 0, 0.2, fohZ + 0.4, 3.2, 0.4, 2.2);
  addBox(group, barWood, 0, 0.85, fohZ, 2.2, 0.9, 0.8);
  const consoleGlow = new THREE.MeshBasicMaterial({ color: 0x3d7bd9 });
  practicals.push(consoleGlow);
  addBox(group, consoleGlow, 0, 1.31, fohZ, 1.9, 0.02, 0.5);
  addBox(group, mats.darkSteel, 0, 1.2, fohZ - 0.75, 3.2, 0.05, 0.05);

  for (const s of [-1, 1]) addBox(group, paint, s * (halfW - 2.6), roofY / 2, front + 7, 0.5, roofY, 0.5);
  const exitSign = new THREE.MeshBasicMaterial({ color: 0x2bd46b });
  for (const s of [-1, 1]) addBox(group, exitSign, s * (halfW - 1.4), 2.4, rearZ - 0.23, 0.6, 0.22, 0.04);

  return {
    room: { halfWidth: halfW, rearZ, ceilingY: roofY },
    floor: { minX: -halfW + 2.4, maxX: halfW - 1.0, minZ: front + 0.9, maxZ: front + 12.2 },
  };
}

/**
 * Venue architecture (Arena / Warehouse / Festival / Theatre / Club) + Instanced Animated Crowd
 */
export function buildVenueArchitecture(
  venue: VenueType,
  crowdDensity: number,
  mats: SharedMaterials,
  stageWidth = 22,
  stageDepth = 11,
  stageHeight = 1.8,
): {
  group: THREE.Group;
  crowdMesh: THREE.InstancedMesh | null;
  practicals: (THREE.MeshBasicMaterial | THREE.PointsMaterial)[];
  crowdBaseTransforms: { x: number; y: number; z: number; scaleY: number; phase: number; rotY: number }[];
  roofY: number;
  room: VenueRoom | null;
  seated: boolean;
} {
  const group = new THREE.Group();
  const roofY = VENUE_ROOF[venue];
  const practicals: (THREE.MeshBasicMaterial | THREE.PointsMaterial)[] = [];
  let room: VenueRoom | null = null;
  let seats: SeatSlot[] | null = null;
  let standingFloor: { minX: number; maxX: number; minZ: number; maxZ: number } | null = null;

  // Vast dark arena / festival floor with subtle specular bounce for stage lights & lasers!
  const floorMat = new THREE.MeshStandardMaterial({
    color: venue === 'festival' ? 0x292a25 : venue === 'theatre' ? 0x2a2124 : venue === 'club' ? 0x2a2b2e : 0x33363c,
    roughness: venue === 'warehouse' ? 0.46 : venue === 'club' ? 0.32 : venue === 'theatre' ? 0.95 : 0.67,
    metalness: 0.08,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(140, 140), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0;
  group.add(floor);

  const houseLamp = new THREE.MeshBasicMaterial({ color: 0xaa805b });
  practicals.push(houseLamp);
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x36404c, roughness: 0.85 });
  if (venue === 'theatre') {
    ({ room, seats } = buildTheatreHouse(group, mats, practicals as THREE.MeshBasicMaterial[], houseLamp,
      stageWidth, stageDepth, stageHeight, roofY));
  } else if (venue === 'club') {
    ({ room, floor: standingFloor } = buildClubRoom(group, mats, practicals as THREE.MeshBasicMaterial[],
      stageWidth, stageDepth, roofY));
  } else if (venue === 'arena' || venue === 'warehouse') {
    const hallW = venue === 'warehouse' ? 28 : 54;
    const hallD = venue === 'warehouse' ? 46 : 78;

    // Overhead structural roof rigging grid (where the chain hoist motors hang from!)
    const beamMat = mats.darkSteel;
    for (let z = -12; z <= 18; z += 5) {
      const crossBeam = new THREE.Mesh(new THREE.BoxGeometry(hallW, 0.42, 0.42), beamMat);
      crossBeam.position.set(0, roofY, z);
      group.add(crossBeam);
    }
    for (let x = -hallW / 2 + 4; x <= hallW / 2 - 4; x += 6) {
      const longBeam = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.36, 36), beamMat);
      longBeam.position.set(x, roofY + 0.35, 3);
      group.add(longBeam);
    }

    // Dark ceiling shell
    const ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(hallW + 6, hallD),
      new THREE.MeshStandardMaterial({ color: 0x242831, roughness: 0.9 })
    );
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(0, roofY + 1.2, 12);
    group.add(ceiling);

    // Side structural columns & dark walls
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x242932, roughness: 0.87 });
    const warehouseGlass = new THREE.MeshBasicMaterial({ color: 0x182b39 });
    practicals.push(warehouseGlass);
    for (const side of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(0.6, roofY + 2, hallD), wallMat);
      wall.position.set(side * (hallW / 2), (roofY + 2) / 2, 12);
      group.add(wall);

      for (let z = -14; z <= 38; z += 7.5) {
        if (Math.abs(z - 12) >= hallD / 2) continue;
        const col = new THREE.Mesh(new THREE.BoxGeometry(0.75, roofY + 1, 0.75), mats.darkSteel);
        col.position.set(side * (hallW / 2 - 0.5), roofY / 2, z);
        group.add(col);
        if (venue === 'warehouse') {
          const x = side * (hallW / 2 - 0.35);
          for (let pane = 0; pane < 5; pane++) {
            addBox(group, warehouseGlass, x, roofY * 0.68, z + (pane - 2) * 1.05, 0.05, 1.2, 0.96);
          }
          addBox(group, wallMat, x - side * 0.05, roofY * 0.68, z, 0.07, 0.07, 5.2);
        }
      }

      // Arena tiered side bleachers in the shadows
      if (venue === 'arena') {
        for (let tier = 0; tier < 5; tier++) {
          const edgeX = side * (hallW / 2 - 1.5 - (4 - tier) * 1.4);
          const top = 0.85 + tier * 0.86;
          addBox(group, wallMat, edgeX, top / 2, 22, 1.46, top, 44);
          // Low marker lights follow the aisles between seat banks.
          for (let bank = 0; bank < 4; bank++) {
            const z = 5.5 + bank * 11;
            addBox(group, seatMat, edgeX, top + 0.25, z, 0.58, 0.14, 9.55);
            addBox(group, seatMat, edgeX + side * 0.26, top + 0.44, z, 0.10, 0.4, 9.55);
            addBox(group, houseLamp, edgeX - side * 0.74, top - 0.13, z - 5.15, 0.03, 0.045, 0.34);
          }
          if (tier === 4) {
            addBox(group, mats.darkSteel, edgeX + side * 0.68, top + 1.06, 22, 0.05, 0.05, 44);
            for (let z = 0; z <= 44; z += 2.75) {
              addBox(group, mats.darkSteel, edgeX + side * 0.68, top + 0.52, z, 0.045, 1.05, 0.045);
            }
          }
        }
      }
    }

    // Back arena wall behind stage & far rear FOH wall
    const backStageWall = new THREE.Mesh(new THREE.BoxGeometry(hallW, roofY + 2, 0.6), wallMat);
    backStageWall.position.set(0, (roofY + 2) / 2, -16);
    group.add(backStageWall);
    // Pleated velour behind the show catches spill across the folds as the desk changes color.
    const curtainGeo = new THREE.PlaneGeometry(hallW - 3.0, roofY - 1.0, Math.round(hallW * 6), 1);
    const folds = curtainGeo.getAttribute('position');
    for (let i = 0; i < folds.count; i++) {
      const x = folds.getX(i);
      folds.setZ(i, Math.cos(x * 5.0 + 0.2 * Math.sin(x * 1.4)) * 0.14);
    }
    curtainGeo.computeVertexNormals();
    const drape = new THREE.Mesh(curtainGeo, new THREE.MeshStandardMaterial({color: 0x302b32, roughness: 0.97}));
    drape.position.set(0, (roofY - 1.0) / 2, -14.9);
    group.add(drape);
  } else {
    // Outdoor Festival Mega-Structure: giant truss goalposts + open night sky!
    const towerX = stageWidth / 2 + 3.2;
    const rearZ = -stageDepth / 2;
    const frontZ = stageDepth / 2 - 0.4;
    const centerZ = (frontZ + rearZ) / 2;
    const canopyDepth = frontZ - rearZ + 0.9;
    for (const sx of [-towerX, towerX]) {
      for (const sz of [rearZ, frontZ]) {
        const tower = buildTrussGeometry('box', roofY, mats).group;
        tower.scale.set(1, 1.7, 1.7);
        tower.rotation.z = Math.PI / 2;
        tower.position.set(sx, roofY / 2, sz);
        group.add(tower);
      }
      const sideRoof = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, canopyDepth), mats.darkSteel);
      sideRoof.position.set(sx, roofY, centerZ);
      group.add(sideRoof);
    }
    for (const sz of [rearZ, centerZ, frontZ]) {
      const span = buildTrussGeometry('box', 2 * towerX, mats).group;
      span.scale.set(1, 1.7, 1.7);
      span.position.set(0, roofY, sz);
      group.add(span);
    }
    const canopy = new THREE.Mesh(new THREE.PlaneGeometry(2 * towerX + 1, canopyDepth),
      new THREE.MeshStandardMaterial({ color: 0x333945, roughness: 0.88 }));
    canopy.rotation.x = Math.PI / 2;
    canopy.position.set(0, roofY + 0.54, centerZ);
    group.add(canopy);
    // Starry festival night sky points
    const starPositions: number[] = [];
    for (let i = 0; i < 650; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 0.44;
      const r = 95;
      starPositions.push(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi) + 6,
        r * Math.sin(phi) * Math.sin(theta)
      );
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3));
    const stars = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({ color: 0xbcd4ff, size: 0.35, transparent: true, opacity: 0.55 })
    );
    group.add(stars);
    practicals.push(stars.material);
  }

  // Front-of-stage crowd barricade fence (concert venues; theatres and clubs have none)
  const barricadeLen = stageWidth + (venue === 'warehouse' ? 2 : 6);
  const barricadeZ = stageDepth / 2 + 2.4;
  if (!room) {
    const barTop = new THREE.Mesh(new THREE.BoxGeometry(barricadeLen, 0.1, 0.14), mats.darkSteel);
    barTop.position.set(0, 1.12, barricadeZ);
    group.add(barTop);
    const postGaps = Math.min(MAX_BARRICADE_BAYS, Math.floor(barricadeLen / 2.2));
    const postSpacing = Math.max(2.2, barricadeLen / MAX_BARRICADE_BAYS);
    for (let i = 0; i <= postGaps; i++) {
      const x = -barricadeLen / 2 + i * postSpacing;
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.12, 0.45), mats.darkSteel);
      post.position.set(x, 0.56, barricadeZ);
      group.add(post);
    }
  }

  batchHardware(group);

  // Instanced crowd: standing on the floor, or seated in a theatre's stalls.
  const density = THREE.MathUtils.clamp(crowdDensity, 0, 1);
  const maxCrowd = Math.floor((seats ? seats.length : standingFloor ? 300 : 680) * density);
  let crowdMesh: THREE.InstancedMesh | null = null;
  const crowdBaseTransforms: { x: number; y: number; z: number; scaleY: number; phase: number; rotY: number }[] = [];

  if (maxCrowd > 0) {
    const personGeo = crowdGeometry();
    const personMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.90, metalness: 0.02,
    });
    crowdMesh = new THREE.InstancedMesh(personGeo, personMat, maxCrowd);
    crowdMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const dummy = new THREE.Mesh(personGeo, personMat);
    const colors = [0x5c6579, 0x5e5156, 0x87939e, 0x858079, 0x666e62, 0x755d64, 0x688491];
    const phoneCount = seats ? 0 : Math.floor(maxCrowd * 0.09);
    // A feathered contact patch anchors feet to the floor even without shadow maps.
    const footprint = new THREE.CircleGeometry(1, 10);
    footprint.rotateX(-Math.PI / 2).scale(0.42, 1, 0.32).translate(0, 0.012, 0);
    const opacity = new Float32Array(footprint.attributes.position.count * 4);
    opacity[3] = 0.68;
    footprint.setAttribute('color', new THREE.BufferAttribute(opacity, 4));
    const shadowMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false });
    const footprints = new THREE.InstancedMesh(footprint, shadowMat, maxCrowd);
    let seed = 249057;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    // A theatre fills a random selection of its seats; density is the house's occupancy.
    const seatOrder = seats ? seats.map((_, i) => i) : [];
    for (let i = seatOrder.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [seatOrder[i], seatOrder[j]] = [seatOrder[j], seatOrder[i]];
    }

    for (let i = 0; i < maxCrowd; i++) {
      let x: number,
        y = 0,
        z: number;
      if (seats) {
        ({ x, y, z } = seats[seatOrder[i]]);
      } else {
        // Scatter into distinct floor spaces. Increasing density fills gaps in the same crowd.
        const cell = (i * 229) % 713;
        const row = (Math.floor(cell / 31) + 0.18 + random() * 0.64) / 23;
        const column = (cell % 31 + 0.22 + random() * 0.56) / 31;
        if (standingFloor) {
          z = standingFloor.minZ + row * (standingFloor.maxZ - standingFloor.minZ);
          x = standingFloor.minX + column * (standingFloor.maxX - standingFloor.minX);
        } else {
          z = barricadeZ + 0.6 + row * (15 + 8 * row);
          const maxX = venue === 'warehouse' ? 9.2 + 2 * row : 14.0 + 4 * row;
          x = (column * 2 - 1) * maxX;
        }
      }
      // Seated figures are scaled so heads sit at seated eye height above the cushion.
      const scaleY = seats ? 0.68 + random() * 0.06 : 0.88 + random() * 0.24;
      const phase = random() * Math.PI * 2;
      const rotY = (seats ? Math.atan2(-x * 0.3, -z) : Math.atan2(-x, -z)) + (random() - 0.5) * (seats ? 0.12 : 0.45);
      const pose = seats ? 0 : random();
      dummy.morphTargetInfluences![0] = i < phoneCount || (pose > 0.64 && pose < 0.85) ? 1 : 0;
      dummy.morphTargetInfluences![1] = i >= phoneCount && pose >= 0.85 ? 1 : 0;
      crowdMesh.setMorphAt(i, dummy);
      crowdMesh.setColorAt(i, new THREE.Color(colors[Math.floor(random() * colors.length)]));

      crowdBaseTransforms.push({ x, y, z, scaleY, phase, rotY });
      dummy.position.set(x, y, z);
      dummy.scale.set(1, scaleY, 1);
      dummy.rotation.set(0, rotY, 0);
      dummy.updateMatrix();
      crowdMesh.setMatrixAt(i, dummy.matrix);
      footprints.setMatrixAt(i, dummy.matrix);
    }
    crowdMesh.morphTexture!.needsUpdate = true;
    crowdMesh.instanceMatrix.needsUpdate = true;
    group.add(footprints, crowdMesh);

    // Recording phones share their owner's animated matrix; only the first rows of
    // the buffer are drawn, with owners already scattered throughout the room.
    if (phoneCount > 0) {
      const screen = new THREE.PlaneGeometry(0.073, 0.13);
      screen.rotateY(Math.PI).translate(0.37, 1.90, 0.145);
      const screenMat = new THREE.MeshBasicMaterial({ color: 0x94a9c6 });
      practicals.push(screenMat);
      const phones = new THREE.InstancedMesh(screen, screenMat, phoneCount);
      phones.instanceMatrix = crowdMesh.instanceMatrix;
      group.add(phones);
    }
  }

  return { group, practicals, crowdMesh, crowdBaseTransforms, roofY, room, seated: !!seats };
}
