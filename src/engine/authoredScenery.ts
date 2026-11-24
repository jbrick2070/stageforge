import * as THREE from 'three';
import type { RigConfig } from '../types/show';
import type { LayoutProp } from '../data/studioGeometry';
import { stageSurfaceHeight } from '../data/stageDesign';
import type { SharedMaterials } from './geometryBuilders';

export function createAuthoredProp(prop: LayoutProp, index: number, rig: RigConfig, mats: SharedMaterials) {
  const root = new THREE.Group();
  const inflatable = prop.type === 'inflatable';
  root.name = `${inflatable ? 'Inflatable' : 'Scenic prop'} ${index + 1}`;
  root.userData = { kind: prop.type, height: prop.height };
  root.position.set(prop.x, stageSurfaceHeight(rig, prop.x, prop.z), prop.z);
  const fabric = new THREE.MeshStandardMaterial({ color: inflatable ? '#cd6c9b' : '#97634f', roughness: 0.68 });
  const shell = new THREE.Mesh(inflatable ? new THREE.SphereGeometry(1, 24, 16) : new THREE.BoxGeometry(0.95, 1, 0.7), fabric);
  if (inflatable) {
    shell.scale.set(prop.height * 0.24, prop.height / 2, prop.height * 0.24);
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.16, 0.55), mats.darkSteel);
    base.position.y = 0.08;
    root.add(base);
  } else shell.scale.y = prop.height;
  shell.position.y = prop.height / 2;
  root.add(shell);
  return root;
}
