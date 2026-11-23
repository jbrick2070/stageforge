import * as THREE from 'three';

/** Fit authored hardware from the positive-Z audience side. Beam volumes do not set the framing. */
export function fitAuthoredFoh(subjects: THREE.Object3D[], screens: THREE.ShaderMaterial[],
    aspect: number, roofY: number, roomFront: number, normalFov: number) {
  const bounds = new THREE.Box3();
  const scratch = new THREE.Box3();
  for (const subject of subjects) {
    subject.updateWorldMatrix(true, true);
    subject.traverse(node => {
      if (!(node instanceof THREE.Mesh)) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      if (materials.some(m => m instanceof THREE.ShaderMaterial && !screens.includes(m))) return;
      const source = node instanceof THREE.InstancedMesh ? node : node.geometry;
      if (!source.boundingBox) source.computeBoundingBox();
      if (source.boundingBox) {
        scratch.copy(source.boundingBox).applyMatrix4(node.matrixWorld);
        if (Number.isFinite(scratch.min.lengthSq()) && Number.isFinite(scratch.max.lengthSq())) bounds.union(scratch);
      }
    });
  }
  if (bounds.isEmpty()) {
    return { target: new THREE.Vector3(0, 3, 0), position: new THREE.Vector3(0, 5, 24),
      distance: Math.hypot(2, 24), fov: normalFov, far: 220 };
  }

  const target = bounds.getCenter(new THREE.Vector3());
  const half = bounds.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  const margin = 1.12;
  const tangent = Math.tan(THREE.MathUtils.degToRad(normalFov / 2));
  const estimatedDistance = half.z + margin * Math.max(half.x / aspect, half.y) / tangent;
  // A small downward angle reveals the deck. Keep the eye under the roof on long throws.
  const pitch = THREE.MathUtils.clamp(Math.atan2(roofY - 0.9 - target.y, Math.max(4, estimatedDistance)), 0.02, 0.24);
  const sin = Math.sin(pitch), cos = Math.cos(pitch);
  const corners: { towardEye: number; extent: number }[] = [];
  for (const y of [-half.y, half.y]) {
    for (const z of [-half.z, half.z]) {
      corners.push({ towardEye: y * sin + z * cos, extent: margin * Math.max(half.x / aspect, Math.abs(y * cos - z * sin)) });
    }
  }
  const distanceFor = (tanHalfFov: number) => Math.max(4.2, (half.z + 1.5) / cos,
    ...corners.map(c => c.towardEye + Math.max(c.extent / tanHalfFov, 0.5)));
  const normalDistance = distanceFor(tangent);
  const roomDistance = (roomFront - target.z) / cos;
  // On narrow screens widen the lens before crossing the room boundary. Very deep
  // designs still need a viewpoint beyond their foremost piece of hardware.
  const distance = Math.max(distanceFor(Math.tan(THREE.MathUtils.degToRad(78 / 2))),
    Math.min(normalDistance, roomDistance));
  const fittedTangent = Math.max(tangent, ...corners.map(c => c.extent / (distance - c.towardEye)));
  const position = new THREE.Vector3(target.x, target.y + distance * sin, target.z + distance * cos);
  return { target, position, distance, fov: THREE.MathUtils.radToDeg(2 * Math.atan(fittedTangent)),
    far: Math.max(220, distance + half.length() + 30) };
}
