import { useState } from 'react';
import type { ShowCue } from '../types/show';
import { DeskDialog } from './ShowFiles';

export function CueListEditor({ cues, capture, onApply, onClose }: {
  cues: ShowCue[]; capture: () => ShowCue; onApply: (cues: ShowCue[]) => void; onClose: () => void;
}) {
  const [list, setList] = useState(() => [...cues]);
  const [index, setIndex] = useState(0);
  const cue = list[index];
  const edit = (patch: Partial<ShowCue>) => setList(list.map((c, i) => i === index ? { ...c, ...patch } : c));
  const move = (to: number) => {
    const next = [...list];
    [next[to], next[index]] = [next[index], next[to]];
    setList(next); setIndex(to);
  };
  return <DeskDialog title="Edit cue list" onClose={onClose}>
    <form onSubmit={e => { e.preventDefault(); onApply(list.map(c => ({ ...c, name: c.name.trim() }))); onClose(); }}>
      <label>Cue order<select aria-label="Cue order" size={Math.min(8, Math.max(2, list.length))} value={cue?.id ?? ''}
        onChange={e => setIndex(list.findIndex(c => c.id === e.target.value))}>
        {list.map((c,i) => <option key={c.id} value={c.id}>{i + 1}. {c.name}</option>)}
      </select></label>
      {cue && <>
        <label>Cue name<input required pattern=".*\S.*" maxLength={100} value={cue.name} onChange={e => edit({ name: e.target.value })}/></label>
        <label>Follow after (seconds)<input type="number" min="0.001" max="3600" step="any" placeholder="Manual GO" value={cue.followSeconds ?? ''}
          onChange={e => edit({ followSeconds: e.target.value === '' ? undefined : Number(e.target.value) })}/></label>
        <div className="file-actions"><button type="button" disabled={index === 0} onClick={() => move(index - 1)}>Move earlier</button>
          <button type="button" disabled={index === list.length - 1} onClick={() => move(index + 1)}>Move later</button>
          <button type="button" onClick={() => { setList(list.filter(c => c.id !== cue.id)); setIndex(Math.max(0,index - 1)); }}>Remove cue</button></div>
      </>}
      <div className="file-actions"><button type="button" onClick={() => { setList([...list,capture()]); setIndex(list.length); }}>Add current look</button>
        <button type="submit" disabled={list.some(c => !c.name.trim() || (c.followSeconds !== undefined && !(c.followSeconds > 0 && c.followSeconds <= 3600)))}>Apply cues</button></div>
    </form>
  </DeskDialog>;
}
