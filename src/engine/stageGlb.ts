import * as THREE from 'three';
import { buildPlatformDeck, type SharedMaterials } from './geometryBuilders';
import { buildScenicPiece } from './scenicProps';
import { LED_DISPLAY_MATERIAL_NAME } from './fohFraming';
import type { FloorFxUnit, MountedFixtureGroup, RigConfig, StageProp } from '../types/show';

export const MAX_GLB_CABINET_BACK_INSTANCES = 2000;

export function nameFixtureUnit(
  object: THREE.Object3D, group: FloorFxUnit | MountedFixtureGroup, index: number, start: number,
) {
  object.name = `${group.modelName} ${index + 1}`;
  object.userData = {
    ...object.userData,
    kind: group.type, groupId: group.id, unit: index + 1, model: group.modelName,
    ...(group.catalogId !== undefined ? { catalogId: group.catalogId } : {}),
    dmxUniverse: group.dmxUniverse, dmxStartChannel: start || null,
  };
  return object;
}

/** Capture geometry, materials and local poses synchronously, before the show advances. */
export function stageSnapshot(rig: RigConfig, roots: THREE.Object3D[], mats: SharedMaterials) {
  const scene = new THREE.Scene();
  scene.name = rig.name;
  scene.userData = { application: 'StageForge', units: 'metres', venue: rig.venue };
  const geometries = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
  const materials = new Map<THREE.Material, THREE.Material>();
  const names = new Map(Object.entries(mats).map(([name, mat]) => [mat as THREE.Material, name]));
  const screen = new THREE.MeshStandardMaterial({
    name: 'LED display surface', color: 0x26292e, roughness: 0.64, side: THREE.DoubleSide,
  });
  let cabinetBackNodes = 0;

  function geometryFor(source: THREE.BufferGeometry) {
    let geometry = geometries.get(source);
    if (!geometry) {
      // GLTFExporter may normalize attributes and generate indices. Keep those
      // writes isolated from meshes that the concert renderer is still drawing.
      geometry = source.clone();
      const colors = geometry.getAttribute('color');
      if (colors) for (let i = 0; i < colors.count; i++) {
        colors.setXYZ(i, THREE.MathUtils.clamp(colors.getX(i), 0, 1),
          THREE.MathUtils.clamp(colors.getY(i), 0, 1), THREE.MathUtils.clamp(colors.getZ(i), 0, 1));
      }
      geometries.set(source, geometry);
    }
    return geometry;
  }

  function materialFor(source: THREE.Material) {
    if (source instanceof THREE.ShaderMaterial) return source.name === LED_DISPLAY_MATERIAL_NAME ? screen : null;
    let material = materials.get(source);
    if (!material) {
      const copy = source.clone();
      copy.name = source.name || names.get(source) || source.type;
      if (copy instanceof THREE.MeshStandardMaterial) {
        // Keep albedo + roughness/metalness atlas in GLB while stripping normal maps to keep files compact.
        copy.normalMap = null;
      }
      if (copy instanceof THREE.MeshBasicMaterial || copy instanceof THREE.MeshStandardMaterial) {
        // Light lenses in the HDR renderer can exceed glTF's base-color range.
        const { r, g, b } = copy.color;
        copy.color.setRGB(THREE.MathUtils.clamp(r, 0, 1), THREE.MathUtils.clamp(g, 0, 1), THREE.MathUtils.clamp(b, 0, 1));
      }
      material = copy;
      materials.set(source, copy);
    }
    return material;
  }

  function copyNode(source: THREE.Object3D, index: number): THREE.Object3D | undefined {
    if (source.userData.kind === 'venue' || source instanceof THREE.Light || source instanceof THREE.Camera) return;
    let sourceForChildren = source;
    if (source.userData.scenicProp && source.userData.scenicTier === 'low') {
      // Always export canonical high-detail scenery regardless of preview tier.
      sourceForChildren = buildScenicPiece(source.userData.scenicProp as StageProp, mats.fixtureBody, 'high').root;
    }
    const children = sourceForChildren.userData.kind === 'platforms'
      ? buildPlatformDeck(rig, mats, true).children
      : sourceForChildren.children;
    let node: THREE.Object3D;
    if (source instanceof THREE.Mesh) {
      const mapped = Array.isArray(source.material) ? source.material.map(materialFor) : null;
      const material = mapped ? mapped.every(m => m !== null) ? mapped : null : materialFor(source.material);
      if (!material) return; // Volumetric beam, laser sheet or other shader-only effect.
      if (source instanceof THREE.InstancedMesh) {
        if (source.userData.kind === 'ledCabinetBacks' && cabinetBackNodes + source.count > MAX_GLB_CABINET_BACK_INSTANCES) {
          scene.userData.cabinetBacksOmitted = true;
          return;
        }
        const geometry = geometryFor(source.geometry);
        // Standard nodes share a single mesh and work in importers without GPU instancing support.
        node = new THREE.Group();
        const matrix = new THREE.Matrix4();
        for (let i = 0; i < source.count; i++) {
          const instance = new THREE.Mesh(geometry, material);
          instance.name = `${source.name || 'Detail'} ${i + 1}`;
          source.getMatrixAt(i, matrix);
          matrix.decompose(instance.position, instance.quaternion, instance.scale);
          node.add(instance);
        }
        if (source.userData.kind === 'ledCabinetBacks') cabinetBackNodes += source.count;
      } else {
        const geometry = geometryFor(source.geometry);
        node = new THREE.Mesh(geometry, material);
      }
    } else node = new THREE.Group();
    node.name = source.name || `${source instanceof THREE.Mesh ? (names.get(source.material) || 'Mesh') : 'Assembly'} ${index + 1}`;
    // Strip runtime-only scenery LOD metadata so low-tier and high-tier exports produce identical glTF extras.
    const { scenicProp: _scenicProp, scenicTier: _scenicTier, ...cleanUserData } = source.userData;
    node.userData = cleanUserData;
    node.position.copy(source.position);
    node.quaternion.copy(source.quaternion);
    node.scale.copy(source.scale);
    if (!source.matrixAutoUpdate) source.matrix.decompose(node.position, node.quaternion, node.scale);
    children.forEach((child, i) => {
      const copy = copyNode(child, i);
      if (copy) node.add(copy);
    });
    return node;
  }

  roots.forEach((root, i) => {
    const copy = copyNode(root, i);
    if (copy) scene.add(copy);
  });
  return scene;
}

export async function exportStageGlb(rig: RigConfig, roots: THREE.Object3D[], mats: SharedMaterials): Promise<Blob> {
  const scene = stageSnapshot(rig, roots, mats);
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const binary = await new GLTFExporter().parseAsync(scene, { binary: true, maxTextureSize: 512 });
  if (!(binary instanceof ArrayBuffer)) throw new Error('The stage could not be encoded as a binary glTF.');
  return new Blob([binary], { type: 'model/gltf-binary' });
}
