import * as THREE from 'three';
import type { StageProp } from '../types/show';

export interface ScenicPiece {
  root: THREE.Group;
  fabric: THREE.MeshStandardMaterial;
  lamps?: THREE.MeshStandardMaterial;
  air?: THREE.Object3D;
}

const tau = Math.PI * 2;
const point = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// Inflatable tubes swell between sewn panels. Section frames follow the bent centreline.
function fabricTube(curve: THREE.CatmullRomCurve3, radius: (t: number) => number, panels: number) {
  const rows = panels * 12;
  const sides = 40;
  const geo = new THREE.TubeGeometry(curve, rows, 1, sides, false);
  const positions = geo.attributes.position;
  const shades: number[] = [];
  const center = new THREE.Vector3();
  const radial = new THREE.Vector3();
  for (let row = 0; row <= rows; row++) {
    const t = row / rows;
    curve.getPointAt(t, center);
    const joint = Math.pow(Math.cos(t * panels * Math.PI), 16);
    for (let side = 0; side <= sides; side++) {
      const i = row * (sides + 1) + side;
      const rib = Math.cos(side / sides * tau * 5 + 0.22 * Math.sin(t * tau));
      radial.fromBufferAttribute(positions, i).sub(center);
      radial.multiplyScalar(radius(t) * (1 - 0.042 * joint + 0.014 * rib)).add(center);
      positions.setXYZ(i, radial.x, radial.y, radial.z);
      const shade = 1 - 0.17 * joint + 0.012 * rib;
      shades.push(shade, shade, shade);
    }
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(shades, 3));
  geo.computeVertexNormals();
  return geo;
}

function foilStar() {
  const positions: number[] = [], shades: number[] = [], triangles: number[] = [];
  const rings = 42, sectors = 150;
  for (let row = 0; row <= rings; row++) {
    const a = Math.PI * row / rings;
    const spread = Math.sin(a);
    for (let j = 0; j <= sectors; j++) {
      const angle = j / sectors * tau + Math.PI / 2;
      const petal = Math.acos(THREE.MathUtils.clamp(Math.cos(5 * (angle - Math.PI / 2)) * 0.99, -1, 1)) / Math.PI;
      const d = petal * Math.PI / 5;
      // Ray intersection with the edge connecting each outer point to its inner corner.
      const radius = 2.48 * 1.07 * Math.sin(Math.PI / 5) /
        (1.07 * Math.sin(Math.PI / 5 - d) + 2.48 * Math.sin(d));
      const seam = Math.pow(spread, 62);
      const wrinkle = Math.sin(35 * angle + 4 * a) * 0.022 * Math.pow(spread, 5);
      const r = radius * spread * (1 + wrinkle);
      positions.push(Math.cos(angle) * r, Math.sin(angle) * r,
        0.85 * Math.cos(a) * (1 - 0.32 * petal * spread) + wrinkle);
      const shade = 1 - seam * 0.27 - 0.1 * petal * spread + wrinkle;
      shades.push(shade, shade, shade);
      if (row < rings && j < sectors) {
        const i = row * (sectors + 1) + j, next = i + sectors + 1;
        triangles.push(i, next, next + 1, i, next + 1, i + 1);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(triangles);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(shades, 3));
  geo.computeVertexNormals();
  return geo;
}

function box(parent: THREE.Group, size: number[], at: number[], mat: THREE.Material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), mat);
  mesh.position.set(at[0], at[1], at[2]);
  parent.add(mesh);
}

function rod(parent: THREE.Group, a: THREE.Vector3, b: THREE.Vector3, radius: number, mat: THREE.Material) {
  const delta = b.clone().sub(a);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, delta.length(), 8), mat);
  mesh.position.copy(a).lerp(b, 0.5);
  mesh.quaternion.setFromUnitVectors(point(0, 1, 0), delta.normalize());
  parent.add(mesh);
}

export function buildScenicPiece(prop: StageProp, hardware: THREE.Material): ScenicPiece {
  const root = new THREE.Group();
  const inflatable = ['tentacle', 'arch', 'star'].includes(prop.kind);
  const fabric = new THREE.MeshStandardMaterial({
    color: prop.color, vertexColors: inflatable,
    metalness: prop.kind === 'star' ? 0.72 : 0.18,
    roughness: prop.kind === 'star' ? 0.24 : 0.39,
  });
  if (prop.kind === 'tentacle') {
    const curve = new THREE.CatmullRomCurve3([
      point(0, -0.06, 0), point(-0.27, 1.5, 0.05), point(0.04, 2.9, 0.18),
      point(1.06, 4.22, 0.16), point(1.36, 5.17, -0.12), point(0.98, 5.8, -0.16),
      point(0.48, 5.98, -0.02), point(0.23, 5.77, 0.06),
    ]);
    const radius = (t: number) => 0.012 + 0.96 * Math.pow(1 - t, 0.85);
    const air = new THREE.Group();
    air.add(new THREE.Mesh(fabricTube(curve, radius, 13), fabric));
    const cups = new THREE.InstancedMesh(new THREE.TorusGeometry(1, 0.22, 8, 18), fabric.clone(), 26);
    cups.material.vertexColors = false;
    cups.material.color.set('#e5b9a6');
    const dummy = new THREE.Object3D();
    for (let i = 0; i < 13; i++) {
      const t = 0.08 + i * 0.063;
      const tangent = curve.getTangentAt(t);
      const side = point(tangent.y, -tangent.x, 0).normalize();
      for (let line = 0; line < 2; line++) {
        const outward = side.clone().multiplyScalar(line ? -0.52 : 0.2).add(point(0, 0, 0.85)).normalize();
        dummy.position.copy(curve.getPointAt(t)).addScaledVector(outward, radius(t) * 0.97);
        dummy.quaternion.setFromUnitVectors(point(0, 0, 1), outward);
        dummy.scale.setScalar(radius(t) * 0.19);
        dummy.updateMatrix();
        cups.setMatrixAt(2 * i + line, dummy.matrix);
      }
    }
    air.add(cups);
    root.add(air);
    box(root, [1.85, 0.15, 1.85], [0, 0.075, 0], hardware);
    return { root, fabric, air };
  }
  if (prop.kind === 'arch') {
    const curve = new THREE.CatmullRomCurve3([
      point(-3.5, -0.05, 0), point(-3.45, 2.3, 0), point(-2.48, 4.0, 0),
      point(0, 4.9, 0), point(2.48, 4.0, 0), point(3.45, 2.3, 0), point(3.5, -0.05, 0),
    ]);
    const air = new THREE.Mesh(fabricTube(curve, () => 0.58, 17), fabric);
    root.add(air);
    for (const x of [-3.5, 3.5]) box(root, [1.3, 0.13, 1.3], [x, 0.065, 0], hardware);
    return { root, fabric, air };
  }
  if (prop.kind === 'star') {
    const air = new THREE.Mesh(foilStar(), fabric);
    air.position.y = 3.12;
    root.add(air);
    for (const sign of [-1, 1]) {
      box(root, [0.48, 0.15, 0.36], [sign * 1.12, 0.075, 0], hardware);
      rod(root, point(sign * 1.12, 0.15, 0), point(sign * 1.36, 1.45, 0), 0.018, hardware);
    }
    return { root, fabric, air };
  }
  if (prop.kind === 'marquee') {
    box(root, [1.45, 0.16, 1.05], [0, 0.08, 0], hardware);
    box(root, [0.84, 4.3, 0.35], [0, 2.25, 0], hardware);
    const lamps = new THREE.MeshStandardMaterial({ color: prop.color, emissive: prop.color, roughness: 0.34 });
    const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.12, 14, 9), lamps, 16);
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < 16; i++) {
      bulbs.setMatrixAt(i, matrix.makeTranslation(i % 2 ? 0.2 : -0.2, 0.48 + 0.51 * Math.floor(i / 2), 0.19));
    }
    root.add(bulbs);
    for (const x of [-0.43, 0.43]) box(root, [0.048, 4.35, 0.41], [x, 2.25, 0], fabric);
    return { root, fabric, lamps };
  }
  box(root, [4, 0.18, 2.35], [0, 0.89, 0], fabric);
  for (const x of [-1.82, 0, 1.82]) {
    for (const z of [-0.98, 0.98]) box(root, [0.085, 0.8, 0.085], [x, 0.4, z], hardware);
  }
  for (const z of [-0.98, 0.98]) {
    rod(root, point(-1.82, 0.1, z), point(0, 0.8, z), 0.035, hardware);
    rod(root, point(0, 0.8, z), point(1.82, 0.1, z), 0.035, hardware);
  }
  return { root, fabric };
}
