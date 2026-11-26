import { useRef, useState } from 'react';
import { SHOW_CUES } from '../data/presets';
import type { ShowCue } from '../types/show';
import { DeskDialog } from './ShowFiles';

export function CueListEditor({ cues, capture, onApply, onClose }: {
  cues: ShowCue[]; capture: () => ShowCue; onApply: (cues: ShowCue[]) => void; onClose: () => void;
}) {
  const [list, setList] = useState(() => [...cues]);
  const [index, setIndex] = useState(0);
  const [removed, setRemoved] = useState<{ cue: ShowCue; index: number; beforeId?: string; afterId?: string } | null>(null);
  const order = useRef<HTMLSelectElement>(null);
  const cue = list[index];
  const edit = (patch: Partial<ShowCue>) => setList(list.map((c, i) => i === index ? { ...c, ...patch } : c));
  const move = (to: number) => {
    const next = [...list];
    [next[to], next[index]] = [next[index], next[to]];
    setList(next); setIndex(to);
  };
  const remove = () => {
    setRemoved({ cue, index, beforeId: list[index - 1]?.id, afterId: list[index + 1]?.id });
    setList(list.filter(item => item.id !== cue.id));
    if (index === list.length - 1) {
      // At the end of the stack a repeated click must never start deleting backwards.
      setIndex(-1);
      order.current?.focus();
    }
  };
  const undoRemove = () => {
    if (!removed) return;
    const nextIndex = list.findIndex(item => item.id === removed.afterId);
    const previousIndex = list.findIndex(item => item.id === removed.beforeId);
    let insertAt = Math.min(removed.index, list.length);
    if (nextIndex !== -1) insertAt = nextIndex;
    else if (previousIndex !== -1) insertAt = previousIndex + 1;
    setList([...list.slice(0, insertAt), removed.cue, ...list.slice(insertAt)]);
    setIndex(insertAt);
    setRemoved(null);
    order.current?.focus();
  };
  const apply = () => {
    onApply(list.map(item => {
      const name = item.name.trim();
      const original = cues.find(c => c.id === item.id);
      const factoryTag = SHOW_CUES.find(c => c.id === item.id)?.tag;
      const tag = original && name !== original.name && item.tag === factoryTag ? 'USER' : item.tag;
      return { ...item, name, tag };
    }));
    onClose();
  };
  const invalid = list.some(item => {
    const fade = item.fadeSeconds;
    const follow = item.followSeconds;
    const offset = item.screen?.offsetSeconds ?? 0;
    return !item.name.trim() || (fade !== undefined && !(fade >= 0 && fade <= 3600))
      || (follow !== undefined && !(follow > 0 && follow <= 3600))
      || !(offset >= 0 && offset <= Number.MAX_SAFE_INTEGER);
  });
  return <DeskDialog title="Edit cue list" onClose={onClose}>
    <form onSubmit={e => { e.preventDefault(); if (!invalid) apply(); }}>
      <label>Cue order<select ref={order} aria-label="Cue order" size={Math.min(8, Math.max(2, list.length))} value={cue?.id ?? ''}
        onChange={e => setIndex(list.findIndex(c => c.id === e.target.value))}>
        {!cue && <option value="" hidden>{list.length ? 'Select a cue to edit' : 'No cues'}</option>}
        {list.map((c,i) => <option key={c.id} value={c.id}>{i + 1}. {c.name}</option>)}
      </select></label>
      {cue && <>
        <label>Cue name<input required pattern=".*\S.*" maxLength={100} value={cue.name} onChange={e => edit({ name: e.target.value })}/></label>
        <label>Fade time (seconds)<input type="number" min="0" max="3600" step="any" placeholder="0 (cut)" value={cue.fadeSeconds ?? ''}
          onChange={e => edit({ fadeSeconds: e.target.value === '' ? undefined : Number(e.target.value) })}/></label>
        <label>Follow after (seconds)<input type="number" min="0" max="3600" step="any" placeholder="Manual GO" value={cue.followSeconds ?? ''}
          onChange={e => edit({ followSeconds: e.target.value === '' ? undefined : Number(e.target.value) })}/></label>
        {cue.screen?.kind === 'video' && <label>Video start (seconds)<input type="number" min="0" max={Number.MAX_SAFE_INTEGER}
          step="any" value={cue.screen.offsetSeconds ?? ''} placeholder="0" onChange={e => edit({
            screen: { ...cue.screen!, offsetSeconds: e.target.value === '' ? undefined : e.target.valueAsNumber },
          })}/></label>}
        <div className="file-actions"><button type="button" disabled={index === 0} onClick={() => move(index - 1)}>Move earlier</button>
          <button type="button" disabled={index === list.length - 1} onClick={() => move(index + 1)}>Move later</button>
          <button type="button" className="cue-remove" onClick={remove}>Remove cue “{cue.name.trim() || 'Untitled'}”</button></div>
      </>}
      {removed && <div className="cue-removal">
        <span role="status">Removed “{removed.cue.name.trim() || 'Untitled'}”.</span>
        <button type="button" onClick={undoRemove}>Undo remove</button>
      </div>}
      <div className="file-actions"><button type="button" onClick={() => { setList([...list,capture()]); setIndex(list.length); }}>Add current look</button>
        <button type="submit" disabled={invalid}>Apply cues</button></div>
    </form>
  </DeskDialog>;
}
