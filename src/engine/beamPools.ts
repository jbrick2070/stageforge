import * as THREE from 'three';

export const MOVING_HEAD_OPTICS = {
  beam: { length: 30, nearRadius: 0.12, farRadius: 1.75 },
  wash: { length: 21, nearRadius: 0.18, farRadius: 3.8 },
} as const;

const poolVertex = /* glsl */ `
  attribute vec4 bounds;    // min XZ, max XZ on this receiver
  attribute vec3 lens, axis, tint;
  attribute vec4 optics;    // near radius, radial slope, throw, wash softness
  uniform float surfaceY;
  varying vec3 vWorld, vLens, vAxis, vTint;
  varying vec4 vOptics;
  void main() {
    vec2 horizontal = mix(bounds.xy, bounds.zw, position.xy);
    vWorld = vec3(horizontal.x, surfaceY, horizontal.y);
    vLens = lens;
    vAxis = axis;
    vOptics = optics;
    vTint = tint;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

const poolFragment = /* glsl */ `
  uniform vec2 deckHalf;
  uniform float deckHeight;
  uniform bool isFloor;
  varying vec3 vWorld, vLens, vAxis, vTint;
  varying vec4 vOptics;

  bool inDeckShadow() {
    // Only the part of the ray below deck height can meet the stage box.
    vec3 toLens = vLens - vWorld;
    float belowDeck = clamp((deckHeight - vWorld.y) / max(0.0001, toLens.y), 0.0, 1.0);
    vec2 span = toLens.xz * belowDeck;
    vec2 safeSpan = mix(vec2(0.00001), span, step(vec2(0.00001), abs(span)));
    vec2 nearT = (-deckHalf - vWorld.xz) / safeSpan;
    vec2 farT = (deckHalf - vWorld.xz) / safeSpan;
    vec2 entry = min(nearT, farT);
    vec2 exitPoint = max(nearT, farT);
    return max(0.0, max(entry.x, entry.y)) <= min(1.0, min(exitPoint.x, exitPoint.y));
  }

  void main() {
    if (isFloor && inDeckShadow()) discard;
    vec3 delta = vWorld - vLens;
    float throwDist = dot(delta, vAxis);
    if (throwDist <= 0.0 || throwDist >= vOptics.z) discard;
    float radius = vOptics.x + vOptics.y * throwDist;
    vec3 radial = delta - throwDist * vAxis;
    float r = length(radial) / radius;
    if (r >= 1.0) discard;
    float wash = vOptics.w;
    float edge = 1.0 - smoothstep(mix(0.50, 0.03, wash), 1.0, r);
    float profile = edge * mix(1.0 - 0.32 * r * r, exp2(-2.5 * r * r), wash);
    // Flux spreads over the beam cross-section. Matte flooring returns a
    // smaller share at grazing incidence, even when the aerial beam is bright.
    float incidence = clamp((vLens.y - vWorld.y) / max(length(delta), 0.01), 0.0, 1.0);
    float attenuation = 1.0 / (1.0 + 0.95 * radius * radius);
    float reachFade = 1.0 - smoothstep(vOptics.z * 0.87, vOptics.z, throwDist);
    float bounce = profile * incidence * attenuation * reachFade;
    gl_FragColor = vec4(vTint * mix(0.85, 1.30, wash), bounce);
  }
`;

class Receiver {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  count = 0;
  private attributes: {
    bounds: THREE.InstancedBufferAttribute;
    lens: THREE.InstancedBufferAttribute;
    axis: THREE.InstancedBufferAttribute;
    tint: THREE.InstancedBufferAttribute;
    optics: THREE.InstancedBufferAttribute;
  };

  constructor(capacity: number, deckHalf: THREE.Vector2, deckHeight: number, readonly floor: boolean) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
    // World XZ winding points towards +Y.
    geo.setIndex([0, 2, 1, 0, 3, 2]);
    geo.instanceCount = 0;
    const attribute = (size: number) =>
      new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size).setUsage(THREE.DynamicDrawUsage);
    this.attributes = { bounds: attribute(4), lens: attribute(3), axis: attribute(3), tint: attribute(3), optics: attribute(4) };
    for (const [name, value] of Object.entries(this.attributes)) geo.setAttribute(name, value);
    const mat = new THREE.ShaderMaterial({
      vertexShader: poolVertex,
      fragmentShader: poolFragment,
      uniforms: {
        deckHalf: { value: deckHalf }, deckHeight: { value: deckHeight },
        surfaceY: { value: (floor ? 0 : deckHeight) + 0.003 }, isFloor: { value: floor },
      },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -2;
  }

  add(x0: number, z0: number, x1: number, z1: number, origin: THREE.Vector3, direction: THREE.Vector3,
      nearRadius: number, slope: number, length: number, wash: boolean, color: THREE.Color, intensity: number) {
    const i = this.count++;
    const a = this.attributes;
    a.bounds.setXYZW(i, x0, z0, x1, z1);
    a.lens.setXYZ(i, origin.x, origin.y, origin.z);
    a.axis.setXYZ(i, direction.x, direction.y, direction.z);
    a.tint.setXYZ(i, color.r * intensity, color.g * intensity, color.b * intensity);
    a.optics.setXYZW(i, nearRadius, slope, length, wash ? 1 : 0);
  }

  finish() {
    this.mesh.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    if (this.count === 0) return;
    for (const attribute of Object.values(this.attributes)) {
      attribute.addUpdateRange(0, this.count * attribute.itemSize);
      attribute.needsUpdate = true;
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

/** Direct fixture light received on the deck and arena floor. */
export class BeamPools {
  readonly group = new THREE.Group();
  private receivers: Receiver[];
  private deckHalf: THREE.Vector2;
  private lens = new THREE.Vector3();
  private direction = new THREE.Vector3();

  constructor(private capacity: number, width: number, depth: number, private deckHeight: number) {
    this.deckHalf = new THREE.Vector2(width * 0.5, depth * 0.5);
    this.receivers = [new Receiver(capacity, this.deckHalf, deckHeight, false), new Receiver(capacity, this.deckHalf, deckHeight, true)];
    for (const receiver of this.receivers) this.group.add(receiver.mesh);
  }

  begin() {
    for (const receiver of this.receivers) receiver.count = 0;
  }

  add(beam: THREE.Object3D, type: 'wash' | 'beam', isFloor: boolean, color: THREE.Color, intensity: number) {
    if (intensity <= 0.001) return;
    const sign = isFloor ? 1 : -1;
    beam.updateWorldMatrix(true, false);
    this.lens.set(0, sign * 0.17, 0).applyMatrix4(beam.matrixWorld);
    this.direction.set(0, sign, 0).transformDirection(beam.matrixWorld);
    const wash = type === 'wash';
    const optics = MOVING_HEAD_OPTICS[type];
    const throwLength = optics.length;
    const zoom = beam.scale.x;
    const nearRadius = optics.nearRadius * zoom;
    const slope = (optics.farRadius * zoom - nearRadius) / throwLength;
    const dy = this.direction.y;
    const radialY = Math.sqrt(Math.max(0, 1 - dy * dy));

    for (const receiver of this.receivers) {
      if (receiver.count >= this.capacity) continue;
      const surfaceY = (receiver.floor ? 0 : this.deckHeight) + 0.003;
      const height = this.lens.y - surfaceY;
      if (height <= 0) continue;
      // Intersect the finite cone's lower and upper Y extents with this
      // plane to get a conservative bound, including grazing-angle beams.
      let start = 0;
      let end: number = throwLength;
      const nearY = nearRadius * radialY;
      const lowerSlope = dy - slope * radialY;
      if (lowerSlope < -1e-6) start = Math.max(start, (nearY - height) / lowerSlope);
      else if (lowerSlope > 1e-6) end = Math.min(end, (nearY - height) / lowerSlope);
      else if (height > nearY) continue;
      const upperSlope = dy + slope * radialY;
      if (upperSlope > 1e-6) start = Math.max(start, (-nearY - height) / upperSlope);
      else if (upperSlope < -1e-6) end = Math.min(end, (-nearY - height) / upperSlope);
      else if (height < -nearY) continue;
      if (end < start) continue;
      const radius = nearRadius + end * slope;
      const x0 = this.lens.x + start * this.direction.x, x1 = this.lens.x + end * this.direction.x;
      const z0 = this.lens.z + start * this.direction.z, z1 = this.lens.z + end * this.direction.z;
      const halfX = receiver.floor ? 70 : this.deckHalf.x;
      const halfZ = receiver.floor ? 70 : this.deckHalf.y;
      const left = Math.max(-halfX, Math.min(x0, x1) - radius);
      const right = Math.min(halfX, Math.max(x0, x1) + radius);
      const back = Math.max(-halfZ, Math.min(z0, z1) - radius);
      const front = Math.min(halfZ, Math.max(z0, z1) + radius);
      if (left >= right || back >= front) continue;
      if (receiver.floor && left >= -this.deckHalf.x && right <= this.deckHalf.x &&
          back >= -this.deckHalf.y && front <= this.deckHalf.y) continue;
      receiver.add(left, back, right, front, this.lens, this.direction, nearRadius, slope, throwLength, wash, color, intensity);
    }
  }

  finish() {
    for (const receiver of this.receivers) receiver.finish();
  }

  dispose() {
    this.group.removeFromParent();
    for (const receiver of this.receivers) receiver.dispose();
  }
}
