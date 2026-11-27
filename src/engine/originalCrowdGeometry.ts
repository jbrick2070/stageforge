import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const FIXED_COLOR = 0;
const SKIN_COLOR = 1;
const CLOTHING_COLOR = 2;

type ColorRegion = typeof FIXED_COLOR | typeof SKIN_COLOR | typeof CLOTHING_COLOR;
type AddPart = (geometry: THREE.BufferGeometry, color: number, region?: ColorRegion) => void;

export function makeFigure(addParts: (add: AddPart) => void): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add: AddPart = (geometry, color, region = FIXED_COLOR) => {
    parts.push(geometry);
    const count = geometry.getAttribute('position').count;
    const tint = new THREE.Color(color);
    const colors = new Float32Array(count * 3);
    for (let index = 0; index < count; index++) {
      tint.toArray(colors, index * 3);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const regions = new Float32Array(count).fill(region);
    geometry.setAttribute('crowdColorRegion', new THREE.BufferAttribute(regions, 1));
  };

  try {
    addParts(add);
    const geometry = mergeGeometries(parts, false);
    if (!geometry) throw new Error('Could not merge original crowd geometry.');
    return geometry;
  } finally {
    parts.forEach(part => part.dispose());
  }
}

/** Matte figure with independent skin and garment tint regions. */
export function makeOriginalHumanGeometry(): THREE.BufferGeometry {
  return makeFigure(add => {
    add(new THREE.CylinderGeometry(0.18, 0.15, 0.57, 8).scale(1, 1, 0.75).translate(0, 1.095, 0), 0xdadada, CLOTHING_COLOR);
    add(new THREE.CylinderGeometry(0.061, 0.068, 0.12, 5, 1, true).translate(0, 1.43, 0), 0xf2f2f2, SKIN_COLOR);
    add(new THREE.SphereGeometry(0.13, 8, 5).scale(0.85, 1.15, 0.95).translate(0, 1.59, 0.01), 0xf2f2f2, SKIN_COLOR);
    const hair = new THREE.SphereGeometry(0.14, 6, 4, 0, Math.PI * 2, 0, Math.PI * 0.55);
    add(hair.scale(0.92, 1.10, 1.02).rotateZ(-0.07).translate(0, 1.62, -0.01), 0x332923);
    add(new THREE.CylinderGeometry(0.015, 0.023, 0.058, 4).scale(0.75, 1, 1.4).translate(0, 1.58, 0.13), 0xbfbfbf, SKIN_COLOR);

    for (const side of [-1, 1]) {
      add(new THREE.PlaneGeometry(0.027, 0.012).rotateY(side * 0.28).translate(side * 0.048, 1.615, 0.13), 0x28262a);
      const sleeve = new THREE.CylinderGeometry(0.055, 0.045, 0.52, 5, 1, true);
      add(sleeve.rotateZ(side * 0.11).translate(side * 0.210, 1.15, 0.01), 0xc8c8c8, CLOTHING_COLOR);
      add(new THREE.BoxGeometry(0.045, 0.08, 0.035).rotateZ(side * 0.11).translate(side * 0.245, 0.88, 0.02), 0xeaeaea, SKIN_COLOR);
      const leg = new THREE.CylinderGeometry(0.082, 0.058, 0.77, 6, 1, true);
      add(leg.rotateZ(side * 0.02).translate(side * 0.091, 0.465, 0), 0xa8a8a8, CLOTHING_COLOR);
      add(new THREE.BoxGeometry(0.095, 0.09, 0.19).translate(side * 0.095, 0.045, 0.035), 0x33373a);
    }
  });
}

/** Original foxlike stage-goer with a fixed coat, vest and broad tail silhouette. */
export function makeOriginalFoxGeometry(): THREE.BufferGeometry {
  return makeFigure(add => {
    const fur = 0xb55832;
    const cream = 0xdcc4a5;
    const vest = 0x646e78;
    const pants = 0x3d4249;
    const dark = 0x282226;

    add(new THREE.CylinderGeometry(0.17, 0.14, 0.55, 8).scale(1, 1, 0.78).translate(0, 1.09, 0), vest);
    add(new THREE.CylinderGeometry(0.082, 0.09, 0.12, 6, 1, true).translate(0, 1.40, 0.02), cream);
    add(new THREE.SphereGeometry(0.125, 6, 4).scale(0.98, 1, 0.95).translate(0, 1.56, 0.01), fur);
    add(new THREE.ConeGeometry(0.057, 0.148, 4).rotateX(Math.PI / 2).translate(0, 1.53, 0.149), cream);
    add(new THREE.BoxGeometry(0.031, 0.025, 0.03).translate(0, 1.535, 0.221), dark);

    for (const side of [-1, 1]) {
      const ear = new THREE.ConeGeometry(0.052, 0.17, 4).scale(0.65, 1, 1);
      add(ear.rotateZ(side * -0.24).rotateX(-0.1).translate(side * 0.079, 1.71, 0), fur);
      const innerEar = new THREE.PlaneGeometry(0.027, 0.066);
      add(innerEar.rotateZ(side * -0.24).rotateX(0.16).translate(side * 0.081, 1.708, 0.023), cream);
      add(new THREE.PlaneGeometry(0.031, 0.014).rotateY(side * 0.35).translate(side * 0.054, 1.586, 0.109), dark);

      const sleeve = new THREE.CylinderGeometry(0.05, 0.042, 0.50, 5, 1, true);
      add(sleeve.rotateZ(side * 0.13).translate(side * 0.20, 1.14, 0.01), vest);
      add(new THREE.BoxGeometry(0.042, 0.075, 0.05).translate(side * 0.235, 0.88, 0.019), cream);
      const thigh = new THREE.CylinderGeometry(0.075, 0.055, 0.45, 5, 1, true);
      add(thigh.rotateX(0.12).translate(side * 0.084, 0.62, -0.02), pants);
      const shin = new THREE.CylinderGeometry(0.052, 0.040, 0.42, 5, 1, true);
      add(shin.rotateX(-0.12).translate(side * 0.09, 0.24, 0.015), fur);
      add(new THREE.BoxGeometry(0.075, 0.07, 0.16).translate(side * 0.09, 0.035, 0.045), dark);
    }

    add(new THREE.CylinderGeometry(0.081, 0.038, 0.23, 5).rotateX(-0.95).translate(0, 0.88, -0.179), fur);
    add(new THREE.ConeGeometry(0.076, 0.15, 5).rotateX(-1.28).translate(0, 0.962, -0.298), cream);
  });
}

export function makeOriginalMothGeometry(): THREE.BufferGeometry {
  return makeFigure(add => {
    const ruff = 0xd2d2d2;
    const body = 0x7a7a7a;
    const wings = 0x545454;
    const dark = 0x2d2d2d;

    add(new THREE.CylinderGeometry(0.09, 0.12, 0.46, 6).scale(0.88, 1, 0.85).translate(0, 0.73, -0.02), wings);
    add(new THREE.CylinderGeometry(0.14, 0.10, 0.40, 6, 1, true).scale(0.9, 1, 0.8).translate(0, 1.10, 0.01), body);
    add(new THREE.CylinderGeometry(0.106, 0.14, 0.14, 6).scale(1.1, 1, 0.9).translate(0, 1.34, 0.02), ruff);
    add(new THREE.SphereGeometry(0.115, 6, 4).scale(0.9, 1.1, 0.95).translate(0, 1.50, 0.04), body);

    for (const side of [-1, 1]) {
      const wing = new THREE.CylinderGeometry(0.096, 0.028, 0.83, 5).scale(1, 1, 0.25);
      add(wing.rotateZ(side * 0.12).rotateY(side * 0.29).translate(side * 0.085, 0.94, -0.13), wings);
      const eye = new THREE.PlaneGeometry(0.048, 0.059).rotateY(side * 0.52);
      add(eye.translate(side * 0.075, 1.515, 0.126), dark);
      const antenna = new THREE.ConeGeometry(0.025, 0.31, 3);
      add(antenna.rotateZ(side * -0.54).rotateX(0.22).translate(side * 0.10, 1.70, 0.10), ruff);

      const sleeve = new THREE.CylinderGeometry(0.039, 0.028, 0.54, 4, 1, true);
      add(sleeve.rotateZ(side * 0.13).translate(side * 0.166, 1.13, 0.01), body);
      add(new THREE.BoxGeometry(0.032, 0.09, 0.032).translate(side * 0.20, 0.851, 0.02), dark);
      const leg = new THREE.CylinderGeometry(0.045, 0.028, 0.68, 4, 1, true);
      add(leg.rotateZ(side * 0.03).translate(side * 0.08, 0.39, -0.01), body);
      add(new THREE.BoxGeometry(0.059, 0.058, 0.16).translate(side * 0.082, 0.029, 0.04), dark);
    }
  });
}

export function makeOriginalTicketTakerGeometry(): THREE.BufferGeometry {
  return makeFigure(add => {
    const light = 0xd8d8d8;
    const coat = 0x6a6a6a;
    const lapel = 0xacacac;
    const dark = 0x333333;

    add(new THREE.CylinderGeometry(0.24, 0.21, 0.62, 8).scale(1, 1, 0.86).translate(0, 0.98, 0), coat);
    add(new THREE.CylinderGeometry(0.10, 0.11, 0.10, 6, 1, true).translate(0, 1.33, 0.02), lapel);
    add(new THREE.SphereGeometry(0.125, 6, 4).scale(1.05, 1, 0.95).translate(0, 1.48, 0.02), light);
    add(new THREE.CylinderGeometry(0.13, 0.12, 0.11, 6).translate(0, 1.62, 0.02), coat);
    add(new THREE.BoxGeometry(0.16, 0.02, 0.09).rotateX(0.18).translate(0, 1.575, 0.135), dark);

    for (const side of [-1, 1]) {
      add(new THREE.PlaneGeometry(0.028, 0.015).rotateY(side * 0.31).translate(side * 0.049, 1.49, 0.134), dark);
      const collar = new THREE.BoxGeometry(0.075, 0.24, 0.025);
      add(collar.rotateZ(side * -0.32).translate(side * 0.084, 1.14, 0.168), lapel);
      const sleeve = new THREE.CylinderGeometry(0.072, 0.058, 0.48, 5, 1, true);
      add(sleeve.rotateZ(side * 0.17).translate(side * 0.238, 1.045, 0.01), coat);
      add(new THREE.BoxGeometry(0.055, 0.08, 0.05).translate(side * 0.275, 0.789, 0.02), light);

      add(new THREE.CylinderGeometry(0.095, 0.075, 0.68, 5, 1, true).translate(side * 0.11, 0.39, 0), coat);
      add(new THREE.BoxGeometry(0.105, 0.108, 0.20).translate(side * 0.11, 0.054, 0.035), dark);
    }
    add(new THREE.BoxGeometry(0.046, 0.081, 0.016).rotateY(0.2).translate(0.278, 0.80, 0.054), light);
  });
}
