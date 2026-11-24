import * as THREE from 'three';
import type { LaserResolution } from '../types/show';
import {
  LASER_APERTURE_Z_M,
  LASER_BEAM_LENGTH_M,
  LASER_CONE_FAR_RADIUS_M,
  LASER_SHEET_FAR_HALF_WIDTH_M,
} from '../data/laserAim';

/** The samples around/across the projected outline determine its facets.
 * Ray count is a separate fragment-shader mask on that surface. */
export function laserGeometry(segments: LaserResolution) {
  const length = LASER_BEAM_LENGTH_M;
  const farWidth = LASER_SHEET_FAR_HALF_WIDTH_M * 2;
  const sheet = new THREE.PlaneGeometry(1, 1, segments, 24);
  const { position, uv } = sheet.attributes;
  for (let i = 0; i < position.count; i++) {
    const reach = 1 - uv.getY(i);
    const width = THREE.MathUtils.lerp(0.14, farWidth, reach);
    position.setXYZ(i, (uv.getX(i) - 0.5) * width, 0, LASER_APERTURE_Z_M + reach * length);
    uv.setY(i, reach);
  }
  const cone = new THREE.CylinderGeometry(0.08, LASER_CONE_FAR_RADIUS_M, length, segments, 20, true);
  cone.translate(0, -length / 2, 0);
  cone.rotateX(-Math.PI / 2);
  cone.translate(0, 0, LASER_APERTURE_Z_M);
  return { sheet, cone };
}
