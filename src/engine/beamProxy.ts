import * as THREE from 'three';
import type { ShaderProxy } from './renderBatcher';
import { VOLUMETRIC_BEAM_FRAG, VOLUMETRIC_BEAM_VERT } from './shaders';

/** Marker set on moving-head beam ShaderMaterials so RenderBatcher instances them. */
export const VOLUMETRIC_BEAM_VARIANT = 'volumetricBeam';

function isVolumetricBeamMaterial(material: THREE.Material): material is THREE.ShaderMaterial {
  const m = material as THREE.ShaderMaterial;
  if (!m.isShaderMaterial) return false;
  if (m.userData?.instancedVariant !== VOLUMETRIC_BEAM_VARIANT) return false;
  // Require the exact beam GLSL and order-independent additive blending (depthWrite=false),
  // because an instanced batch sorts as one object rather than per-beam.
  if (m.vertexShader !== VOLUMETRIC_BEAM_VERT || m.fragmentShader !== VOLUMETRIC_BEAM_FRAG) return false;
  if (m.blending !== THREE.AdditiveBlending || m.depthWrite) return false;
  const u = m.uniforms;
  return !!(u && u.uLensOffset && u.uColor && u.uIntensity && u.uPrism && u.uSoftness && u.uSeed && u.uHaze && u.uTime);
}

/**
 * Instanced shader proxy for moving-head volumetric beam cones.
 * Shares the same GLSL strings as the per-unit material (`INSTANCED_BEAM` define) so
 * look and shading stay identical while drawing all matching cones in one call per shape.
 * Safe to merge into one draw because volumetric beams use additive blending with depthWrite=false.
 */
export const volumetricBeamProxy: ShaderProxy = {
  name: 'Volumetric beams',
  match(material) {
    return isVolumetricBeamMaterial(material);
  },
  key(material, mesh) {
    const m = material as THREE.ShaderMaterial;
    const lensOffset = Number(m.uniforms.uLensOffset?.value ?? 0);
    return `${mesh.renderOrder}|${m.transparent ? 1 : 0}|${m.blendSrc}|${m.blendDst}|${m.blendEquation}|${m.blendSrcAlpha ?? ''}|${m.blendDstAlpha ?? ''}|${m.blendEquationAlpha ?? ''}|${m.premultipliedAlpha ? 1 : 0}|${m.side}|${m.depthTest ? 1 : 0}|${m.depthFunc}|${m.colorWrite ? 1 : 0}|${m.toneMapped ? 1 : 0}|${m.fog ? 1 : 0}|${m.dithering ? 1 : 0}|${lensOffset}`;
  },
  createMaterial(source) {
    const src = source as THREE.ShaderMaterial;
    return new THREE.ShaderMaterial({
      vertexShader: VOLUMETRIC_BEAM_VERT,
      fragmentShader: VOLUMETRIC_BEAM_FRAG,
      defines: { ...(src.defines ?? {}), INSTANCED_BEAM: '' },
      transparent: src.transparent,
      blending: src.blending,
      blendSrc: src.blendSrc,
      blendDst: src.blendDst,
      blendEquation: src.blendEquation,
      blendSrcAlpha: src.blendSrcAlpha,
      blendDstAlpha: src.blendDstAlpha,
      blendEquationAlpha: src.blendEquationAlpha,
      premultipliedAlpha: src.premultipliedAlpha,
      side: src.side,
      depthWrite: src.depthWrite,
      depthTest: src.depthTest,
      depthFunc: src.depthFunc,
      colorWrite: src.colorWrite,
      toneMapped: src.toneMapped,
      fog: src.fog,
      dithering: src.dithering,
      uniforms: {
        uLensOffset: { value: Number(src.uniforms.uLensOffset?.value ?? 0) },
        uHaze: { value: Number(src.uniforms.uHaze?.value ?? 0.78) },
        uTime: { value: Number(src.uniforms.uTime?.value ?? 0) },
      },
    });
  },
  attributes: [
    {
      name: 'instEndRadiusDelta',
      itemSize: 1,
      write(material, out, offset) {
        out[offset] = Number((material as THREE.ShaderMaterial).uniforms.uEndRadiusDelta?.value ?? 0);
      },
    },
    {
      name: 'instColor',
      itemSize: 3,
      write(material, out, offset) {
        const color = (material as THREE.ShaderMaterial).uniforms.uColor.value as THREE.Color;
        out[offset] = color.r;
        out[offset + 1] = color.g;
        out[offset + 2] = color.b;
      },
    },
    {
      name: 'instParams',
      itemSize: 4,
      write(material, out, offset) {
        const u = (material as THREE.ShaderMaterial).uniforms;
        out[offset] = Number(u.uIntensity.value);
        out[offset + 1] = Number(u.uPrism.value);
        out[offset + 2] = Number(u.uSoftness.value);
        out[offset + 3] = Number(u.uSeed.value);
      },
    },
  ],
  sharedUniforms: ['uHaze', 'uTime'],
};
