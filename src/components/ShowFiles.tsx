import { Fragment, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { NativeStage, ShowMedia, ShowTimeline, TimelineEvent } from '../data/showFile';

export type FileAction = 'show' | 'bundle' | 'rig' | 'dxf' | 'glb' | 'csv';
export const timecode = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}.${String(Math.floor(ms % 1000 / 100))}`;
};

function describe(event: TimelineEvent, cueNames: Map<string, string>) {
  const parts: string[] = [];
  if (event.cueId) parts.push('Cue · ' + (cueNames.get(event.cueId) ?? event.cueId));
  if (event.music) parts.push(event.music.kind === 'none' ? 'Music off' : `Music · ${event.music.name} · ${event.music.playing ? 'play' : 'pause'}`);
  if (event.screen) parts.push(event.screen.kind === 'none' ? 'Main LED · no file' : `Main LED · ${event.screen.name} · ${event.screen.kind === 'image' ? 'image' : event.screen.playing ? 'play' : 'pause'}`);
  if (event.camera) parts.push('Camera · ' + event.camera.replaceAll('_', ' '));
  if (event.volume !== undefined) parts.push(`Volume · ${Math.round(event.volume * 100)}%`);
  if (event.bump) parts.push('Momentary FX · ' + (Object.entries(event.bump).filter(([, on]) => on).map(([k]) => k).join(', ') || 'release'));
  if (event.look) {
    if (event.look.blackout !== undefined) parts.push(event.look.blackout ? 'Blackout on' : 'Blackout off');
    const names = Object.keys(event.look).filter(k => k !== 'blackout').map(k => k.replace(/([A-Z])/g, ' $1').toLowerCase());
    if (names.length) parts.push('Desk · ' + names.join(', '));
  }
  return parts.join(' / ') || 'Clear cue selection';
}

function describeWallEvent(event: NativeStage['screenEvents'][number], wallNames: Map<string, string>) {
  const wall = wallNames.get(event.target) ?? event.target;
  if (event.kind === 'none') return `${wall} · clear`;
  const mode = event.kind === 'image' ? 'image' : event.playing ? 'play' : 'pause';
  const offset = event.kind === 'video' && event.offsetSeconds ? ` @${event.offsetSeconds}s` : '';
  return `${wall} · ${event.name} · ${mode}${offset}`;
}

export function DeskDialog({ title, onClose, children }: {title: string; onClose: () => void; children: ReactNode}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current!;
    el.showModal();
    return () => el.close();
  }, []);
  return <dialog ref={dialog} className="desk-dialog" aria-label={title} onCancel={e => { e.preventDefault(); onClose(); }}>
    <header><h2>{title}</h2><button aria-label={'Close ' + title} onClick={onClose}>Close</button></header>
    {children}
  </dialog>;
}

export function ShowFiles({ name, media, stage, timeline, missing, cueNames, onOpen, onExample, onSave, onRelink, onClose }: {
  name: string; media: ShowMedia; stage?: NativeStage; timeline?: ShowTimeline; missing: string[]; cueNames: Map<string, string>;
  onOpen: (file: File) => Promise<void>; onSave: (action: FileAction) => Promise<void>;
  onExample: (name: 'amber-walk-on' | 'split-rig') => Promise<void>;
  onRelink: (files: File[]) => string; onClose: () => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  const picker = useRef<HTMLInputElement>(null);
  const relink = useRef<HTMLInputElement>(null);
  const job = async (fn: () => Promise<void>) => {
    setBusy(true); setNote('');
    try { await fn(); } catch (e) { setNote(e instanceof Error ? e.message : 'Could not complete the file operation.'); }
    finally { setBusy(false); }
  };
  const wallNames = new Map((stage?.walls ?? []).map(w => [w.id, w.label || w.id]));
  const actions: Array<{ atMs: number; text: string }> = [
    ...(timeline?.events ?? []).map(e => ({ atMs: e.atMs, text: describe(e, cueNames) })),
    ...(stage?.screenEvents ?? []).map(e => ({ atMs: e.atMs, text: describeWallEvent(e, wallNames) })),
  ].sort((a, b) => a.atMs - b.atMs);
  const takeDuration = Math.max(timeline?.durationMs ?? 0, stage?.screenEvents.at(-1)?.atMs ?? 0);
  return <DeskDialog title="Show files" onClose={onClose}>
    <p className="file-show-name">{name}</p>
    <div className="file-actions">
      <button disabled={busy} onClick={() => picker.current?.click()}>Open show or rig…</button>
      <button disabled={busy} onClick={() => void job(() => onSave('show'))}>Save show JSON</button>
      <button disabled={busy} onClick={() => void job(() => onSave('bundle'))}>Save show bundle</button>
      <input type="file" hidden ref={picker} accept=".json,.zip,application/json,application/zip" aria-label="Open show file"
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void job(async () => { await onOpen(f); onClose(); }); }}/>
    </div>
    <p>The show bundle includes the rig, cues and linked media for offline playback.</p>
    <div className="file-actions">
      <button disabled={busy} onClick={() => void job(async () => { await onExample('amber-walk-on'); onClose(); })}>Open Amber Walk-on example</button>
      <button disabled={busy} onClick={() => void job(async () => { await onExample('split-rig'); onClose(); })}>Open Split Rig rehearsal</button>
      <a href="https://github.com/jbrick2070/stageforge/blob/main/docs/show-format.md" target="_blank" rel="noreferrer">Format &amp; source</a>
    </div>
    <h3>Media</h3>
    <dl><dt>Music</dt><dd>{media.music.kind === 'none' ? 'None' : media.music.name}</dd>
      <dt>Main LED wall</dt><dd>{media.screen.kind === 'none' ? 'No file assigned' : media.screen.name + (media.screen.kind === 'video' ? (media.screen.playing ? ' · playing' : ' · paused') : ' · image')}</dd>
      {(stage?.walls ?? []).filter(w => w.id !== 'main-led').map(wall => {
        const names = [...new Set((stage?.screenEvents ?? []).filter(e => e.target === wall.id && e.kind !== 'none').map(e => e.name))];
        return <Fragment key={wall.id}><dt>{wall.label || wall.id}</dt><dd>{names.length ? names.join(', ') : 'No file assigned'}</dd></Fragment>;
      })}</dl>
    {missing.length > 0 && <p>Files to relink: {missing.join(', ')}</p>}
    <button disabled={!missing.length} onClick={() => relink.current?.click()}>Relink media files…</button>
    <input type="file" hidden multiple ref={relink} aria-label="Relink media files" accept="audio/*,video/*,image/*"
      onChange={e => { setNote(onRelink(Array.from(e.target.files ?? []))); e.target.value = ''; }}/>
    {(timeline || actions.length > 0) && <details className="take-list"><summary>Recorded actions · {timecode(takeDuration)} · {actions.length} events</summary>
      <ol>{actions.slice(page * 30, (page + 1) * 30).map((e, i) =>
        <li key={i}><time>{timecode(e.atMs)}</time><span>{e.text}</span></li>)}</ol>
      {actions.length > 30 && <div className="file-actions"><button disabled={!page} onClick={() => setPage(page - 1)}>Previous actions</button>
        <button disabled={(page + 1) * 30 >= actions.length} onClick={() => setPage(page + 1)}>Next actions</button></div>}
    </details>}
    <h3>Exchange formats</h3>
    <div className="file-formats">{([['dxf','CAD plan','DXF'],['glb','3D scene','GLB'],['csv','DMX channel patch','CSV'],['rig','Rig only','JSON']] as const).map(([kind, label, extension]) =>
      <button key={kind} disabled={busy} onClick={() => void job(() => onSave(kind))}>{label} <small>{extension}</small></button>)}</div>
    <p role="status">{busy ? 'Preparing file…' : note}</p>
  </DeskDialog>;
}
