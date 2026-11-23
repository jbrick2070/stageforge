import * as THREE from 'three';

interface Puff {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  lifetime: number;
  size: number;
  growth: number;
  rotation: number;
  spin: number;
}

// Bake a density field once. Each puff rotates, expands and fades independently.
function makeVaporTexture(): THREE.DataTexture {
  const size = 128;
  const pixels = new Uint8Array(size * size * 4);
  const lattice = new Float32Array(64 * 64);
  let seed = 721526;
  for (let i = 0; i < lattice.length; i++) {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    lattice[i] = seed / 4294967296;
  }
  const sample = (x: number, y: number) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = THREE.MathUtils.smoothstep(x - ix, 0, 1);
    const fy = THREE.MathUtils.smoothstep(y - iy, 0, 1);
    const a = (iy & 63) * 64, b = ((iy + 1) & 63) * 64;
    return THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(lattice[a + (ix & 63)], lattice[a + ((ix + 1) & 63)], fx),
      THREE.MathUtils.lerp(lattice[b + (ix & 63)], lattice[b + ((ix + 1) & 63)], fx), fy
    );
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x + 0.5) / size, ny = (y + 0.5) / size;
      const r = Math.hypot(2 * nx - 1, 2 * ny - 1);
      const broad = sample(12 + 4 * nx, 5 + 4 * ny);
      const mid = sample(9 * nx + broad, 9 * ny + 2 * broad);
      const fine = sample(23 * nx, 23 * ny);
      const turbulence = 0.54 * broad + 0.33 * mid + 0.13 * fine;
      const falloff = THREE.MathUtils.smoothstep(1 - r + (turbulence - 0.5) * 0.64, 0.14, 0.65);
      const shade = Math.round(255 * (0.62 + 0.38 * turbulence));
      const i = (y * size + x) * 4;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = shade;
      pixels[i + 3] = Math.round(255 * falloff * (0.13 + 0.84 * turbulence));
    }
  }
  const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

// Camera-facing quads keep a world-space diameter even at close camera presets,
// where hardware point-size limits would otherwise shrink the immediate plume.
class VaporBatch {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  readonly color = new THREE.Color();
  private centers: THREE.InstancedBufferAttribute;
  private shapes: THREE.InstancedBufferAttribute;

  constructor(capacity: number, texture: THREE.Texture, aspect: number) {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ], 3));
    this.centers = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.shapes = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('center', this.centers);
    geometry.setAttribute('shape', this.shapes);
    geometry.instanceCount = 0;
    const material = new THREE.ShaderMaterial({
      uniforms: { vapor: { value: texture }, tint: { value: this.color }, aspect: { value: aspect } },
      vertexShader: `
        attribute vec3 center, shape;
        uniform float aspect;
        varying vec2 texUv;
        varying float density;
        void main() {
          texUv = position.xy + 0.5;
          density = shape.z;
          vec2 offset = position.xy * vec2(aspect, 1.0) * shape.x;
          float c = cos(shape.y), s = sin(shape.y);
          vec4 eye = modelViewMatrix * vec4(center, 1.0);
          eye.xy += mat2(c, s, -s, c) * offset;
          gl_Position = projectionMatrix * eye;
        }
      `,
      fragmentShader: `
        uniform sampler2D vapor;
        uniform vec3 tint;
        varying vec2 texUv;
        varying float density;
        void main() {
          vec4 cloud = texture2D(vapor, texUv);
          float alpha = density * cloud.a;
          if (alpha < 0.001) discard;
          gl_FragColor = vec4(tint * cloud.r, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
  }

  write(i: number, x: number, y: number, z: number, size: number, rotation: number, opacity: number) {
    this.centers.setXYZ(i, x, y, z);
    this.shapes.setXYZ(i, size, rotation, opacity);
  }

  finish(count: number) {
    this.mesh.geometry.instanceCount = count;
    this.mesh.visible = count > 0;
    if (!count) return;
    this.centers.addUpdateRange(0, count * 3);
    this.shapes.addUpdateRange(0, count * 3);
    this.centers.needsUpdate = true;
    this.shapes.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

export class AtmosphericParticles {
  readonly group = new THREE.Group();
  private texture = makeVaporTexture();
  private smoke = new VaporBatch(260, this.texture, 1.18);
  private cryo = new VaporBatch(420, this.texture, 0.88);
  private haze = new VaporBatch(36, this.texture, 1.7);
  private smokePuffs: Puff[] = [];
  private cryoPuffs: Puff[] = [];
  private smokeEmitters: THREE.Vector3[] = [];
  private co2Emitters: THREE.Vector3[] = [];
  private smokeRemainder = 0;
  private cryoRemainder = 0;
  private hazeOrigins = Array.from({ length: 36 }, () => ({
    x: (Math.random() - 0.5) * 32, y: 1.8 + Math.random() * 10,
    z: -6 + Math.random() * 22, seed: Math.random() * Math.PI * 2,
  }));

  constructor() {
    this.haze.mesh.renderOrder = -1;
    this.group.add(this.haze.mesh, this.smoke.mesh, this.cryo.mesh);
  }

  setEmitters(smokeEmitters: THREE.Vector3[], co2Emitters: THREE.Vector3[]) {
    this.smokeEmitters = smokeEmitters;
    this.co2Emitters = co2Emitters;
    this.smokePuffs.length = this.cryoPuffs.length = 0;
    this.smokeRemainder = this.cryoRemainder = 0;
    this.smoke.finish(0);
    this.cryo.finish(0);
  }

  update(dt: number, time: number, hazeLevel: number, smokeOutput: number, co2Active: boolean, tint: THREE.Color, stageLightIntensity: number) {
    const power = THREE.MathUtils.clamp(stageLightIntensity, 0, 1.5);
    this.smoke.color.setHex(0x617183).lerp(tint, 0.22).multiplyScalar(0.025 + power * 0.88);
    this.cryo.color.setHex(0xcadbec).lerp(tint, 0.15).multiplyScalar(0.018 + power * 0.68);
    this.haze.color.setHex(0x425162).lerp(tint, 0.16).multiplyScalar(power);

    if (hazeLevel > 0.001 && power > 0.001) {
      this.hazeOrigins.forEach((origin, i) => {
        const phase = time * 0.095 + origin.seed;
        this.haze.write(i, origin.x + 1.6 * Math.sin(phase), origin.y + 0.45 * Math.cos(phase),
          origin.z + 0.8 * Math.sin(phase + 0.9), 6.4 + origin.seed * 0.6,
          0.15 * Math.sin(phase * 0.6), 0.044 * hazeLevel);
      });
      this.haze.finish(this.hazeOrigins.length);
    } else {
      this.haze.finish(0);
    }

    this.smokeRemainder += dt * 23 * smokeOutput * Math.min(4, this.smokeEmitters.length);
    const smokeCount = Math.floor(this.smokeRemainder);
    this.smokeRemainder -= smokeCount;
    for (let i = 0; i < smokeCount && this.smokePuffs.length < 260; i++) {
      const em = this.smokeEmitters[Math.floor(Math.random() * this.smokeEmitters.length)];
      const angle = Math.random() * Math.PI * 2;
      this.smokePuffs.push({
        x: em.x + 0.09 * Math.sin(angle), y: em.y + 0.25, z: em.z + 0.09 * Math.cos(angle),
        vx: (Math.random() - 0.5) * 0.85, vy: 0.6 + Math.random() * 0.7, vz: 1.15 + Math.random() * 1.1,
        age: 0, lifetime: 2.7 + Math.random() * 2.0, size: 0.42 + Math.random() * 0.18,
        growth: 0.93 + Math.random() * 0.46, rotation: angle, spin: (Math.random() - 0.5) * 0.48,
      });
    }

    if (co2Active) this.cryoRemainder += dt * 72 * Math.min(6, this.co2Emitters.length);
    const cryoCount = Math.floor(this.cryoRemainder);
    this.cryoRemainder -= cryoCount;
    for (let i = 0; i < cryoCount && this.cryoPuffs.length < 420; i++) {
      const em = this.co2Emitters[Math.floor(Math.random() * this.co2Emitters.length)];
      const angle = Math.random() * Math.PI * 2;
      const spread = 0.22 + Math.random() * 0.72;
      this.cryoPuffs.push({
        x: em.x + 0.055 * Math.sin(angle), y: em.y + 0.12, z: em.z + 0.055 * Math.cos(angle),
        vx: Math.sin(angle) * spread, vy: 11.0 + Math.random() * 4.6, vz: Math.cos(angle) * spread + 0.22,
        age: 0, lifetime: 0.78 + Math.random() * 0.52, size: 0.25 + Math.random() * 0.16,
        growth: 1.3 + Math.random() * 1.25, rotation: angle, spin: (Math.random() - 0.5) * 1.0,
      });
    }

    this.advance(this.smokePuffs, this.smoke, dt, time, false);
    this.advance(this.cryoPuffs, this.cryo, dt, time, true);
  }

  private advance(puffs: Puff[], batch: VaporBatch, dt: number, time: number, cryo: boolean) {
    let live = 0;
    const drag = Math.exp(-dt * (cryo ? 1.65 : 0.46));
    for (const puff of puffs) {
      puff.age += dt;
      if (puff.age >= puff.lifetime) continue;
      const age = puff.age / puff.lifetime;
      puff.vy *= drag;
      puff.vz *= cryo ? 1 : drag;
      const curl = Math.sin(puff.y * 0.95 + puff.rotation + time * 0.62) * age;
      puff.x += (puff.vx + curl * (cryo ? 0.68 : 0.45)) * dt;
      puff.y += (puff.vy + (cryo ? -0.28 : 0.45) * age) * dt;
      puff.z += puff.vz * dt;
      const envelope = THREE.MathUtils.smoothstep(age, 0, 0.05) * (1 - THREE.MathUtils.smoothstep(age, 0.19, 1));
      const diameter = puff.size + puff.age * puff.growth;
      batch.write(live, puff.x, puff.y, puff.z, diameter, puff.rotation + puff.spin * puff.age,
        (cryo ? 0.72 : 0.29) * envelope);
      puffs[live++] = puff;
    }
    puffs.length = live;
    batch.finish(live);
  }

  dispose() {
    this.texture.dispose();
    this.haze.dispose();
    this.smoke.dispose();
    this.cryo.dispose();
  }
}
