import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { parseRigJson } from '../data/rigImport';
import {
  Check,
  DraftingCompass,
  Hand,
  Maximize,
  Monitor,
  MousePointer2,
  Plus,
  Redo2,
  Route,
  Shapes,
  Slash,
  Speaker,
  Square,
  Undo2,
  X,
  Minus,
} from 'lucide-react';
import {
  createBlankDesign,
  getPlatforms,
  makeTrussPath,
  MAX_PATH_POINTS,
  MAX_PLATFORMS,
  MIN_TRUSS_SPAN,
  pathLength,
  podLocalPoint,
  podWorldPoint,
  withPlatforms,
} from '../data/stageDesign';
import type { PlanPoint, RigConfig, ShowState, StagePlatform, TrussPodConfig } from '../types/show';
import type { IldaClip } from '../data/ilda';
import type { NativeStage } from '../data/showFile';
import {
  CROWD_MODEL_PRESETS,
  crowdModelMix,
  makeDefaultCrowd,
  resolveCrowdLayout,
  withCrowdModelMix,
  type CrowdLayout,
  type CrowdModelMix,
} from '../data/crowdPlacement';
import { GRID_HEIGHT } from '../data/stageEquipment';
import { placeFixtures } from '../data/fixturePlacement';
import { computeReachMap, computeVenueBounds, evaluateLaserZones } from '../data/measure';
import { INITIAL_SHOW_STATE } from '../data/presets';
import { specToSvgPath, symbolForHardware } from '../data/equipmentSymbols';
import {
  createSecondaryWall,
  MAX_STAGE_WALLS,
  MAX_WALL_HEIGHT,
  MAX_WALL_WIDTH,
  upsertStageWall,
  type LayoutProp,
  type SpeakerHang,
  type StageWall,
} from '../data/studioGeometry';
import {
  canAuthorWall,
  canAddHang,
  canAddWall,
  convertLayoutTruss,
  effectiveHangs,
  facing,
  finalizeStage,
  hangAimHandle,
  HANG_COVERAGE_DEG,
  MAX_LAYOUT_ITEMS,
  MIN_LAYOUT_SPAN,
  moveStageItem,
  newHang,
  patchWall,
  planWalls,
  removeStageItem,
  setHangs,
  setLayoutProps,
  setLayoutReplace,
  setLayoutTrusses,
  spanLength,
  stagePlanPoints,
  wallHandles,
  widthAxis,
  wrapDegrees,
  type LayoutTruss,
  type PlanItem,
  type PlanItemKind,
  type PlanWall,
} from '../data/stagePlan';
import './StageDesigner.css';

type Tool = 'select' | 'platform' | 'path' | 'wall' | 'hang' | 'span' | 'prop' | 'pan';
type Kind = 'platform' | 'truss' | PlanItemKind;
type Selection = { kind: Kind; id: string; node?: number };
type View = { x: number; z: number; width: number };
type Drag = { origin: PlanPoint; at: PlanPoint; pointer: number; selection?: Selection; pan?: View };
/** One undoable state: the rig plus the native stage overlay (walls, hangs, layout, wall cues). */
type Draft = { rig: RigConfig; stage?: NativeStage; crowd?: CrowdLayout };
type EditorProps = {
  rig: RigConfig;
  stage?: NativeStage;
  crowd?: CrowdLayout;
  laserState?: ShowState['laser'];
  ildaClip?: IldaClip | null;
  /** Return false to keep the designer open (for example when the user declines a discard prompt). */
  onChange: (rig: RigConfig, stage: NativeStage | undefined, crowd: CrowdLayout | undefined, replacing: boolean) => boolean | void;
  onClose: () => void;
};
const guides = [
  { id: 'select', name: 'Select', Icon: MousePointer2 },
  { id: 'platform', name: 'Platform', Icon: Square },
  { id: 'path', name: 'Truss path', Icon: Route },
  { id: 'wall', name: 'Screen', Icon: Monitor },
  { id: 'hang', name: 'Speaker hang', Icon: Speaker },
  { id: 'span', name: 'Layout truss', Icon: Slash },
  { id: 'prop', name: 'Layout prop', Icon: Shapes },
  { id: 'pan', name: 'Pan', Icon: Hand },
] as const;
const PREFIX: Record<Kind, string> = { platform: 'p', truss: 't', wall: 'w', hang: 'h', span: 's', prop: 'o' };
const KIND_BY_PREFIX = Object.fromEntries(Object.entries(PREFIX).map(([kind, prefix]) => [prefix, kind])) as Record<string, Kind>;
const rounded = (n: number) => Number(n.toFixed(3));
const distance = (a: PlanPoint, b: PlanPoint) => Math.hypot(a.x - b.x, a.z - b.z);
const limit = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const pointString = (points: PlanPoint[]) => points.map((p) => `${p.x},${p.z}`).join(' ');
const isStageKind = (kind: Kind): kind is PlanItemKind => kind === 'wall' || kind === 'hang' || kind === 'span' || kind === 'prop';
/** Handles that aim an object: they follow the pointer freely and snap the angle instead of the grid. */
const isAimHandle = (s?: Selection) => !!s && ((s.kind === 'wall' && s.node === 1) || (s.kind === 'hang' && s.node === 0));

function corners(p: StagePlatform): PlanPoint[] {
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([dx, dz]) => ({ x: p.x + (dx * p.width) / 2, z: p.z + (dz * p.depth) / 2 }));
}
function knots(p: TrussPodConfig): PlanPoint[] {
  const r = p.width / 2;
  if (p.shape === 'path') return p.path ?? [];
  if (p.shape === 'circle')
    return [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ].map(([x, z]) => ({ x: x * r, z: z * r }));
  if (p.shape === 'chevron')
    return [
      { x: -r, z: -r * Math.tan(0.36) },
      { x: 0, z: 0 },
      { x: r, z: -r * Math.tan(0.36) },
    ];
  return [
    { x: -r, z: 0 },
    { x: r, z: 0 },
  ];
}
function frameDesign(rig: RigConfig, aspect: number, stage?: NativeStage): View {
  const points = [
    ...getPlatforms(rig).flatMap(corners),
    ...rig.trussPods.flatMap((p) =>
      p.shape === 'circle'
        ? [
            { x: p.x - p.width / 2, z: p.z - p.width / 2 },
            { x: p.x + p.width / 2, z: p.z + p.width / 2 },
          ]
        : knots(p).map((n) => podWorldPoint(p, n)),
    ),
    ...stagePlanPoints(rig, stage),
  ];
  const xs = points.map((p) => p.x),
    zs = points.map((p) => p.z);
  const left = Math.min(-8, ...xs),
    right = Math.max(8, ...xs),
    top = Math.min(-5, ...zs),
    bottom = Math.max(5, ...zs);
  return {
    x: (left + right) / 2,
    z: (top + bottom) / 2,
    width: Math.max(right - left + 5, (bottom - top + 5) * aspect),
  };
}
function resized(p: StagePlatform, node: number, at: PlanPoint): StagePlatform {
  const opposite = corners(p)[(node + 2) % 4];
  const right = node === 1 || node === 2,
    bottom = node > 1;
  const x = right ? Math.max(at.x, opposite.x + 0.25) : Math.min(at.x, opposite.x - 0.25);
  const z = bottom ? Math.max(at.z, opposite.z + 0.25) : Math.min(at.z, opposite.z - 0.25);
  return {
    ...p,
    x: (x + opposite.x) / 2,
    z: (z + opposite.z) / 2,
    width: Math.abs(x - opposite.x),
    depth: Math.abs(z - opposite.z),
  };
}
function moveKnot(p: TrussPodConfig, node: number, at: PlanPoint): TrussPodConfig {
  if (p.shape === 'circle') return { ...p, width: Math.max(0.25, 2 * Math.hypot(at.x - p.x, at.z - p.z)) };
  const points = knots(p),
    local = podLocalPoint(p, at);
  const closed = points.length > 2 && distance(points[0], points[points.length - 1]) < 0.001;
  const path = points.map((q, i) =>
    i === node ||
    (closed && (node === 0 || node === points.length - 1) && (i === 0 || i === points.length - 1))
      ? local
      : q,
  );
  if (path.some((q, i) => i > 0 && distance(q, path[i - 1]) < MIN_TRUSS_SPAN)) return p;
  return { ...p, shape: 'path', path, width: pathLength(path) };
}
function moveRigItem(rig: RigConfig, selection: Selection, from: PlanPoint, at: PlanPoint): RigConfig {
  const dx = at.x - from.x,
    dz = at.z - from.z,
    node = selection.node;
  if (selection.kind === 'platform')
    return withPlatforms(
      rig,
      getPlatforms(rig).map((p) =>
        p.id !== selection.id
          ? p
          : node === undefined
            ? { ...p, x: rounded(p.x + dx), z: rounded(p.z + dz) }
            : resized(p, node, at),
      ),
    );
  return {
    ...rig,
    trussPods: rig.trussPods.map((p) =>
      p.id !== selection.id
        ? p
        : node === undefined
          ? { ...p, x: rounded(p.x + dx), z: rounded(p.z + dz) }
          : moveKnot(p, node, at),
    ),
  };
}
function moveItem(draft: Draft, selection: Selection, from: PlanPoint, at: PlanPoint, angleStep: number): Draft {
  if (isStageKind(selection.kind)) {
    return { ...draft, stage: moveStageItem(draft.rig, draft.stage, selection as PlanItem, from, at, angleStep) };
  }
  return { ...draft, rig: moveRigItem(draft.rig, selection, from, at) };
}
function Field({
  label,
  value,
  onChange,
  min,
  max,
  integer = false,
  unit = 'm',
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  integer?: boolean;
  unit?: string;
}) {
  const formatted = String(rounded(value));
  const [text, setText] = useState(formatted);
  const [invalid, setInvalid] = useState(false);
  const displayedRef = useRef(formatted);
  useEffect(() => {
    displayedRef.current = formatted;
    setText(formatted);
    setInvalid(false);
  }, [formatted]);
  const finish = () => {
    const next = Number(text);
    if (text.trim() !== '' && Number.isFinite(next) && (min === undefined || next >= min) &&
        (max === undefined || next <= max) && (!integer || Number.isInteger(next))) {
      // Compare against the last displayed value so tabbing through float-rounded values
      // (e.g. 29.999999999999996 shown as "30") does not spuriously commit an edit.
      if (next !== Number(displayedRef.current)) {
        onChange(next);
      }
      setText(displayedRef.current);
      setInvalid(false);
    } else setInvalid(true);
  };
  const range = min !== undefined && max !== undefined ? `${min}–${max} ${unit}` : min !== undefined ? `minimum ${min} ${unit}` : max !== undefined ? `maximum ${max} ${unit}` : '';
  return (
    <label className="sd-field">
      <span>{label}</span>
      <span className="sd-input-unit">
        <input
          type="number"
          required
          step={integer ? 1 : 'any'}
          min={min}
          max={max}
          value={text}
          aria-label={label}
          aria-invalid={invalid}
          onChange={(e) => {
            setText(e.target.value);
            setInvalid(false);
          }}
          onBlur={finish}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
        <span>{unit}</span>
      </span>
      {invalid && (
        <span className="sd-error">
          {integer ? 'Enter a whole number' : 'Enter a finite number'}{range ? `, ${range}` : ''}.
        </span>
      )}
    </label>
  );
}
function NameField({
  label,
  value,
  onChange,
  optional = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  optional?: boolean;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      aria-label={label}
      value={text}
      maxLength={optional ? 512 : undefined}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const next = text.trim();
        if ((next || optional) && next !== value) onChange(next);
        setText(next || (optional ? '' : value));
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
}
function Arrow({ from, to, size }: { from: PlanPoint; to: PlanPoint; size: number }) {
  const angle = Math.atan2(to.z - from.z, to.x - from.x);
  const head = (a: number) => `${to.x - size * Math.cos(angle + a)},${to.z - size * Math.sin(angle + a)}`;
  return (
    <>
      <line x1={from.x} y1={from.z} x2={to.x} y2={to.z} />
      <polygon points={`${to.x},${to.z} ${head(0.45)} ${head(-0.45)}`} />
    </>
  );
}

export function StageDesigner({ rig, stage, crowd, laserState, ildaClip, onChange, onClose }: EditorProps) {
  const [history, setHistory] = useState(() => ({
    past: [] as Draft[],
    // The designer edits private copies; Cancel discards them without touching the live rig or stage.
    now: { rig: structuredClone(rig), stage: stage && structuredClone(stage), crowd: crowd && structuredClone(crowd) } as Draft,
    future: [] as Draft[],
  }));
  const draft = history.now.rig;
  const stageDraft = history.now.stage;
  const crowdDraft = history.now.crowd;
  const [tool, setTool] = useState<Tool>('select');
  const [selected, setSelected] = useState<Selection>();
  const [points, setPoints] = useState<PlanPoint[]>([]);
  const [drag, setDrag] = useState<Drag>();
  const [nextPoint, setNextPoint] = useState<PlanPoint>({ x: 0, z: 0 });
  const [hover, setHover] = useState<PlanPoint>();
  const [snap, setSnap] = useState(0.5);
  const [showFixtures, setShowFixtures] = useState(true);
  const [showAudienceZone, setShowAudienceZone] = useState(false);
  const [showLaserNohd, setShowLaserNohd] = useState(false);
  const [showReachMap, setShowReachMap] = useState(false);
  const [propType, setPropType] = useState<LayoutProp['type']>('inflatable');
  const gridHeight = GRID_HEIGHT[draft.venue];
  const [elevation, setElevation] = useState(() => Math.min(7, gridHeight - 0.8));
  const [message, setMessage] = useState('');
  const [aspect, setAspect] = useState(1.5);
  const [view, setView] = useState<View>(() => frameDesign(rig, 1.5, stage));
  const dialog = useRef<HTMLDialogElement>(null),
    svg = useRef<SVGSVGElement>(null);
  const original = useRef({ rig, stage });
  useLayoutEffect(() => {
    const element = dialog.current,
      canvas = svg.current;
    if (!element || !canvas) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal();
    canvas.focus({ preventScroll: true });
    let previous = 0;
    const observer = new ResizeObserver(() => {
      const box = canvas.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const ratio = box.width / box.height;
      setAspect(ratio);
      if (!previous) setView(frameDesign(original.current.rig, ratio, original.current.stage));
      previous = ratio;
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      element.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  const angleStep = snap ? 5 : 0;
  const originalPlatforms = getPlatforms(draft);
  // The drag preview never needs wall cues; leaving them out keeps each pointer move from cloning them.
  const previewBase = drag?.selection && isStageKind(drag.selection.kind) && history.now.stage?.screenEvents.length
    ? { ...history.now, stage: { ...history.now.stage, screenEvents: [] } }
    : history.now;
  const showing = drag?.selection ? moveItem(previewBase, drag.selection, drag.origin, drag.at, angleStep) : history.now;
  const shownRig = showing.rig,
    shownStage = showing.stage,
    shownCrowd = showing.crowd;
  const platforms = getPlatforms(shownRig);
  const walls = planWalls(shownRig, shownStage);
  const hangInfo = effectiveHangs(shownRig, shownStage);
  const spans = shownStage?.layout?.trusses ?? [];
  const layoutProps = shownStage?.layout?.props ?? [];
  const replaced = shownStage?.layout?.replace === true;
  const planFixtures = useMemo(
    () => (showFixtures && !replaced ? placeFixtures(shownRig) : []),
    [showFixtures, replaced, shownRig],
  );
  const planAudienceZone = useMemo(
    () => (showAudienceZone ? computeVenueBounds(shownRig).audienceZone : null),
    [showAudienceZone, shownRig],
  );
  const planLaserZones = useMemo(
    () =>
      showLaserNohd && !replaced
        ? evaluateLaserZones(
            shownRig,
            { ...(laserState ?? INITIAL_SHOW_STATE.laser), enabled: true, intensity: 1 },
            { stage: shownStage, ildaClip: ildaClip ?? null },
          ).zones
        : [],
    [showLaserNohd, replaced, shownRig, shownStage, laserState, ildaClip],
  );
  const planReachMap = useMemo(
    () => (showReachMap && !replaced ? computeReachMap(shownRig, shownStage) : null),
    [showReachMap, replaced, shownRig, shownStage],
  );
  const crowdResult = useMemo(() => {
    if (!shownCrowd) return null;
    try {
      return { value: resolveCrowdLayout(shownRig, shownCrowd), error: '' };
    } catch (error) {
      return { value: null, error: error instanceof Error ? error.message : 'Invalid crowd layout.' };
    }
  }, [shownRig, shownCrowd]);
  const index = selected && !['platform', 'truss', 'wall'].includes(selected.kind) ? Number(selected.id) : -1;
  const platform = selected?.kind === 'platform' ? platforms.find((p) => p.id === selected.id) : undefined;
  const truss = selected?.kind === 'truss' ? shownRig.trussPods.find((p) => p.id === selected.id) : undefined;
  const wall = selected?.kind === 'wall' ? walls.find((w) => w.wall.id === selected.id) : undefined;
  const hang = selected?.kind === 'hang' ? hangInfo.hangs[index] : undefined;
  const span = selected?.kind === 'span' ? spans[index] : undefined;
  const prop = selected?.kind === 'prop' ? layoutProps[index] : undefined;
  const inspectedElevation = tool === 'path' || tool === 'span' ? elevation : truss?.baseY ?? span?.height;
  const vertices = platform
    ? corners(platform)
    : truss
      ? knots(truss).map((p) => podWorldPoint(truss, p))
      : wall
        ? wallHandles(wall.frame)
        : hang
          ? [hangAimHandle(hang)]
          : span
            ? [{ x: span.x, z: span.z }, { x: span.endX, z: span.endZ }]
            : [];
  const vertex = selected?.node !== undefined && (platform || truss) ? vertices[selected.node] : undefined;
  const newDesignDrafts = useRef(new WeakSet<RigConfig>());
  const commitDraft = (next: Draft, replacing = false) => {
    if (replacing || newDesignDrafts.current.has(draft)) newDesignDrafts.current.add(next.rig);
    setHistory((h) => ({ past: [...h.past.slice(-79), h.now], now: next, future: [] }));
    setMessage('');
  };
  const commit = (next: RigConfig, replacing = false) => commitDraft({ ...history.now, rig: next }, replacing);
  const commitStage = (next: NativeStage | undefined) => commitDraft({ ...history.now, stage: next });
  const commitCrowd = (next: CrowdLayout | undefined) => commitDraft({ ...history.now, crowd: next });
  const resetGesture = () => {
    setDrag(undefined);
    setPoints([]);
    setHover(undefined);
    setMessage('');
  };
  const choose = (next: Tool) => {
    resetGesture();
    setTool(next);
  };
  // Hangs, layout trusses and props are selected by list index, which can point at another item
  // after the list changes; drop such a selection whenever history moves.
  const dropIndexSelection = () => setSelected((s) => (s && ['hang', 'span', 'prop'].includes(s.kind) ? undefined : s));
  const undo = () => {
    resetGesture();
    dropIndexSelection();
    setHistory((h) =>
      h.past.length
        ? { past: h.past.slice(0, -1), now: h.past[h.past.length - 1], future: [h.now, ...h.future] }
        : h,
    );
  };
  const redo = () => {
    resetGesture();
    dropIndexSelection();
    setHistory((h) =>
      h.future.length ? { past: [...h.past, h.now], now: h.future[0], future: h.future.slice(1) } : h,
    );
  };
  const editPlatform = (patch: Partial<StagePlatform>) =>
    platform &&
    commit(
      withPlatforms(
        draft,
        originalPlatforms.map((p) => (p.id === platform.id ? { ...p, ...patch } : p)),
      ),
    );
  const editTruss = (patch: Partial<TrussPodConfig>) =>
    truss &&
    commit({ ...draft, trussPods: draft.trussPods.map((p) => (p.id === truss.id ? { ...p, ...patch } : p)) });
  const mainWallFull = 'This stage already has 8 screen entries. Remove a secondary screen to customise the main LED wall.';
  const editWall = (entry: PlanWall, patch: Partial<StageWall>) => {
    if (!canAuthorWall(entry, stageDraft)) return setMessage(mainWallFull);
    commitStage(upsertStageWall(draft, stageDraft, patchWall(entry, patch)));
  };
  const editHang = (patch: Partial<SpeakerHang>) => {
    const { hangs } = effectiveHangs(draft, stageDraft);
    if (hangs[index]) commitStage(setHangs(draft, stageDraft, hangs.map((h, i) => (i === index ? { ...h, ...patch } : h))));
  };
  const editSpan = (patch: Partial<LayoutTruss>) => {
    const list = stageDraft?.layout?.trusses ?? [];
    const target = list[index];
    if (!target) return;
    const next = { ...target, ...patch };
    if (spanLength(next) < MIN_LAYOUT_SPAN) {
      setMessage(`Keep the truss ends at least ${MIN_LAYOUT_SPAN} m apart.`);
      return;
    }
    commitStage(setLayoutTrusses(draft, stageDraft, list.map((t, i) => (i === index ? next : t))));
  };
  const editProp = (patch: Partial<LayoutProp>) => {
    const list = stageDraft?.layout?.props ?? [];
    if (list[index]) commitStage(setLayoutProps(draft, stageDraft, list.map((p, i) => (i === index ? { ...p, ...patch } : p))));
  };
  const remove = () => {
    if (platform)
      commit(
        withPlatforms(
          draft,
          originalPlatforms.filter((p) => p.id !== platform.id),
        ),
      );
    else if (truss) commit({ ...draft, trussPods: draft.trussPods.filter((p) => p.id !== truss.id) });
    else if (wall?.primary && wall.stock) {
      // The rig's own LED wall can't be deleted here; turn it off in the Rig builder instead.
      setMessage('The main LED wall comes from the rig. Turn it off in the Rig builder to remove it.');
      return;
    } else if (selected && isStageKind(selected.kind) && (wall || hang || span || prop)) {
      const cues = selected.kind === 'wall' ? stageDraft?.screenEvents.filter((e) => e.target === selected.id).length ?? 0 : 0;
      commitStage(removeStageItem(draft, stageDraft, selected as PlanItem));
      if (selected.kind === 'wall' && selected.id === 'main-led') {
        setMessage('Main screen returned to the rig LED wall.');
        return;
      }
      if (cues) setMessage(`Removed the screen and its ${cues} wall cue${cues === 1 ? '' : 's'}. Undo restores them.`);
    }
    setSelected(undefined);
  };
  const addPlatform = (a: PlanPoint, b: PlanPoint) => {
    if (originalPlatforms.length >= MAX_PLATFORMS) {
      setMessage(`A design can contain up to ${MAX_PLATFORMS} platforms.`);
      return;
    }
    if (Math.abs(b.x - a.x) < 0.25 || Math.abs(b.z - a.z) < 0.25) {
      setMessage('Draw a platform at least 0.25 m wide and deep.');
      return;
    }
    const p = {
      id: crypto.randomUUID(),
      name: `Platform ${originalPlatforms.length + 1}`,
      x: (a.x + b.x) / 2,
      z: (a.z + b.z) / 2,
      width: Math.abs(b.x - a.x),
      depth: Math.abs(b.z - a.z),
      height: 1,
    };
    commit(withPlatforms(draft, [...originalPlatforms, p]));
    choose('select');
    setSelected({ kind: 'platform', id: p.id });
  };
  const addWall = (at?: PlanPoint) => {
    if (!canAddWall(draft, stageDraft)) {
      setMessage(`A stage can carry up to ${MAX_STAGE_WALLS} screens, including the main LED wall.`);
      return;
    }
    const base = createSecondaryWall(draft, stageDraft);
    const placed = at ? { ...base, x: rounded(at.x), z: rounded(at.z) } : base;
    commitStage(upsertStageWall(draft, stageDraft, placed));
    choose('select');
    setSelected({ kind: 'wall', id: placed.id });
  };
  const addHang = (at: PlanPoint) => {
    if (!canAddHang(draft, stageDraft)) {
      setMessage(`A stage can carry up to ${MAX_LAYOUT_ITEMS} speaker hangs.`);
      return;
    }
    const { hangs } = effectiveHangs(draft, stageDraft);
    commitStage(setHangs(draft, stageDraft, [...hangs, newHang(draft, at)]));
    choose('select');
    setSelected({ kind: 'hang', id: String(hangs.length) });
  };
  const addSpan = (a: PlanPoint, b: PlanPoint) => {
    const list = stageDraft?.layout?.trusses ?? [];
    if (list.length >= MAX_LAYOUT_ITEMS) {
      setMessage(`A layout can carry up to ${MAX_LAYOUT_ITEMS} trusses.`);
      return false;
    }
    if (distance(a, b) < MIN_LAYOUT_SPAN) {
      setMessage(`Place the other end at least ${MIN_LAYOUT_SPAN} m away.`);
      return false;
    }
    const height = rounded(Math.max(0.5, Math.min(elevation, gridHeight - 0.3)));
    commitStage(setLayoutTrusses(draft, stageDraft, [...list, { x: a.x, z: a.z, endX: b.x, endZ: b.z, height }]));
    choose('select');
    setSelected({ kind: 'span', id: String(list.length) });
    return true;
  };
  const addProp = (at: PlanPoint) => {
    const list = stageDraft?.layout?.props ?? [];
    if (list.length >= MAX_LAYOUT_ITEMS) {
      setMessage(`A layout can carry up to ${MAX_LAYOUT_ITEMS} props.`);
      return;
    }
    commitStage(setLayoutProps(draft, stageDraft, [...list, { x: at.x, z: at.z, type: propType, height: 2 }]));
    choose('select');
    setSelected({ kind: 'prop', id: String(list.length) });
  };
  const addPoint = (point: PlanPoint) => {
    if (points.length >= MAX_PATH_POINTS) {
      setMessage(`A path can contain up to ${MAX_PATH_POINTS} points.`);
      return;
    }
    if (points.length && distance(points[points.length - 1], point) < MIN_TRUSS_SPAN) {
      setMessage('Place the next point at least 0.25 m away.');
      return;
    }
    setPoints([...points, point]);
    setNextPoint(point);
    setMessage('');
  };
  const finishPath = () => {
    if (points.length < 2) return;
    const p = makeTrussPath(points, elevation);
    p.motorMaxY = Math.max(elevation, Math.min(p.motorMaxY, gridHeight - 0.3));
    p.name = `Truss path ${draft.trussPods.length + 1}`;
    commit({ ...draft, trussPods: [...draft.trussPods, p] });
    choose('select');
    setSelected({ kind: 'truss', id: p.id });
  };
  const convertSpan = () => {
    const converted = convertLayoutTruss(draft, stageDraft, index);
    if (!converted) return;
    commitDraft(converted);
    const pod = converted.rig.trussPods[converted.rig.trussPods.length - 1];
    setSelected({ kind: 'truss', id: pod.id });
    setMessage(`${pod.name} is now a rig truss. Hang fixtures on it in the Rig builder.`);
  };
  const world = (e: PointerEvent<SVGSVGElement>, grid = true): PlanPoint => {
    const transform = svg.current!.getScreenCTM()!;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(transform.inverse());
    const round = (v: number) => (grid && snap ? rounded(Math.round(v / snap) * snap) : rounded(v));
    return { x: round(p.x), z: round(p.y) };
  };
  const pointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (drag || (e.button !== 0 && e.button !== 1)) return;
    e.currentTarget.focus();
    const at = world(e);
    if (tool === 'pan' || e.button === 1) {
      const raw = world(e, false);
      e.currentTarget.setPointerCapture(e.pointerId);
      setDrag({ origin: raw, at: raw, pan: view, pointer: e.pointerId });
      return;
    }
    if (tool === 'path') {
      addPoint(at);
      return;
    }
    if (tool === 'span') {
      if (!points.length) {
        setPoints([at]);
        setMessage('Click the other end of the truss.');
      } else if (addSpan(points[0], at)) setPoints([]);
      return;
    }
    if (tool === 'wall') return addWall(at);
    if (tool === 'hang') return addHang(at);
    if (tool === 'prop') return addProp(at);
    if (tool === 'platform') {
      e.currentTarget.setPointerCapture(e.pointerId);
      setDrag({ origin: at, at, pointer: e.pointerId });
      return;
    }
    const hit = (e.target as Element).closest<SVGElement>('[data-item]');
    if (!hit) {
      setSelected(undefined);
      return;
    }
    const selection: Selection = {
      kind: hit.dataset.item as Kind,
      id: hit.dataset.id!,
      node: hit.dataset.node === undefined ? undefined : Number(hit.dataset.node),
    };
    setSelected(selection);
    const entry = selection.kind === 'wall' ? walls.find((w) => w.wall.id === selection.id) : undefined;
    if (entry && !canAuthorWall(entry, stageDraft)) {
      setMessage(mainWallFull);
      return;
    }
    const origin = isAimHandle(selection) ? world(e, false) : at;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ origin, at: origin, pointer: e.pointerId, selection });
  };
  const pointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (drag && drag.pointer !== e.pointerId) return;
    const at = world(e, !drag?.pan && !isAimHandle(drag?.selection));
    if (drag?.pan) {
      setView((v) => ({ ...v, x: v.x + drag.origin.x - at.x, z: v.z + drag.origin.z - at.z }));
      return;
    }
    if (drag) setDrag({ ...drag, at });
    else if (tool === 'path' || (tool === 'span' && points.length)) setHover(at);
  };
  const pointerUp = (e: PointerEvent<SVGSVGElement>) => {
    if (!drag || drag.pointer !== e.pointerId) return;
    const at = world(e, !isAimHandle(drag.selection));
    setDrag(undefined);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (drag.pan) return;
    if (drag.selection) {
      if (distance(at, drag.origin) > 0.001) commitDraft(moveItem(history.now, drag.selection, drag.origin, at, angleStep));
    } else if (tool === 'platform') addPlatform(drag.origin, at);
  };
  const anchor = (): PlanPoint | undefined =>
    vertex ?? platform ?? truss ?? wall?.frame ?? hang ?? (span ? { x: span.x, z: span.z } : prop);
  const rotateSelection = (degrees: number) => {
    if (wall) editWall(wall, { yaw: wrapDegrees(wall.frame.yaw + degrees) });
    else if (hang) editHang({ yaw: wrapDegrees(hang.yaw + degrees) });
  };
  const handleKey = (e: KeyboardEvent<HTMLDialogElement>) => {
    e.stopPropagation();
    const editing = /^(INPUT|SELECT|TEXTAREA)$/.test((e.target as HTMLElement).tagName);
    if (e.key === 'Escape') {
      e.preventDefault();
      if (drag || tool !== 'select') {
        choose('select');
      } else onClose();
      return;
    }
    if (editing) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (tool === 'path' || tool === 'span') setPoints(points.slice(0, -1));
      else remove();
      return;
    }
    if (e.key === 'Enter' && e.target === svg.current && tool === 'path') {
      e.preventDefault();
      finishPath();
      return;
    }
    if (e.target !== svg.current || !selected || tool !== 'select') return;
    if ((e.key === '[' || e.key === ']') && (wall || hang)) {
      e.preventDefault();
      rotateSelection((e.key === ']' ? 1 : -1) * (e.shiftKey ? 15 : 5));
      return;
    }
    const step = (snap || 0.1) * (e.shiftKey ? 10 : 1);
    const deltas: Record<string, PlanPoint> = {
      ArrowLeft: { x: -step, z: 0 },
      ArrowRight: { x: step, z: 0 },
      ArrowUp: { x: 0, z: -step },
      ArrowDown: { x: 0, z: step },
    };
    const delta = deltas[e.key];
    if (!delta) return;
    e.preventDefault();
    if (wall && !canAuthorWall(wall, stageDraft)) return setMessage(mainWallFull);
    const from = anchor();
    // Arrow keys move the whole object; for platform and rig-truss handles they move the selected vertex.
    const target = isStageKind(selected.kind) ? { ...selected, node: undefined } : selected;
    if (from) commitDraft(moveItem(history.now, target, from, { x: from.x + delta.x, z: from.z + delta.z }, angleStep));
  };
  const height = view.width / aspect,
    left = view.x - view.width / 2,
    top = view.z - height / 2;
  const zoom = (factor: number) => setView((v) => ({ ...v, width: limit(v.width * factor, 3, 500) }));
  const units = view.width / Math.max(svg.current?.clientWidth || 700, 1);
  const labelEvery = Math.max(5, 5 * 10 ** Math.floor(Math.log10(view.width / 10)));
  const ticks = (start: number, end: number) => {
    const ticks: number[] = [];
    const first = Math.ceil(start / labelEvery) * labelEvery;
    for (let i = 0; i < 60 && first + i * labelEvery < end; i++) ticks.push(first + i * labelEvery);
    return ticks;
  };
  const apply = () => {
    const invalid = dialog.current?.querySelector<HTMLInputElement>(
      'input:invalid, input[aria-invalid="true"]',
    );
    if (invalid) {
      setMessage(`Check the value for ${invalid.getAttribute('aria-label')}.`);
      invalid.focus();
      return;
    }
    let next: RigConfig;
    let nextStage: NativeStage | undefined;
    let nextCrowd: CrowdLayout | undefined;
    try {
      next = parseRigJson(JSON.stringify(draft));
      nextStage = finalizeStage(next, stageDraft);
      nextCrowd = crowdDraft ? structuredClone(crowdDraft) : undefined;
      if (nextCrowd) resolveCrowdLayout(next, nextCrowd);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Check the geometry before applying this design.');
      return;
    }
    if (onChange(next, nextStage, nextCrowd, newDesignDrafts.current.has(draft)) === false) return;
    onClose();
  };
  const selectedKey = selected && (platform || truss || wall || hang || span || prop) ? `${PREFIX[selected.kind]}:${selected.id}` : '';
  const toolHints: Partial<Record<Tool, string>> = {
    platform: 'Drag from one corner to the opposite corner.',
    path: 'Click to place points. Finish the path when it has two or more.',
    wall: 'Click to place a secondary LED screen. Drag its arrow to aim it.',
    hang: 'Click the hang point of a line array. Drag its arrow to aim it.',
    span: points.length ? 'Click the other end of the truss.' : 'Click the two ends of a layout truss.',
    prop: 'Click to place a layout prop.',
    pan: 'Drag the plan to pan.',
  };
  const context = toolHints[tool] ?? (selectedKey
    ? wall || hang
      ? 'Drag to move, drag the arrow to aim. [ and ] rotate by 5°, arrow keys nudge.'
      : 'Drag the object or its handles. Arrow keys nudge the selection.'
    : 'Select an object to edit it.');
  const counts = [
    `${platforms.length} platforms`,
    `${draft.trussPods.length} trusses`,
    `${walls.length} screens`,
    `${hangInfo.hangs.length} speaker hangs${hangInfo.hangs.length && !hangInfo.authored ? ' (rig)' : ''}`,
    `${spans.length} layout trusses`,
    `${layoutProps.length} layout props`,
  ].join(' · ');
  const objectClass = (kind: Kind, active: boolean, extra = '') =>
    `sd-object sd-${kind} ${active ? 'sd-selected' : ''} ${extra}`.trim();
  const stageInspector = (): ReactNode => {
    if (wall) {
      const f = wall.frame;
      const cueCount = stageDraft?.screenEvents.filter((e) => e.target === wall.wall.id).length ?? 0;
      return (
        <>
          <p className="sd-note">
            {wall.primary ? (wall.stock ? 'Main LED wall from the rig. Editing pins its position and size.' : 'Custom main LED wall.')
              : `Secondary screen · ID ${wall.wall.id}${cueCount ? ` · ${cueCount} wall cue${cueCount === 1 ? '' : 's'}` : ''}`}
          </p>
          <label className="sd-field">
            <span>Screen label</span>
            <NameField label="Screen label" optional value={wall.wall.label ?? ''} onChange={(label) => editWall(wall, { label: label || undefined })} />
          </label>
          <div className="sd-fields">
            <Field label="Center X" min={-10000} max={10000} value={f.x} onChange={(x) => editWall(wall, { x })} />
            <Field label="Center Z" min={-10000} max={10000} value={f.z} onChange={(z) => editWall(wall, { z })} />
            <Field label="Center height" min={-10000} max={10000} value={f.y} onChange={(y) => editWall(wall, { y })} />
            <Field label="Yaw" unit="°" min={-360} max={360} value={f.yaw} onChange={(yaw) => editWall(wall, { yaw })} />
            <Field label="Screen width" min={0.2} max={MAX_WALL_WIDTH} value={f.width} onChange={(width) => editWall(wall, { width })} />
            <Field label="Screen height" min={0.2} max={MAX_WALL_HEIGHT} value={f.height} onChange={(h) => editWall(wall, { height: h })} />
          </div>
          <button className="sd-delete" onClick={remove} disabled={wall.primary && wall.stock}>
            {wall.primary ? 'Reset to rig LED wall' : 'Delete screen'}
          </button>
        </>
      );
    }
    if (hang) {
      return (
        <>
          <p className="sd-note">
            {hangInfo.authored ? `Speaker hang ${index + 1} of ${hangInfo.hangs.length}` : 'Rig flown array. Editing turns the rig arrays into authored hangs.'}
          </p>
          <div className="sd-fields">
            <Field label="Hang X" min={-10000} max={10000} value={hang.x} onChange={(x) => editHang({ x })} />
            <Field label="Hang Z" min={-10000} max={10000} value={hang.z} onChange={(z) => editHang({ z })} />
            <Field label="Trim height" min={-10000} max={10000} value={hang.y} onChange={(y) => editHang({ y })} />
            <Field label="Aim" unit="°" min={-360} max={360} value={hang.yaw} onChange={(yaw) => editHang({ yaw })} />
            <Field label="Tilt" unit="°" min={-360} max={360} value={hang.tilt} onChange={(tilt) => editHang({ tilt })} />
            <Field label="Splay" unit="°" min={-360} max={360} value={hang.splay} onChange={(splay) => editHang({ splay })} />
            <Field label="Boxes" unit="" integer min={1} max={16} value={hang.count} onChange={(count) => editHang({ count })} />
          </div>
          <button className="sd-delete" onClick={remove}>Remove hang</button>
          {hangInfo.authored && (
            <button onClick={() => { commitStage(setHangs(draft, stageDraft, undefined)); setSelected(undefined); }}>
              Use rig speaker arrays
            </button>
          )}
        </>
      );
    }
    if (span) {
      return (
        <>
          <p className="sd-note">Layout truss · {rounded(spanLength(span))} m span</p>
          <div className="sd-fields">
            <Field label="Start X" min={-10000} max={10000} value={span.x} onChange={(x) => editSpan({ x })} />
            <Field label="Start Z" min={-10000} max={10000} value={span.z} onChange={(z) => editSpan({ z })} />
            <Field label="End X" min={-10000} max={10000} value={span.endX} onChange={(endX) => editSpan({ endX })} />
            <Field label="End Z" min={-10000} max={10000} value={span.endZ} onChange={(endZ) => editSpan({ endZ })} />
            <Field label="Truss height" min={0.01} max={1000} value={span.height} onChange={(h) => editSpan({ height: h })} />
          </div>
          <button onClick={convertSpan} disabled={replaced} title={replaced ? 'Turn off “Replace rig layout” to add rig trusses' : undefined}>
            Convert to rig truss
          </button>
          <button className="sd-delete" onClick={remove}>Delete layout truss</button>
        </>
      );
    }
    if (prop) {
      return (
        <>
          <p className="sd-note">Layout prop {index + 1}</p>
          <div className="sd-fields">
            <Field label="Prop X" min={-10000} max={10000} value={prop.x} onChange={(x) => editProp({ x })} />
            <Field label="Prop Z" min={-10000} max={10000} value={prop.z} onChange={(z) => editProp({ z })} />
            <Field label="Prop height" min={0.01} max={1000} value={prop.height} onChange={(h) => editProp({ height: h })} />
          </div>
          <label className="sd-field">
            <span>Prop type</span>
            <select aria-label="Prop type" value={prop.type} onChange={(e) => editProp({ type: e.target.value as LayoutProp['type'] })}>
              <option value="inflatable">Inflatable</option>
              <option value="scenic">Scenic</option>
            </select>
          </label>
          <button className="sd-delete" onClick={remove}>Delete prop</button>
        </>
      );
    }
    return null;
  };
  const coverage = (h: SpeakerHang, radius: number) => {
    const half = HANG_COVERAGE_DEG / 2;
    const a = facing(h.yaw - half), b = facing(h.yaw + half);
    // Increasing yaw turns counter-clockwise on screen (+Z is down), so sweep-flag 0.
    return `M${h.x} ${h.z}L${h.x + a.x * radius} ${h.z + a.z * radius}A${radius} ${radius} 0 0 0 ${h.x + b.x * radius} ${h.z + b.z * radius}Z`;
  };
  return (
    <dialog
      className="stage-designer"
      aria-modal="true"
      aria-labelledby="sd-title"
      ref={dialog}
      onKeyDown={handleKey}
      onCancel={(e) => {
        e.preventDefault();
        if (tool !== 'select' || drag) choose('select');
        else onClose();
      }}
    >
      <div className="sd-shell">
        <header className="sd-heading">
          <div className="sd-heading-title">
            <DraftingCompass />
            <h2 id="sd-title">Stage designer</h2>
          </div>
          <div className="sd-rig-name">
            <NameField
              label="Design name"
              value={draft.name}
              onChange={(name) => commit({ ...draft, name })}
            />
          </div>
          <div className="sd-history">
            <button
              type="button"
              title="Undo"
              aria-label="Undo"
              disabled={!history.past.length}
              onClick={undo}
            >
              <Undo2 />
            </button>
            <button
              type="button"
              title="Redo"
              aria-label="Redo"
              disabled={!history.future.length}
              onClick={redo}
            >
              <Redo2 />
            </button>
          </div>
          <button className="sd-close" title="Close designer" aria-label="Close designer" onClick={onClose}>
            <X />
          </button>
        </header>
        <div className="sd-toolbar" role="toolbar" aria-label="Drawing tools">
          {guides.map(({ id, name, Icon }) => (
            <button
              key={id}
              aria-label={name}
              title={name}
              aria-pressed={tool === id}
              onClick={() => choose(id)}
            >
              <Icon />
              <span>{name}</span>
            </button>
          ))}
          <label className="sd-fixtures-toggle">
            <input
              type="checkbox"
              aria-label="Show fixtures on plan"
              checked={showFixtures}
              onChange={(e) => setShowFixtures(e.target.checked)}
            />
            <span>Fixtures</span>
          </label>
          <label className="sd-fixtures-toggle" title="Audience keep-out zone (0–3.0 m)">
            <input
              type="checkbox"
              aria-label="Show audience keep-out zone on plan"
              data-testid="plan-toggle-audience"
              checked={showAudienceZone}
              onChange={(e) => setShowAudienceZone(e.target.checked)}
            />
            <span>Audience</span>
          </label>
          <label className="sd-fixtures-toggle" title="Laser NOHD envelope (static beam, 0.25 s MPE)">
            <input
              type="checkbox"
              aria-label="Show laser NOHD zones on plan"
              data-testid="plan-toggle-nohd"
              checked={showLaserNohd}
              onChange={(e) => setShowLaserNohd(e.target.checked)}
            />
            <span>NOHD</span>
          </label>
          <label className="sd-fixtures-toggle" title="Approximate moving-head reach map on deck">
            <input
              type="checkbox"
              aria-label="Show fixture reach map on plan"
              data-testid="plan-toggle-reach"
              checked={showReachMap}
              onChange={(e) => setShowReachMap(e.target.checked)}
            />
            <span>Reach</span>
          </label>
          <label className="sd-snap">
            Snap{' '}
            <select aria-label="Grid snap" value={snap} onChange={(e) => setSnap(Number(e.target.value))}>
              <option value="0">Off</option>
              <option value="0.25">0.25 m</option>
              <option value="0.5">0.5 m</option>
              <option value="1">1 m</option>
            </select>
          </label>
        </div>
        <div className="sd-body">
          <section className="sd-plan" aria-label="Plan workspace">
            <svg
              ref={svg}
              className={`sd-canvas sd-tool-${tool}`}
              viewBox={`${left} ${top} ${view.width} ${height}`}
              aria-label="Stage plan in metres"
              role="application"
              tabIndex={0}
              onPointerDown={pointerDown}
              onPointerMove={pointerMove}
              onPointerUp={pointerUp}
              onPointerCancel={() => setDrag(undefined)}
              onPointerLeave={() => setHover(undefined)}
            >
              <defs>
                <pattern id="sd-grid" width="1" height="1" patternUnits="userSpaceOnUse">
                  <path d="M1 0H0V1" className="sd-gridline" />
                </pattern>
                <pattern id="sd-grid-major" width="5" height="5" patternUnits="userSpaceOnUse">
                  <rect width="5" height="5" fill="url(#sd-grid)" />
                  <path d="M5 0H0V5" className="sd-majorline" />
                </pattern>
              </defs>
              <rect x={left} y={top} width={view.width} height={height} fill="url(#sd-grid-major)" />
              <path d={`M${left} 0h${view.width} M0 ${top}v${height}`} className="sd-axis" />
              {shownCrowd && (
                <g data-testid="crowd-plan-overlay" pointerEvents="none" aria-hidden="true">
                  {shownCrowd.zones.map((zone) => (
                    <rect
                      key={`zone:${zone.id}`}
                      x={zone.rect.minX}
                      y={zone.rect.minZ}
                      width={zone.rect.maxX - zone.rect.minX}
                      height={zone.rect.maxZ - zone.rect.minZ}
                      fill="rgba(70, 170, 255, 0.08)"
                      stroke="rgba(70, 170, 255, 0.85)"
                      strokeWidth={Math.max(0.04, units)}
                      strokeDasharray={`${Math.max(0.18, units * 3)} ${Math.max(0.12, units * 2)}`}
                    />
                  ))}
                  {shownCrowd.exclusions.map((item) => (
                    <rect
                      key={`exclusion:${item.id}`}
                      x={item.rect.minX}
                      y={item.rect.minZ}
                      width={item.rect.maxX - item.rect.minX}
                      height={item.rect.maxZ - item.rect.minZ}
                      fill="rgba(255, 95, 95, 0.18)"
                      stroke="rgba(255, 95, 95, 0.9)"
                      strokeWidth={Math.max(0.05, units)}
                    />
                  ))}
                  {crowdResult?.value?.placements.map((person) => (
                    <circle
                      key={person.id}
                      cx={person.x}
                      cy={person.z}
                      r={person.source === 'explicit' ? 0.16 : 0.09}
                      fill={person.source === 'explicit' ? '#ffd166' : 'rgba(150, 220, 255, 0.75)'}
                    />
                  ))}
                </g>
              )}
              <g className="sd-grid-label" fontSize={9 * units}>
                {ticks(left + 60 * units, left + view.width - 20 * units).map((x) => (
                  <text key={'x' + x} x={x + 3 * units} y={top + 13 * units}>
                    {x}
                  </text>
                ))}
                {ticks(top + 27 * units, top + height - 30 * units).map((z) => (
                  <text key={'z' + z} x={left + 5 * units} y={z - 3 * units}>
                    {z}
                  </text>
                ))}
              </g>
              {platforms.map((p) => (
                <g
                  key={p.id}
                  data-item="platform"
                  data-id={p.id}
                  aria-label={p.name}
                  className={objectClass('platform', p.id === platform?.id, replaced ? 'sd-replaced' : '')}
                >
                  <rect x={p.x - p.width / 2} y={p.z - p.depth / 2} width={p.width} height={p.depth} />
                  <text x={p.x} y={p.z} fontSize={12 * units} textAnchor="middle" dominantBaseline="central">
                    {p.name}
                  </text>
                </g>
              ))}
              {shownRig.trussPods.map((p) => {
                const path = knots(p).map((q) => podWorldPoint(p, q)),
                  ring = p.shape === 'circle';
                return (
                  <g
                    key={p.id}
                    data-item="truss"
                    data-id={p.id}
                    aria-label={p.name}
                    className={objectClass('truss', p.id === truss?.id, replaced ? 'sd-replaced' : '')}
                  >
                    {ring ? (
                      <>
                        <circle className="sd-hit" cx={p.x} cy={p.z} r={p.width / 2} />
                        <circle cx={p.x} cy={p.z} r={p.width / 2} />
                      </>
                    ) : (
                      <>
                        <polyline className="sd-hit" points={pointString(path)} />
                        <polyline points={pointString(path)} />
                      </>
                    )}
                  </g>
                );
              })}
              {planFixtures.length > 0 && (
                <g
                  className="sf-fixture-symbols"
                  data-testid="plan-fixture-symbols"
                  pointerEvents="none"
                  aria-hidden="true"
                >
                  {planFixtures.map((unit) => {
                    const symbol = symbolForHardware(unit.group.type, unit.group.catalogId);
                    const deg = (-unit.yaw * 180) / Math.PI;
                    return (
                      <g
                        key={`${unit.podId ?? 'floor'}:${unit.group.id}:${unit.index}`}
                        className={`sf-plan-fixture sf-family-${symbol.family}`}
                        transform={`translate(${unit.position.x} ${unit.position.z}) rotate(${deg})`}
                      >
                        {symbol.plan.map((spec, si) => (
                          <path
                            key={si}
                            d={specToSvgPath(spec, false)}
                            className={`sf-sym-${spec.fill ?? 'body'}`}
                          />
                        ))}
                      </g>
                    );
                  })}
                </g>
              )}
              {planAudienceZone && (
                <g
                  data-testid="plan-audience-zone"
                  pointerEvents="none"
                  aria-hidden="true"
                >
                  <rect
                    x={planAudienceZone.minX}
                    y={planAudienceZone.minZ}
                    width={planAudienceZone.maxX - planAudienceZone.minX}
                    height={planAudienceZone.maxZ - planAudienceZone.minZ}
                    fill="rgba(244, 63, 94, 0.12)"
                    stroke="#fb7185"
                    strokeWidth={1.5 * units}
                    strokeDasharray={`${6 * units} ${4 * units}`}
                  />
                  <text
                    x={(planAudienceZone.minX + planAudienceZone.maxX) / 2}
                    y={planAudienceZone.minZ + 16 * units}
                    fontSize={10 * units}
                    fill="#fda4af"
                    textAnchor="middle"
                  >
                    AUDIENCE KEEP-OUT (0–3.0 m)
                  </text>
                </g>
              )}
              {planLaserZones.length > 0 && (
                <g
                  data-testid="plan-nohd-zones"
                  pointerEvents="none"
                  aria-hidden="true"
                >
                  {planLaserZones
                    .filter((z) => z.nohd.canDrawZone && z.planPolygon.length >= 3)
                    .map((z) => (
                      <g key={z.projectorKey}>
                        <polygon
                          points={z.planPolygon.map((p) => `${p.x},${p.z}`).join(' ')}
                          fill={z.audienceInsideNohd ? 'rgba(244, 63, 94, 0.14)' : 'rgba(245, 158, 11, 0.12)'}
                          stroke={z.audienceInsideNohd ? '#fb7185' : '#fbbf24'}
                          strokeWidth={1.3 * units}
                          strokeDasharray={`${4 * units} ${3 * units}`}
                        />
                        {z.nohd.nohdM !== null && (
                          <text
                            x={z.origin.x}
                            y={z.origin.z + 12 * units}
                            fontSize={8.5 * units}
                            fill={z.audienceInsideNohd ? '#fda4af' : '#fcd34d'}
                            textAnchor="middle"
                          >
                            NOHD ~{Math.round(z.nohd.nohdM)}m{z.nohd.assumedAperture ? '*' : ''}
                          </text>
                        )}
                      </g>
                    ))}
                  {planLaserZones
                    .filter((z) => !z.nohd.canDrawZone)
                    .map((z) => {
                      const r = 7 * units;
                      return (
                        <g key={`unknown:${z.projectorKey}`} data-testid="plan-nohd-unknown">
                          <polygon
                            points={`${z.origin.x},${z.origin.z - r} ${z.origin.x + r},${z.origin.z} ${z.origin.x},${z.origin.z + r} ${z.origin.x - r},${z.origin.z}`}
                            fill="rgba(244, 63, 94, 0.25)"
                            stroke="#fb7185"
                            strokeWidth={1.4 * units}
                            strokeDasharray={`${3 * units} ${2 * units}`}
                          />
                          <text
                            x={z.origin.x}
                            y={z.origin.z - 10 * units}
                            fontSize={8 * units}
                            fill="#fda4af"
                            textAnchor="middle"
                          >
                            NOHD ? (cannot assess)
                          </text>
                        </g>
                      );
                    })}
                </g>
              )}
              {planReachMap && (planReachMap.unionPolygon.length >= 3 || planReachMap.areas.some((a) => a.kind === 'locus')) && (
                <g
                  data-testid="plan-reach-map"
                  pointerEvents="none"
                  aria-hidden="true"
                >
                  {planReachMap.unionPolygon.length >= 3 && (
                    <polygon
                      points={planReachMap.unionPolygon.map((p) => `${p.x},${p.z}`).join(' ')}
                      fill="rgba(45, 212, 191, 0.09)"
                      stroke="#2dd4bf"
                      strokeWidth={1.4 * units}
                      strokeDasharray={`${5 * units} ${3 * units}`}
                    />
                  )}
                  {planReachMap.areas
                    .filter((a) => a.kind === 'locus' && a.points.length >= 2)
                    .map((a) => (
                      <line
                        key={a.unitId}
                        x1={a.points[0].x}
                        y1={a.points[0].z}
                        x2={a.points[1].x}
                        y2={a.points[1].z}
                        stroke="#38bdf8"
                        strokeWidth={1.5 * units}
                      />
                    ))}
                </g>
              )}
              {spans.map((t, i) => (
                <g key={'s' + i} data-item="span" data-id={i} aria-label={`Layout truss ${i + 1}`}
                  className={objectClass('span', selected?.kind === 'span' && index === i)}>
                  <line className="sd-hit" x1={t.x} y1={t.z} x2={t.endX} y2={t.endZ} />
                  <line x1={t.x} y1={t.z} x2={t.endX} y2={t.endZ} />
                  {selected?.kind === 'span' && index === i && (
                    <text x={(t.x + t.endX) / 2} y={(t.z + t.endZ) / 2 - 8 * units} fontSize={10 * units} textAnchor="middle">
                      {rounded(spanLength(t))} m
                    </text>
                  )}
                </g>
              ))}
              {layoutProps.map((p, i) => (
                <g key={'o' + i} data-item="prop" data-id={i} aria-label={`${p.type === 'inflatable' ? 'Inflatable' : 'Scenic'} prop ${i + 1}`}
                  className={objectClass('prop', selected?.kind === 'prop' && index === i)}>
                  {p.type === 'inflatable'
                    ? <circle cx={p.x} cy={p.z} r={0.55} />
                    : <rect x={p.x - 0.5} y={p.z - 0.5} width={1} height={1} />}
                  <text x={p.x} y={p.z + 0.95} fontSize={10 * units} textAnchor="middle">
                    {p.type === 'inflatable' ? 'Inflatable' : 'Scenery'}
                  </text>
                </g>
              ))}
              {walls.map(({ wall: w, frame: f, primary, stock }) => {
                const axis = widthAxis(f.yaw), front = facing(f.yaw), depth = 0.16;
                const outline = [-1, 1].flatMap((s) => [-1, 1].map((d) => ({
                  x: f.x + s * axis.x * f.width / 2 + d * front.x * depth,
                  z: f.z + s * axis.z * f.width / 2 + d * front.z * depth,
                })));
                const quad = [outline[0], outline[1], outline[3], outline[2]];
                const reach = Math.max(0.9, f.width * 0.25);
                const name = w.label ?? (primary ? 'Main LED wall' : w.id);
                return (
                  <g key={w.id} data-item="wall" data-id={w.id}
                    aria-label={`${name} screen, facing ${Math.round(f.yaw)}°`}
                    className={objectClass('wall', wall?.wall.id === w.id, `${primary ? 'sd-main' : ''} ${stock ? 'sd-stock' : ''}`)}>
                    <polygon className="sd-hit" points={pointString(quad)} />
                    <polygon points={pointString(quad)} />
                    <g className="sd-facing">
                      <Arrow from={f} to={{ x: f.x + front.x * reach, z: f.z + front.z * reach }} size={0.28} />
                    </g>
                    <text x={f.x - front.x * 0.55} y={f.z - front.z * 0.55} fontSize={10 * units} textAnchor="middle" dominantBaseline="central">
                      {name}
                    </text>
                  </g>
                );
              })}
              {hangInfo.hangs.map((h, i) => {
                const front = facing(h.yaw), side = widthAxis(h.yaw);
                const body = [[-0.3, -0.2], [0.3, -0.2], [0.3, 0.2], [-0.3, 0.2]].map(([s, d]) => ({
                  x: h.x + side.x * s + front.x * d, z: h.z + side.z * s + front.z * d,
                }));
                return (
                  <g key={'h' + i} data-item="hang" data-id={i}
                    aria-label={`Speaker hang ${i + 1}, ${h.count} boxes, aim ${Math.round(h.yaw)}°`}
                    className={objectClass('hang', selected?.kind === 'hang' && index === i, hangInfo.authored ? '' : 'sd-stock')}>
                    <path className="sd-coverage" d={coverage(h, 4)} />
                    <polygon points={pointString(body)} />
                    <g className="sd-facing">
                      <Arrow from={h} to={hangAimHandle(h)} size={0.25} />
                    </g>
                    <text x={h.x + side.x * 0.75} y={h.z + side.z * 0.75 - 0.45} fontSize={10 * units} textAnchor="middle">
                      {`Array ${i + 1} · ${h.count}`}
                    </text>
                  </g>
                );
              })}
              {tool === 'select' &&
                selected &&
                vertices.map((p, i) => {
                  const aim = isAimHandle({ ...selected, node: i });
                  const centre = wall?.frame ?? hang;
                  return (
                    <g
                      key={i}
                      data-item={selected.kind}
                      data-id={selected.id}
                      data-node={i}
                      aria-label={aim ? 'Aim handle' : selected.kind === 'wall' ? 'Width handle' : `Handle ${i + 1}`}
                      className={`sd-handle ${aim ? 'sd-aim-handle' : ''}`}
                    >
                      {aim && centre && <line className="sd-aim-line" x1={centre.x} y1={centre.z} x2={p.x} y2={p.z} />}
                      <circle className="sd-handle-hit" cx={p.x} cy={p.z} r={11 * units} />
                      <circle
                        className={selected.node === i ? 'sd-current-node' : ''}
                        cx={p.x}
                        cy={p.z}
                        r={(aim ? 5.2 : 4.3) * units}
                      />
                    </g>
                  );
                })}
              {tool === 'platform' && drag && !drag.pan && (
                <rect
                  className="sd-draft"
                  x={Math.min(drag.origin.x, drag.at.x)}
                  y={Math.min(drag.origin.z, drag.at.z)}
                  width={Math.abs(drag.at.x - drag.origin.x)}
                  height={Math.abs(drag.at.z - drag.origin.z)}
                />
              )}
              {(tool === 'path' || tool === 'span') && points.length > 0 && (
                <g className={tool === 'span' ? 'sd-path-draft sd-span-draft' : 'sd-path-draft'}>
                  <polyline points={pointString(hover ? [...points, hover] : points)} />
                  {points.map((p, i) => (
                    <circle key={i} cx={p.x} cy={p.z} r={4 * units} />
                  ))}
                </g>
              )}
            </svg>
            <span className="sd-orientation">↑ Upstage</span>
            <span className="sd-scale">1 m grid · Audience ↓</span>
            <div className="sd-view-tools">
              <button aria-label="Zoom in" title="Zoom in" onClick={() => zoom(0.78)}>
                <Plus />
              </button>
              <button aria-label="Zoom out" title="Zoom out" onClick={() => zoom(1 / 0.78)}>
                <Minus />
              </button>
              <button
                aria-label="Fit plan"
                title="Fit plan"
                onClick={() => setView(frameDesign(draft, aspect, stageDraft))}
              >
                <Maximize />
              </button>
            </div>
          </section>
          <aside className="sd-inspector">
            <h3>
              {tool === 'path' ? 'Draw truss path' : tool === 'platform' ? 'Draw platform' : tool === 'span' ? 'Draw layout truss'
                : tool === 'wall' ? 'Place screen' : tool === 'hang' ? 'Place speaker hang' : tool === 'prop' ? 'Place layout prop' : 'Selection'}
            </h3>
            {inspectedElevation !== undefined && <p>
              {draft.venue === 'club' ? 'Ceiling' : 'Rigging grid'} {gridHeight} m
              {inspectedElevation > gridHeight - 0.3 &&
                <strong className="sd-clearance-warning"> · Truss has less than 0.3 m overhead clearance</strong>}
            </p>}
            {tool === 'path' ? (
              <>
                <div className="sd-path-actions">
                  <button className="sd-positive" disabled={points.length < 2} onClick={finishPath}>
                    Finish path
                  </button>
                  <button onClick={() => choose('select')}>Cancel path</button>
                </div>
                <p>
                  {points.length} of {MAX_PATH_POINTS} points
                </p>
                <div className="sd-fields">
                  <Field
                    label="Next X"
                    value={nextPoint.x}
                    onChange={(x) => setNextPoint((p) => ({ ...p, x }))}
                  />
                  <Field
                    label="Next Z"
                    value={nextPoint.z}
                    onChange={(z) => setNextPoint((p) => ({ ...p, z }))}
                  />
                </div>
                <Field label="Truss elevation" value={elevation} min={0} onChange={setElevation} />
                <button onClick={() => addPoint(nextPoint)}>Add point</button>
                <button disabled={!points.length} onClick={() => setPoints(points.slice(0, -1))}>
                  Remove last point
                </button>
              </>
            ) : tool === 'platform' ? (
              <>
                <p>Drag a rectangle on the plan, or place a 4 × 3 m platform and edit its dimensions.</p>
                <button
                  onClick={() =>
                    addPlatform({ x: view.x - 2, z: view.z - 1.5 }, { x: view.x + 2, z: view.z + 1.5 })
                  }
                >
                  Place platform
                </button>
                <button onClick={() => choose('select')}>Cancel drawing</button>
              </>
            ) : tool === 'span' ? (
              <>
                <p>Layout trusses build in 3D and in the CAD plan. Convert one to a rig truss to hang fixtures on it.</p>
                <Field label="Truss elevation" value={elevation} min={0} onChange={setElevation} />
                <button onClick={() => choose('select')}>Cancel drawing</button>
              </>
            ) : tool === 'prop' ? (
              <>
                <label className="sd-field">
                  <span>New prop type</span>
                  <select aria-label="New prop type" value={propType} onChange={(e) => setPropType(e.target.value as LayoutProp['type'])}>
                    <option value="inflatable">Inflatable</option>
                    <option value="scenic">Scenic</option>
                  </select>
                </label>
                <button onClick={() => choose('select')}>Cancel placing</button>
              </>
            ) : tool === 'wall' || tool === 'hang' ? (
              <>
                <p>{tool === 'wall'
                  ? `Screens: ${walls.length} of ${MAX_STAGE_WALLS}. Each secondary screen can carry its own timed media cues.`
                  : `${hangInfo.hangs.length} hangs.${hangInfo.authored ? '' : ' Adding one turns the rig arrays into authored hangs.'}`}</p>
                {tool === 'wall' && <button onClick={() => addWall()}>Place at default position</button>}
                <button onClick={() => choose('select')}>Cancel placing</button>
              </>
            ) : (
              <>
                <label className="sd-field">
                  <span>Plan objects</span>
                  <select
                    aria-label="Plan objects"
                    value={selectedKey}
                    onChange={(e) => {
                      const value = e.target.value;
                      const kind = KIND_BY_PREFIX[value.split(':')[0]];
                      setSelected(value && kind ? { kind, id: value.slice(2) } : undefined);
                      setTool('select');
                    }}
                  >
                    <option value="">Select an object</option>
                    <optgroup label="Platforms">
                      {platforms.map((p) => (
                        <option key={p.id} value={`p:${p.id}`}>
                          {p.name}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Trusses">
                      {draft.trussPods.map((p) => (
                        <option key={p.id} value={`t:${p.id}`}>
                          {p.name}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Screens">
                      {walls.map(({ wall: w, primary }) => (
                        <option key={w.id} value={`w:${w.id}`}>
                          {w.label ?? (primary ? 'Main LED wall' : w.id)}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Speaker hangs">
                      {hangInfo.hangs.map((h, i) => (
                        <option key={i} value={`h:${i}`}>
                          Array {i + 1} · {h.count} boxes
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Layout trusses">
                      {spans.map((t, i) => (
                        <option key={i} value={`s:${i}`}>
                          Layout truss {i + 1} · {rounded(spanLength(t))} m
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Layout props">
                      {layoutProps.map((p, i) => (
                        <option key={i} value={`o:${i}`}>
                          {p.type === 'inflatable' ? 'Inflatable' : 'Scenery'} {i + 1}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                </label>
                {platform || truss ? (
                  <>
                    {replaced && <p className="sd-note">Hidden in 3D while “Replace rig layout” is on.</p>}
                    <label className="sd-field">
                      <span>Object name</span>
                      <NameField
                        label="Object name"
                        value={(platform ?? truss)!.name}
                        onChange={(name) => (platform ? editPlatform({ name }) : editTruss({ name }))}
                      />
                    </label>
                    <div className="sd-fields">
                      <Field
                        label="Center X"
                        value={(platform ?? truss)!.x}
                        onChange={(x) => (platform ? editPlatform({ x }) : editTruss({ x }))}
                      />
                      <Field
                        label="Center Z"
                        value={(platform ?? truss)!.z}
                        onChange={(z) => (platform ? editPlatform({ z }) : editTruss({ z }))}
                      />
                      {platform ? (
                        <>
                          <Field
                            label="Width"
                            min={0.25}
                            value={platform.width}
                            onChange={(width) => editPlatform({ width })}
                          />
                          <Field
                            label="Depth"
                            min={0.25}
                            value={platform.depth}
                            onChange={(depth) => editPlatform({ depth })}
                          />
                          <Field
                            label="Top height"
                            min={0.01}
                            value={platform.height}
                            onChange={(height) => editPlatform({ height })}
                          />
                        </>
                      ) : (
                        truss && (
                          <>
                            <Field
                              label="Elevation"
                              min={0}
                              value={truss.baseY}
                              onChange={(baseY) =>
                                editTruss({
                                  baseY,
                                  motorMinY: Math.min(baseY, truss.motorMinY),
                                  motorMaxY: Math.max(baseY, truss.motorMaxY),
                                })
                              }
                            />
                            <Field
                              label="Rotation"
                              unit="°"
                              value={(truss.rotationY * 180) / Math.PI}
                              onChange={(v) => editTruss({ rotationY: (v * Math.PI) / 180 })}
                            />
                            {truss.shape === 'path' ? (
                              <p className="sd-length">
                                Path length <strong>{rounded(pathLength(truss.path ?? []))} m</strong>
                              </p>
                            ) : (
                              <Field
                                label={truss.shape === 'circle' ? 'Diameter' : 'Span'}
                                min={0.25}
                                value={truss.width}
                                onChange={(width) => editTruss({ width })}
                              />
                            )}
                          </>
                        )
                      )}
                    </div>
                    <label className="sd-field">
                      <span>{platform ? 'Corner' : 'Vertex'}</span>
                      <select
                        aria-label="Selected vertex"
                        value={selected?.node ?? ''}
                        onChange={(e) =>
                          setSelected({
                            ...selected!,
                            node: e.target.value === '' ? undefined : Number(e.target.value),
                          })
                        }
                      >
                        <option value="">Whole object</option>
                        {vertices.map((_, i) => (
                          <option key={i} value={i}>
                            {platform ? 'Corner' : 'Vertex'} {i + 1}
                          </option>
                        ))}
                      </select>
                    </label>
                    {vertex && (
                      <div className="sd-fields">
                        <Field
                          label="Vertex X"
                          value={vertex.x}
                          onChange={(x) => commitDraft(moveItem(history.now, selected!, vertex, { ...vertex, x }, angleStep))}
                        />
                        <Field
                          label="Vertex Z"
                          value={vertex.z}
                          onChange={(z) => commitDraft(moveItem(history.now, selected!, vertex, { ...vertex, z }, angleStep))}
                        />
                      </div>
                    )}
                    <button className="sd-delete" onClick={remove}>
                      Delete {platform ? 'platform' : 'truss'}
                    </button>
                  </>
                ) : wall || hang || span || prop ? (
                  stageInspector()
                ) : (
                  <>
                    <p>{counts}</p>
                    <label className="sd-check">
                      <input
                        type="checkbox"
                        aria-label="Replace rig layout"
                        checked={replaced}
                        onChange={(e) => commitStage(setLayoutReplace(draft, stageDraft, e.target.checked))}
                      />
                      <span>Replace rig layout</span>
                    </label>
                    <p className="sd-note">
                      {replaced
                        ? 'The rig’s decks, trusses, floor effects and stock arrays are hidden; only the layout below builds in 3D and in the CAD plan.'
                        : 'Layout trusses, hangs and props add to the rig.'}
                    </p>
                    <label className="sd-check">
                      <input
                        type="checkbox"
                        aria-label="Authored crowd"
                        checked={!!crowdDraft}
                        onChange={(e) => commitCrowd(e.target.checked ? makeDefaultCrowd(draft) : undefined)}
                      />
                      <span>Authored crowd</span>
                    </label>
                    {crowdDraft && (
                      <div data-testid="crowd-editor">
                        <label className="sd-field">
                          <span>Generator seed</span>
                          <input
                            aria-label="Crowd generator seed"
                            type="number"
                            min={0}
                            max={4294967295}
                            step={1}
                            value={crowdDraft.seed}
                            onChange={(e) => {
                              const seed = Number(e.target.value);
                              if (Number.isSafeInteger(seed) && seed >= 0 && seed <= 4294967295) commitCrowd({ ...crowdDraft, seed });
                            }}
                          />
                        </label>
                        <label className="sd-field">
                          <span>Crowd model mix</span>
                          <select
                            aria-label="Crowd model mix"
                            value={crowdModelMix(crowdDraft)}
                            disabled={!crowdDraft.zones.length}
                            onChange={(e) => {
                              const mix = e.target.value as CrowdModelMix;
                              if (Object.hasOwn(CROWD_MODEL_PRESETS, mix)) commitCrowd(withCrowdModelMix(crowdDraft, mix));
                            }}
                          >
                            <option value="custom" disabled>Custom</option>
                            {Object.entries(CROWD_MODEL_PRESETS).map(([id, preset]) => (
                              <option key={id} value={id}>{preset.label}</option>
                            ))}
                          </select>
                        </label>
                        {crowdDraft.zones[0] && (
                          <label className="sd-field">
                            <span>Primary zone occupancy</span>
                            <input
                              aria-label="Crowd zone occupancy"
                              type="number"
                              min={0}
                              max={1}
                              step="any"
                              value={crowdDraft.zones[0].occupancy}
                              onChange={(e) => {
                                const occupancy = Number(e.target.value);
                                if (Number.isFinite(occupancy) && occupancy >= 0 && occupancy <= 1) {
                                  commitCrowd({
                                    ...crowdDraft,
                                    zones: crowdDraft.zones.map((zone, index) => index === 0 ? { ...zone, occupancy } : zone),
                                  });
                                }
                              }}
                            />
                          </label>
                        )}
                        <p className="sd-note" role={crowdResult?.error ? 'alert' : undefined}>
                          {crowdResult?.error || `${crowdResult?.value?.placed ?? 0} reproducible people · ${crowdDraft.zones.length} zone${crowdDraft.zones.length === 1 ? '' : 's'} · ${crowdDraft.exclusions.length} exclusion${crowdDraft.exclusions.length === 1 ? '' : 's'}`}
                        </p>
                        <button
                          disabled={crowdDraft.exclusions.length >= 32}
                          onClick={() => {
                            const bounds = computeVenueBounds(draft).audienceZone;
                            const halfWidth = Math.min(0.65, (bounds.maxX - bounds.minX) / 10);
                            const centreX = (bounds.minX + bounds.maxX) / 2;
                            const suffix = crowdDraft.exclusions.length + 1;
                            commitCrowd({
                              ...crowdDraft,
                              exclusions: [...crowdDraft.exclusions, {
                                id: `aisle-${suffix}`,
                                rect: { minX: centreX - halfWidth, minZ: bounds.minZ, maxX: centreX + halfWidth, maxZ: bounds.maxZ },
                              }],
                            });
                          }}
                        >
                          Add centre aisle
                        </button>
                        {crowdDraft.exclusions.length > 0 && (
                          <button onClick={() => commitCrowd({ ...crowdDraft, exclusions: crowdDraft.exclusions.slice(0, -1) })}>
                            Remove last exclusion
                          </button>
                        )}
                      </div>
                    )}
                    <button onClick={() => addWall()}>Add screen</button>
                  </>
                )}
              </>
            )}
            <button
              className="sd-new"
              onClick={() => {
                const blank = createBlankDesign(draft);
                commitDraft({ rig: blank, stage: undefined, crowd: undefined }, true);
                choose('select');
                setSelected(undefined);
                setView(frameDesign(blank, aspect));
              }}
            >
              New blank design
            </button>
          </aside>
        </div>
        <footer className="sd-footer">
          <p role="status">{message || context}</p>
          <button onClick={onClose}>Cancel</button>
          <button className="sd-apply" disabled={!!drag || points.length > 0} onClick={apply}>
            <Check />
            Apply design
          </button>
        </footer>
      </div>
    </dialog>
  );
}
