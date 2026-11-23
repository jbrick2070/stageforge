import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { parseRigJson } from '../data/rigImport';
import {
  Check,
  DraftingCompass,
  Hand,
  Maximize,
  MousePointer2,
  Plus,
  Redo2,
  Route,
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
import type { PlanPoint, RigConfig, StagePlatform, TrussPodConfig } from '../types/show';
import { GRID_HEIGHT } from '../data/stageEquipment';
import './StageDesigner.css';

type Tool = 'select' | 'platform' | 'path' | 'pan';
type Selection = { kind: 'platform' | 'truss'; id: string; node?: number };
type View = { x: number; z: number; width: number };
type Drag = { origin: PlanPoint; at: PlanPoint; pointer: number; selection?: Selection; pan?: View };
type EditorProps = { rig: RigConfig; onChange: (rig: RigConfig) => void; onClose: () => void };
const guides = [
  { id: 'select', name: 'Select', Icon: MousePointer2 },
  { id: 'platform', name: 'Platform', Icon: Square },
  { id: 'path', name: 'Truss path', Icon: Route },
  { id: 'pan', name: 'Pan', Icon: Hand },
] as const;
const rounded = (n: number) => Number(n.toFixed(3));
const distance = (a: PlanPoint, b: PlanPoint) => Math.hypot(a.x - b.x, a.z - b.z);
const limit = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const pointString = (points: PlanPoint[]) => points.map((p) => `${p.x},${p.z}`).join(' ');

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
function frameDesign(rig: RigConfig, aspect: number): View {
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
function moveItem(rig: RigConfig, selection: Selection, from: PlanPoint, at: PlanPoint): RigConfig {
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
function Field({
  label,
  value,
  onChange,
  min,
  unit = 'm',
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  unit?: string;
}) {
  const [text, setText] = useState(String(rounded(value)));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(String(rounded(value)));
    setInvalid(false);
  }, [value]);
  const finish = () => {
    const next = Number(text);
    if (text.trim() !== '' && Number.isFinite(next) && (min === undefined || next >= min)) {
      if (next !== value) onChange(next);
      setText(String(rounded(next)));
      setInvalid(false);
    } else setInvalid(true);
  };
  return (
    <label className="sd-field">
      <span>{label}</span>
      <span className="sd-input-unit">
        <input
          type="number"
          required
          step="any"
          min={min}
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
          {min === undefined ? 'Enter a finite number.' : `Minimum ${min} ${unit}.`}
        </span>
      )}
    </label>
  );
}
function NameField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      aria-label={label}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const next = text.trim();
        if (next && next !== value) onChange(next);
        setText(next || value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
}

export function StageDesigner({ rig, onChange, onClose }: EditorProps) {
  const [history, setHistory] = useState(() => ({
    past: [] as RigConfig[],
    now: structuredClone(rig),
    future: [] as RigConfig[],
  }));
  const draft = history.now;
  const [tool, setTool] = useState<Tool>('select');
  const [selected, setSelected] = useState<Selection>();
  const [points, setPoints] = useState<PlanPoint[]>([]);
  const [drag, setDrag] = useState<Drag>();
  const [nextPoint, setNextPoint] = useState<PlanPoint>({ x: 0, z: 0 });
  const [hover, setHover] = useState<PlanPoint>();
  const [snap, setSnap] = useState(0.5);
  const gridHeight = GRID_HEIGHT[draft.venue];
  const [elevation, setElevation] = useState(() => Math.min(7, gridHeight - 0.8));
  const [message, setMessage] = useState('');
  const [aspect, setAspect] = useState(1.5);
  const [view, setView] = useState<View>(() => frameDesign(rig, 1.5));
  const dialog = useRef<HTMLDialogElement>(null),
    svg = useRef<SVGSVGElement>(null);
  const originalRig = useRef(rig);
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
      if (!previous) setView(frameDesign(originalRig.current, ratio));
      previous = ratio;
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      element.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  const originalPlatforms = getPlatforms(draft);
  const showing = drag?.selection ? moveItem(draft, drag.selection, drag.origin, drag.at) : draft;
  const platforms = getPlatforms(showing);
  const platform = selected?.kind === 'platform' ? platforms.find((p) => p.id === selected.id) : undefined;
  const truss = selected?.kind === 'truss' ? showing.trussPods.find((p) => p.id === selected.id) : undefined;
  const inspectedElevation = tool === 'path' ? elevation : truss?.baseY;
  const vertices = platform
    ? corners(platform)
    : truss
      ? knots(truss).map((p) => podWorldPoint(truss, p))
      : [];
  const vertex = selected?.node !== undefined ? vertices[selected.node] : undefined;
  const commit = (next: RigConfig) => {
    setHistory((h) => ({ past: [...h.past.slice(-79), h.now], now: next, future: [] }));
    setMessage('');
  };
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
  const undo = () => {
    resetGesture();
    setHistory((h) =>
      h.past.length
        ? { past: h.past.slice(0, -1), now: h.past[h.past.length - 1], future: [h.now, ...h.future] }
        : h,
    );
  };
  const redo = () => {
    resetGesture();
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
  const remove = () => {
    if (platform)
      commit(
        withPlatforms(
          draft,
          originalPlatforms.filter((p) => p.id !== platform.id),
        ),
      );
    else if (truss) commit({ ...draft, trussPods: draft.trussPods.filter((p) => p.id !== truss.id) });
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
      kind: hit.dataset.item as Selection['kind'],
      id: hit.dataset.id!,
      node: hit.dataset.node === undefined ? undefined : Number(hit.dataset.node),
    };
    setSelected(selection);
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ origin: at, at, pointer: e.pointerId, selection });
  };
  const pointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (drag && drag.pointer !== e.pointerId) return;
    const at = world(e, !drag?.pan);
    if (drag?.pan) {
      setView((v) => ({ ...v, x: v.x + drag.origin.x - at.x, z: v.z + drag.origin.z - at.z }));
      return;
    }
    if (drag) setDrag({ ...drag, at });
    else if (tool === 'path') setHover(at);
  };
  const pointerUp = (e: PointerEvent<SVGSVGElement>) => {
    if (!drag || drag.pointer !== e.pointerId) return;
    const at = world(e);
    setDrag(undefined);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (drag.pan) return;
    if (drag.selection) {
      if (distance(at, drag.origin) > 0.001) commit(moveItem(draft, drag.selection, drag.origin, at));
    } else if (tool === 'platform') addPlatform(drag.origin, at);
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
      if (tool === 'path') setPoints(points.slice(0, -1));
      else remove();
      return;
    }
    if (e.key === 'Enter' && e.target === svg.current && tool === 'path') {
      e.preventDefault();
      finishPath();
      return;
    }
    if (e.target !== svg.current || !selected || tool !== 'select') return;
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
    const from = vertex ?? platform ?? truss;
    if (from) commit(moveItem(draft, selected, from, { x: from.x + delta.x, z: from.z + delta.z }));
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
    try {
      next = parseRigJson(JSON.stringify(draft));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Check the geometry before applying this design.');
      return;
    }
    onChange(next);
    onClose();
  };
  const selectedKey = platform ? `p:${platform.id}` : truss ? `t:${truss.id}` : '';
  const context =
    tool === 'platform'
      ? 'Drag from one corner to the opposite corner.'
      : tool === 'path'
        ? 'Click to place points. Finish the path when it has two or more.'
        : tool === 'pan'
          ? 'Drag the plan to pan.'
          : selectedKey
            ? 'Drag the object or its handles. Arrow keys nudge the selection.'
            : 'Select a platform or truss to edit it.';
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
                  className={`sd-object sd-platform ${p.id === platform?.id ? 'sd-selected' : ''}`}
                >
                  <rect x={p.x - p.width / 2} y={p.z - p.depth / 2} width={p.width} height={p.depth} />
                  <text x={p.x} y={p.z} fontSize={12 * units} textAnchor="middle" dominantBaseline="central">
                    {p.name}
                  </text>
                </g>
              ))}
              {showing.trussPods.map((p) => {
                const path = knots(p).map((q) => podWorldPoint(p, q)),
                  ring = p.shape === 'circle';
                return (
                  <g
                    key={p.id}
                    data-item="truss"
                    data-id={p.id}
                    aria-label={p.name}
                    className={`sd-object sd-truss ${p.id === truss?.id ? 'sd-selected' : ''}`}
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
              {tool === 'select' &&
                vertices.map((p, i) => (
                  <g
                    key={i}
                    data-item={selected!.kind}
                    data-id={selected!.id}
                    data-node={i}
                    className="sd-handle"
                  >
                    <circle className="sd-handle-hit" cx={p.x} cy={p.z} r={11 * units} />
                    <circle
                      className={selected?.node === i ? 'sd-current-node' : ''}
                      cx={p.x}
                      cy={p.z}
                      r={4.3 * units}
                    />
                  </g>
                ))}
              {tool === 'platform' && drag && !drag.pan && (
                <rect
                  className="sd-draft"
                  x={Math.min(drag.origin.x, drag.at.x)}
                  y={Math.min(drag.origin.z, drag.at.z)}
                  width={Math.abs(drag.at.x - drag.origin.x)}
                  height={Math.abs(drag.at.z - drag.origin.z)}
                />
              )}
              {tool === 'path' && points.length > 0 && (
                <g className="sd-path-draft">
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
                onClick={() => setView(frameDesign(draft, aspect))}
              >
                <Maximize />
              </button>
            </div>
          </section>
          <aside className="sd-inspector">
            <h3>
              {tool === 'path' ? 'Draw truss path' : tool === 'platform' ? 'Draw platform' : 'Selection'}
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
            ) : (
              <>
                <label className="sd-field">
                  <span>Plan objects</span>
                  <select
                    aria-label="Plan objects"
                    value={selectedKey}
                    onChange={(e) => {
                      const value = e.target.value;
                      setSelected(
                        value
                          ? { kind: value.startsWith('p:') ? 'platform' : 'truss', id: value.slice(2) }
                          : undefined,
                      );
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
                  </select>
                </label>
                {platform || truss ? (
                  <>
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
                          onChange={(x) => commit(moveItem(draft, selected!, vertex, { ...vertex, x }))}
                        />
                        <Field
                          label="Vertex Z"
                          value={vertex.z}
                          onChange={(z) => commit(moveItem(draft, selected!, vertex, { ...vertex, z }))}
                        />
                      </div>
                    )}
                    <button className="sd-delete" onClick={remove}>
                      Delete {platform ? 'platform' : 'truss'}
                    </button>
                  </>
                ) : (
                  <p>
                    {platforms.length} platforms · {draft.trussPods.length} trusses
                  </p>
                )}
              </>
            )}
            <button
              className="sd-new"
              onClick={() => {
                const blank = createBlankDesign(draft);
                commit(blank);
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
