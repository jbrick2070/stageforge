import * as THREE from 'three';
import type { CrowdModelId } from '../data/crowdModels';

export interface PackedCrowdGeometry<K extends string = CrowdModelId> {
  geometry: THREE.BufferGeometry;
  vertexTexture: THREE.DataTexture;
  slots: ReadonlyMap<K, number>;
}

const ROWS_PER_MODEL = 3;
const CHANNELS = 4;

/** Give each source its own triangle corners under one common sequential index. */
export function packCrowdGeometry<K extends string>(
  sources: ReadonlyMap<K, THREE.BufferGeometry>,
  trianglesPerInstance: number,
): PackedCrowdGeometry<K> {
  const width = trianglesPerInstance * 3;
  if (!sources.size || !Number.isSafeInteger(width) || width <= 0 || width > 0xffff) {
    throw new Error('Invalid packed crowd geometry size.');
  }
  const height = sources.size * ROWS_PER_MODEL;
  const data = new Float32Array(width * height * CHANNELS);
  const slots = new Map<K, number>();
  for (const [modelId, source] of sources) {
    const slot = slots.size;
    slots.set(modelId, slot);
    const index = source.getIndex();
    if (!index || index.count % 3 !== 0 || index.count > width) {
      throw new Error(`Crowd model ${modelId} exceeds the packed triangle allocation.`);
    }
    const position = source.getAttribute('position');
    const normal = source.getAttribute('normal');
    const color = source.getAttribute('color');
    const region = source.getAttribute('crowdColorRegion');
    const rowStart = slot * ROWS_PER_MODEL * width * CHANNELS;
    const normalRow = rowStart + width * CHANNELS;
    const colorRow = normalRow + width * CHANNELS;
    for (let corner = 0; corner < index.count; corner++) {
      const vertex = index.getX(corner);
      const column = corner * CHANNELS;
      data.set([position.getX(vertex), position.getY(vertex), position.getZ(vertex), region?.getX(vertex) ?? 0], rowStart + column);
      data.set([normal.getX(vertex), normal.getY(vertex), normal.getZ(vertex)], normalRow + column);
      data.set([color.getX(vertex), color.getY(vertex), color.getZ(vertex)], colorRow + column);
    }
    // Padded corners stay at the origin, forming zero-area triangles with finite normals.
    for (let corner = index.count; corner < width; corner++) {
      data[normalRow + corner * CHANNELS + 1] = 1;
    }
  }

  const geometry = new THREE.BufferGeometry();
  const indices = Uint16Array.from({ length: width }, (_, index) => index);
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(width * 3), 3));
  // Three selects flat shading if the carrier has no normal attribute. The shader reads the real normals from the texture.
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(width * 3), 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(width * 3).fill(1), 3));
  const vertexTexture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  vertexTexture.needsUpdate = true;
  return { geometry, vertexTexture, slots };
}

/** Install the fetched vertex data in the normal MeshStandard transform and lighting path. */
export function setPackedCrowdMaterial(
  material: THREE.MeshStandardMaterial,
  vertexTexture: THREE.DataTexture,
): void {
  material.onBeforeCompile = shader => {
    shader.uniforms.uPackedCrowdVertices = { value: vertexTexture };
    shader.vertexShader = shader.vertexShader
      .replace('#include <color_pars_vertex>', `
#include <color_pars_vertex>
uniform sampler2D uPackedCrowdVertices;
attribute float crowdGeometrySlot;
attribute vec3 crowdSkinColor;
attribute vec3 crowdClothingColor;`)
      .replace('#include <color_vertex>', `
#include <color_vertex>
ivec2 packedAddress = ivec2(gl_VertexID, 3 * int(crowdGeometrySlot + 0.5));
vec4 packedPosition = texelFetch(uPackedCrowdVertices, packedAddress, 0);
vec3 packedColor = texelFetch(uPackedCrowdVertices, packedAddress + ivec2(0, 2), 0).rgb;
if (packedPosition.w > 1.5) {
  packedColor *= crowdClothingColor;
} else if (packedPosition.w > 0.5) {
  packedColor *= crowdSkinColor;
}
vColor.rgb *= packedColor;`)
      .replace('#include <beginnormal_vertex>', `
vec3 objectNormal = texelFetch(uPackedCrowdVertices, packedAddress + ivec2(0, 1), 0).xyz;`)
      .replace('#include <begin_vertex>', `
vec3 transformed = packedPosition.xyz;`);
  };
  material.customProgramCacheKey = () => 'crowd-packed-vertex-texture-v1';
}
