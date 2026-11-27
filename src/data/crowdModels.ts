export type CrowdPose = 'standing' | 'seated';
export type CrowdRenderTier = 'high' | 'low' | 'xr';
export type CrowdModelFamily = 'human' | 'robot' | 'alien';
export type CrowdGeometryKey = 'legacy-human-v1' | 'original-robot-v1' | 'original-alien-v1';

export const CROWD_MODEL_IDS = [
  'stageforge-human-v1',
  'stageforge-robot-v1',
  'stageforge-alien-v1',
] as const;
export type CrowdModelId = (typeof CROWD_MODEL_IDS)[number];

export interface CrowdHandsetSocket {
  translation: readonly [number, number, number];
  rotation: readonly [number, number, number];
}

export interface CrowdModelBudget {
  /** Exact indexed triangles contributed by one submitted figure instance. */
  trianglesPerInstance: number;
  /** Exact material slots on the figure batch. */
  materialSlots: number;
  /** Exact renderer textures referenced by the material slots. */
  materialTextures: number;
  /** Exact renderer-owned InstancedMesh morph texture allocation (0 or 1). */
  morphTextures: number;
  /** Exact figure draw batches contributed when this model is present. */
  figureBatches: number;
}

export interface CrowdModelSpec {
  id: CrowdModelId;
  family: CrowdModelFamily;
  label: string;
  geometryKey: CrowdGeometryKey;
  provenance: {
    creator: string;
    source: string;
    license: 'StageForge original';
  };
  poses: Readonly<Record<CrowdPose, {
    /** Maximum top in stage metres after the largest authored motion scale. */
    maxHeightM: number;
    /** Deterministic horizontal placement clearance for this pose. */
    clearanceRadiusM: number;
    /** Model-local point that is placed on the floor or seat anchor. */
    pivot: readonly [number, number, number];
    handset: CrowdHandsetSocket | null;
  }>>;
  budgets: Readonly<Record<CrowdRenderTier, CrowdModelBudget>>;
  /** Only the original human may use the frozen generator-v1 and legacy batch path. */
  legacyCompatible: boolean;
}

export const CROWD_MAX_AUTHORED_OCCUPANTS = 680;
export const CROWD_PLACEMENT_ENVELOPE = Object.freeze({
  standing: Object.freeze({ clearanceRadiusM: 0.47, maxHeightM: 2.15 }),
  seated: Object.freeze({ clearanceRadiusM: 0.26, maxHeightM: 1.42 }),
});
export const CROWD_XR_EYE_VIEWS = 2;
export const CROWD_XR_AGGREGATE_BUDGET = Object.freeze({
  ceiling: { draws: 270, triangles: 760_000, textures: 26 },
  measuredArena: { draws: 262, triangles: 745_712, textures: 25 },
  remaining: { draws: 8, triangles: 14_288, textures: 1 },
});

const humanBudget: CrowdModelBudget = {
  trianglesPerInstance: 264, materialSlots: 1, materialTextures: 0, morphTextures: 1, figureBatches: 1,
};
const robotBudget: CrowdModelBudget = {
  trianglesPerInstance: 168, materialSlots: 1, materialTextures: 0, morphTextures: 0, figureBatches: 1,
};
const alienBudget: CrowdModelBudget = {
  trianglesPerInstance: 200, materialSlots: 1, materialTextures: 0, morphTextures: 0, figureBatches: 1,
};

/**
 * Measured from geometryBuilders.ts at the 6B pickup: 264 triangles, base foot at y=0,
 * raised-arm maximum y=1.918 scaled by the legacy 1.12 maximum, and no material map.
 * The existing human InstancedMesh allocates one renderer-owned morph texture for its two poses.
 */
export const STAGEFORGE_HUMAN_V1: CrowdModelSpec = Object.freeze({
  id: 'stageforge-human-v1', family: 'human', label: 'StageForge human', geometryKey: 'legacy-human-v1',
  provenance: {
    creator: 'StageForge', source: 'Built-in procedural legacy instanced human', license: 'StageForge original' as const,
  },
  poses: {
    standing: {
      maxHeightM: 2.15, clearanceRadiusM: 0.47, pivot: [0, 0, 0],
      handset: { translation: [0.37, 1.90, 0.145], rotation: [0, Math.PI, 0] },
    },
    seated: { maxHeightM: 1.42, clearanceRadiusM: 0.26, pivot: [0, 0, 0], handset: null },
  },
  budgets: { high: humanBudget, low: humanBudget, xr: humanBudget },
  legacyCompatible: true,
} as CrowdModelSpec);

/** First contract-exercising original creature: matte, texture-free and deliberately low-poly. */
export const STAGEFORGE_ROBOT_V1: CrowdModelSpec = Object.freeze({
  id: 'stageforge-robot-v1', family: 'robot', label: 'StageForge robot', geometryKey: 'original-robot-v1',
  provenance: {
    creator: 'StageForge', source: 'Built-in original procedural service robot', license: 'StageForge original' as const,
  },
  poses: {
    standing: { maxHeightM: 2.08, clearanceRadiusM: 0.43, pivot: [0, 0, 0], handset: null },
    seated: { maxHeightM: 1.38, clearanceRadiusM: 0.25, pivot: [0, 0, 0], handset: null },
  },
  budgets: { high: robotBudget, low: robotBudget, xr: robotBudget },
  legacyCompatible: false,
} as CrowdModelSpec);

/** Second contract-exercising original creature with a distinct head and limb silhouette. */
export const STAGEFORGE_ALIEN_V1: CrowdModelSpec = Object.freeze({
  id: 'stageforge-alien-v1', family: 'alien', label: 'StageForge alien', geometryKey: 'original-alien-v1',
  provenance: {
    creator: 'StageForge', source: 'Built-in original procedural long-headed alien', license: 'StageForge original' as const,
  },
  poses: {
    standing: { maxHeightM: 2.14, clearanceRadiusM: 0.42, pivot: [0, 0, 0], handset: null },
    seated: { maxHeightM: 1.42, clearanceRadiusM: 0.25, pivot: [0, 0, 0], handset: null },
  },
  budgets: { high: alienBudget, low: alienBudget, xr: alienBudget },
  legacyCompatible: false,
} as CrowdModelSpec);

const SAFE_MODEL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function finiteTuple(value: readonly number[], path: string): void {
  if (value.length !== 3 || value.some((item) => !Number.isFinite(item))) {
    throw new Error(`${path} must contain three finite values.`);
  }
}

/** Fail closed before a built-in model can enter the authoritative registry. */
export function validateCrowdModelSpec(spec: CrowdModelSpec): void {
  if (!SAFE_MODEL_ID.test(spec.id) || !CROWD_MODEL_IDS.includes(spec.id)) {
    throw new Error(`crowd model id "${spec.id}" is not a registered safe ID.`);
  }
  for (const [path, value] of [
    ['label', spec.label],
    ['provenance.creator', spec.provenance.creator],
    ['provenance.source', spec.provenance.source],
    ['provenance.license', spec.provenance.license],
  ] as const) {
    if (!value.trim()) throw new Error(`crowd model ${spec.id} ${path} cannot be empty.`);
  }
  for (const pose of ['standing', 'seated'] as const) {
    const value = spec.poses[pose];
    const envelope = CROWD_PLACEMENT_ENVELOPE[pose];
    if (!Number.isFinite(value.maxHeightM) || value.maxHeightM <= 0 || value.maxHeightM > envelope.maxHeightM) {
      throw new Error(`crowd model ${spec.id} ${pose} height exceeds the shared envelope.`);
    }
    if (!Number.isFinite(value.clearanceRadiusM) || value.clearanceRadiusM <= 0 || value.clearanceRadiusM > envelope.clearanceRadiusM) {
      throw new Error(`crowd model ${spec.id} ${pose} clearance exceeds the shared envelope.`);
    }
    finiteTuple(value.pivot, `crowd model ${spec.id} ${pose} pivot`);
    if (value.handset) {
      finiteTuple(value.handset.translation, `crowd model ${spec.id} ${pose} handset translation`);
      finiteTuple(value.handset.rotation, `crowd model ${spec.id} ${pose} handset rotation`);
    }
  }
  for (const tier of ['high', 'low', 'xr'] as const) {
    const budget = spec.budgets[tier];
    for (const [name, value] of Object.entries(budget)) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`crowd model ${spec.id} ${tier} ${name} must be a non-negative integer.`);
      }
    }
    if (budget.trianglesPerInstance <= 0 || budget.trianglesPerInstance > humanBudget.trianglesPerInstance) {
      throw new Error(`crowd model ${spec.id} ${tier} triangle contribution exceeds the admitted template.`);
    }
    if (budget.materialSlots !== 1 || budget.figureBatches !== 1 || budget.materialTextures > 0 || budget.morphTextures > 1) {
      throw new Error(`crowd model ${spec.id} ${tier} has an unsupported renderer contribution.`);
    }
  }
  if (spec.legacyCompatible !== (spec.id === STAGEFORGE_HUMAN_V1.id)) {
    throw new Error(`crowd model ${spec.id} has an invalid legacy-compatibility claim.`);
  }
}

const registeredModels = [STAGEFORGE_HUMAN_V1, STAGEFORGE_ROBOT_V1, STAGEFORGE_ALIEN_V1]
  .sort((a, b) => a.id.localeCompare(b.id));
registeredModels.forEach(validateCrowdModelSpec);

export const CROWD_MODEL_REGISTRY: Readonly<Record<CrowdModelId, CrowdModelSpec>> = Object.freeze(
  Object.fromEntries(registeredModels.map((model) => [model.id, model])) as Record<CrowdModelId, CrowdModelSpec>,
);

export function crowdModel(modelId: string): CrowdModelSpec {
  const model = CROWD_MODEL_REGISTRY[modelId as CrowdModelId];
  if (!model) throw new Error(`crowd model "${modelId}" is not available in this build.`);
  return model;
}

export interface CrowdResourcePlacement {
  modelId: CrowdModelId;
  phone: boolean;
}

export interface CrowdResourceAdmission {
  eyeViews: number;
  figureBatches: number;
  phoneBatches: number;
  footprintBatches: number;
  sceneDraws: number;
  submittedDraws: number;
  instanceTriangles: number;
  submittedTriangles: number;
  materialTextures: number;
  morphTextures: number;
  rendererTextures: number;
  arenaDelta: { draws: number; triangles: number; textures: number };
  admitted: boolean;
}

/** Deterministic worst-path accounting before Three.js resources are admitted. */
export function crowdResourceAdmission(
  placements: readonly CrowdResourcePlacement[],
  tier: CrowdRenderTier,
  eyeViews = CROWD_XR_EYE_VIEWS,
): CrowdResourceAdmission {
  if (!Number.isSafeInteger(eyeViews) || eyeViews < 1 || eyeViews > CROWD_XR_EYE_VIEWS) {
    throw new Error(`crowd eyeViews must be an integer from 1 to ${CROWD_XR_EYE_VIEWS}.`);
  }
  const counts = new Map<CrowdModelId, number>();
  const phoneModels = new Set<CrowdModelId>();
  for (const placement of placements) {
    const model = crowdModel(placement.modelId);
    counts.set(model.id, (counts.get(model.id) ?? 0) + 1);
    if (placement.phone) {
      if (!model.poses.standing.handset) throw new Error(`crowd model ${model.id} cannot own a handset.`);
      phoneModels.add(model.id);
    }
  }
  let instanceTriangles = 0;
  let materialTextures = 0;
  let morphTextures = 0;
  let figureBatches = 0;
  for (const [modelId, count] of counts) {
    const budget = crowdModel(modelId).budgets[tier];
    instanceTriangles += budget.trianglesPerInstance * count;
    materialTextures += budget.materialTextures;
    morphTextures += budget.morphTextures;
    figureBatches += budget.figureBatches;
  }
  const phoneBatches = phoneModels.size;
  const footprintBatches = placements.length ? 1 : 0;
  const sceneDraws = figureBatches + phoneBatches + footprintBatches;
  const submittedDraws = sceneDraws * eyeViews;
  const submittedTriangles = instanceTriangles * eyeViews;
  const baselineBudget = STAGEFORGE_HUMAN_V1.budgets[tier];
  const baselineSceneDraws = placements.length ? 2 + (phoneBatches ? 1 : 0) : 0;
  const arenaDelta = {
    draws: Math.max(0, (sceneDraws - baselineSceneDraws) * eyeViews),
    triangles: Math.max(0, submittedTriangles - placements.length * baselineBudget.trianglesPerInstance * eyeViews),
    textures: Math.max(0, materialTextures + morphTextures - (placements.length ? baselineBudget.materialTextures + baselineBudget.morphTextures : 0)),
  };
  return {
    eyeViews, figureBatches, phoneBatches, footprintBatches, sceneDraws, submittedDraws,
    instanceTriangles, submittedTriangles, materialTextures, morphTextures,
    rendererTextures: materialTextures + morphTextures,
    arenaDelta,
    admitted:
      arenaDelta.draws <= CROWD_XR_AGGREGATE_BUDGET.remaining.draws &&
      arenaDelta.triangles <= CROWD_XR_AGGREGATE_BUDGET.remaining.triangles &&
      arenaDelta.textures <= CROWD_XR_AGGREGATE_BUDGET.remaining.textures,
  };
}
