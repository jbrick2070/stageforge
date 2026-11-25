import * as THREE from 'three';
import {
  deckSheenSizeForTier,
  estimateDeckSheenTextureBytes,
  generateDeckSheenMaps,
  pixelsToCanvasTexture,
  STAGE_DECK_BASE_ROUGHNESS,
  STAGE_DECK_REPEAT_X,
  STAGE_DECK_REPEAT_Y,
  STAGE_DECK_SEED,
  STAGE_DECK_SHEEN_NORMAL_SCALE,
  type RenderTier,
} from './hardwareMaterials';

export interface DeckSheenStats {
  requested: boolean;
  active: boolean;
  tier: RenderTier;
  mapSize: number;
  roughnessAllocated: boolean;
  normalAllocated: boolean;
  extraTextureCount: number;
  extraTextureBytes: number;
}

export type DeckSheenTextureFactory = (
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  colorSpace: THREE.ColorSpace,
  anisotropy: number,
) => THREE.Texture | null;

function configureDeckMapTexture(tex: THREE.Texture, name: string, anisotropy: number): THREE.Texture {
  tex.name = name;
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(STAGE_DECK_REPEAT_X, STAGE_DECK_REPEAT_Y);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

/**
 * StageEngine-owned lifecycle controller for Sprint 18's optional stage-deck PBR response.
 * Allocates zero buffers or textures while disabled, applies in-place without rebuilding the rig
 * or adding draw calls when enabled, and disposes detached maps immediately on disable or teardown.
 */
export class DeckSheenController {
  private requested = false;
  private disposed = false;
  private roughnessTex: THREE.Texture | null = null;
  private normalTex: THREE.Texture | null = null;
  private readonly anisotropy: number;
  private readonly textureFactory: DeckSheenTextureFactory;

  constructor(
    private readonly tier: RenderTier,
    maxAnisotropy = 1,
    textureFactory: DeckSheenTextureFactory = pixelsToCanvasTexture,
  ) {
    this.anisotropy = tier === 'high' ? Math.max(1, Math.min(4, maxAnisotropy)) : 1;
    this.textureFactory = textureFactory;
  }

  public apply(material: THREE.MeshStandardMaterial | undefined, enabled: boolean): void {
    if (this.disposed || !material) return;
    this.requested = Boolean(enabled);

    if (!this.requested) {
      const hadMaps =
        this.roughnessTex !== null ||
        this.normalTex !== null ||
        material.roughnessMap !== null ||
        material.normalMap !== null ||
        material.roughness !== STAGE_DECK_BASE_ROUGHNESS;
      if (!hadMaps) return;
      material.roughnessMap = null;
      material.normalMap = null;
      material.roughness = STAGE_DECK_BASE_ROUGHNESS;
      material.normalScale.set(1, 1);
      material.needsUpdate = true;
      this.releaseOwnedTextures();
      return;
    }

    if (
      this.roughnessTex !== null &&
      material.roughnessMap === this.roughnessTex &&
      material.normalMap === this.normalTex
    ) {
      return;
    }

    this.releaseOwnedTextures();
    const maps = generateDeckSheenMaps(this.tier, STAGE_DECK_SEED);
    const roughTex = this.textureFactory(maps.roughness, maps.size, maps.size, THREE.NoColorSpace, this.anisotropy);
    if (!roughTex) {
      // Headless Node without DOM / canvas factory: stay cleanly inactive with canonical material state.
      return;
    }
    configureDeckMapTexture(roughTex, 'stage-deck-roughness', this.anisotropy);
    this.roughnessTex = roughTex;

    if (this.tier === 'high' && maps.normal) {
      const normTex = this.textureFactory(maps.normal, maps.size, maps.size, THREE.NoColorSpace, this.anisotropy);
      if (normTex) {
        configureDeckMapTexture(normTex, 'stage-deck-normal', this.anisotropy);
        this.normalTex = normTex;
      }
    }

    material.roughnessMap = this.roughnessTex;
    material.normalMap = this.normalTex;
    material.roughness = 1.0;
    if (this.normalTex) {
      material.normalScale.set(STAGE_DECK_SHEEN_NORMAL_SCALE, STAGE_DECK_SHEEN_NORMAL_SCALE);
    } else {
      material.normalScale.set(1, 1);
    }
    material.needsUpdate = true;
  }

  public onContextRestored(material: THREE.MeshStandardMaterial | undefined): void {
    if (this.disposed || !material || !this.roughnessTex) return;
    this.roughnessTex.needsUpdate = true;
    if (this.normalTex) this.normalTex.needsUpdate = true;
    material.needsUpdate = true;
  }

  public getStats(): DeckSheenStats {
    const roughnessAllocated = this.roughnessTex !== null;
    const normalAllocated = this.normalTex !== null;
    const extraTextureCount = (roughnessAllocated ? 1 : 0) + (normalAllocated ? 1 : 0);
    const active = this.requested && roughnessAllocated;
    const mapSize = deckSheenSizeForTier(this.tier);
    const perMapBytes = estimateDeckSheenTextureBytes('low', true) * (this.tier === 'high' ? 4 : 1);
    return {
      requested: this.requested,
      active,
      tier: this.tier,
      mapSize,
      roughnessAllocated,
      normalAllocated,
      extraTextureCount,
      extraTextureBytes: extraTextureCount > 0
        ? (this.tier === 'high'
            ? (roughnessAllocated && normalAllocated
                ? estimateDeckSheenTextureBytes('high', true)
                : perMapBytes)
            : estimateDeckSheenTextureBytes('low', true))
        : 0,
    };
  }

  public dispose(material?: THREE.MeshStandardMaterial): void {
    if (this.disposed) return;
    if (material) {
      material.roughnessMap = null;
      material.normalMap = null;
      material.roughness = STAGE_DECK_BASE_ROUGHNESS;
      material.normalScale.set(1, 1);
    }
    this.releaseOwnedTextures();
    this.requested = false;
    this.disposed = true;
  }

  private releaseOwnedTextures(): void {
    if (this.roughnessTex) {
      this.roughnessTex.dispose();
      this.roughnessTex = null;
    }
    if (this.normalTex) {
      this.normalTex.dispose();
      this.normalTex = null;
    }
  }
}
