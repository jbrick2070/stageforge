import { useEffect, useRef, useState } from 'react';
import { Monitor, Trash2, Upload } from 'lucide-react';
import type { NativeStage } from '../data/showFile';
import type { SecondaryScreenEvent } from '../data/studioGeometry';
import { timecode } from './ShowFiles';

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

export function SecondaryScreenCues({
  stage,
  playheadMs,
  onApplyEvent,
  onRemoveEvent,
}: {
  stage?: NativeStage;
  playheadMs: number;
  onApplyEvent: (event: SecondaryScreenEvent, file?: File) => void;
  onRemoveEvent: (target: string, atMs: number) => void;
}) {
  const walls = (stage?.walls ?? []).filter(w => w.id !== 'main-led');
  const [target, setTarget] = useState(walls[0]?.id ?? '');
  const activeTarget = walls.some(w => w.id === target) ? target : (walls[0]?.id ?? '');
  const events = (stage?.screenEvents ?? []).filter(e => e.target === activeTarget);

  const [timeSec, setTimeSec] = useState('0');
  const [action, setAction] = useState<'play' | 'hold' | 'clear'>('play');
  const [clipName, setClipName] = useState('');
  const [offsetSec, setOffsetSec] = useState('0');
  const [pickedFile, setPickedFile] = useState<File | undefined>();
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const latest = [...events].reverse().find(e => e.atMs <= playheadMs) ?? events[0];
    setTimeSec(String(Number((playheadMs / 1000).toFixed(2))));
    if (latest && latest.kind !== 'none') {
      setClipName(latest.name);
      setAction(latest.playing ? 'play' : 'hold');
      setOffsetSec(String(latest.offsetSeconds ?? 0));
    } else if (!events.length) {
      setClipName('');
      setAction('play');
      setOffsetSec('0');
    }
    setPickedFile(undefined);
    setError('');
  }, [activeTarget]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!walls.length) return null;

  const commit = () => {
    const at = Number(timeSec);
    if (!Number.isFinite(at) || at < 0) {
      setError('Enter a non-negative time in seconds.');
      return;
    }
    const atMs = Math.round(at * 1000);
    if (action === 'clear') {
      setError('');
      onApplyEvent({ atMs, target: activeTarget, kind: 'none', name: '', playing: false });
      return;
    }
    const cleanName = clipName.trim();
    if (!cleanName || cleanName === '.' || cleanName === '..') {
      setError('Choose a video/image file or enter a filename.');
      return;
    }
    // Same portable-name rule as show bundles, so every wall cue can be packaged.
    if (/[\\/:\x00-\x1f\x7f]/u.test(cleanName) || cleanName.length > 512) {
      setError('Use a plain filename without slashes, colons or control characters (512 characters max).');
      return;
    }
    const offset = Number(offsetSec);
    if (!Number.isFinite(offset) || offset < 0) {
      setError('Offset must be zero or greater.');
      return;
    }
    const file = pickedFile?.name === cleanName ? pickedFile : undefined;
    const kind = file
      ? (file.type.startsWith('image/') ? 'image' : 'video')
      : (IMAGE_EXT.test(cleanName) ? 'image' : 'video');
    setError('');
    onApplyEvent({
      atMs,
      target: activeTarget,
      kind,
      name: cleanName,
      playing: kind === 'video' && action === 'play',
      ...(kind === 'video' ? { offsetSeconds: offset } : {}),
    }, file);
    setPickedFile(undefined);
  };

  return (
    <div className="mt-2 pt-2 border-t border-white/10 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono-tech text-[9px] tracking-widest text-fuchsia-300 flex items-center gap-1">
          <Monitor className="w-3 h-3" /> SECONDARY SCREEN CUES
        </span>
        <select
          aria-label="Secondary screen"
          value={activeTarget}
          onChange={e => setTarget(e.currentTarget.value)}
          className="rounded bg-zinc-900 border border-white/15 px-1.5 py-0.5 text-[10px] text-zinc-100"
        >
          {walls.map(w => (
            <option key={w.id} value={w.id}>
              {w.label ? `${w.label} (${w.id})` : w.id}
            </option>
          ))}
        </select>
      </div>

      {events.length > 0 && (
        <ul className="max-h-20 overflow-y-auto space-y-0.5 text-[10px] font-mono-tech">
          {events.map(ev => (
            <li key={`${ev.target}-${ev.atMs}`} className="flex items-center justify-between gap-1 bg-white/5 rounded px-1.5 py-0.5">
              <button
                type="button"
                className="text-left truncate flex-1 text-zinc-200 hover:text-white cursor-pointer"
                onClick={() => {
                  setTimeSec(String(Number((ev.atMs / 1000).toFixed(2))));
                  setAction(ev.kind === 'none' ? 'clear' : ev.playing ? 'play' : 'hold');
                  setClipName(ev.name);
                  setOffsetSec(String(ev.offsetSeconds ?? 0));
                  setPickedFile(undefined);
                }}
              >
                <span className="text-fuchsia-300">{timecode(ev.atMs)}</span>{' '}
                {ev.kind === 'none'
                  ? 'Clear'
                  : `${ev.name} · ${ev.playing ? 'Play' : 'Hold'}${ev.offsetSeconds ? ` @${ev.offsetSeconds}s` : ''}`}
              </button>
              <button
                type="button"
                aria-label={`Remove wall cue at ${timecode(ev.atMs)}`}
                onClick={() => onRemoveEvent(ev.target, ev.atMs)}
                className="text-zinc-400 hover:text-rose-300 cursor-pointer p-0.5"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-3 gap-1 text-[10px]">
        <label className="grid gap-0.5 text-zinc-300">
          <span>Cue time (s)</span>
          <input
            type="number"
            aria-label="Wall cue time (s)"
            min={0}
            step={0.1}
            value={timeSec}
            onChange={e => setTimeSec(e.currentTarget.value)}
            className="w-full rounded bg-zinc-900 border border-white/15 px-1 py-0.5 font-mono-tech text-zinc-100"
          />
        </label>
        <label className="grid gap-0.5 text-zinc-300">
          <span>Action</span>
          <select
            aria-label="Wall cue action"
            value={action}
            onChange={e => setAction(e.currentTarget.value as 'play' | 'hold' | 'clear')}
            className="w-full rounded bg-zinc-900 border border-white/15 px-1 py-0.5 text-zinc-100"
          >
            <option value="play">Play</option>
            <option value="hold">Hold</option>
            <option value="clear">Clear</option>
          </select>
        </label>
        <label className="grid gap-0.5 text-zinc-300">
          <span>Offset (s)</span>
          <input
            type="number"
            aria-label="Wall cue offset (s)"
            min={0}
            step={0.1}
            disabled={action === 'clear'}
            value={offsetSec}
            onChange={e => setOffsetSec(e.currentTarget.value)}
            className="w-full rounded bg-zinc-900 border border-white/15 px-1 py-0.5 font-mono-tech text-zinc-100 disabled:opacity-40"
          />
        </label>
      </div>

      <div className="flex items-center gap-1">
        {action !== 'clear' && (
          <>
            <input
              type="text"
              aria-label="Wall cue media filename"
              placeholder="clip.mp4"
              value={clipName}
              onChange={e => setClipName(e.currentTarget.value)}
              className="flex-1 min-w-0 rounded bg-zinc-900 border border-white/15 px-1.5 py-0.5 text-[10px] font-mono-tech text-zinc-100"
            />
            <input
              ref={fileRef}
              type="file"
              aria-label="Load secondary screen media"
              accept="video/*,image/*"
              className="hidden"
              onChange={e => {
                const file = e.currentTarget.files?.[0];
                if (file) {
                  setPickedFile(file);
                  setClipName(file.name);
                  setError('');
                }
                e.currentTarget.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/15 border border-white/15 text-[10px] font-mono-tech text-zinc-200 flex items-center gap-1 shrink-0 cursor-pointer"
            >
              <Upload className="w-3 h-3" /> Clip
            </button>
          </>
        )}
        <button
          type="button"
          onClick={commit}
          className="px-2 py-0.5 rounded bg-fuchsia-500/25 hover:bg-fuchsia-500/40 border border-fuchsia-400/50 text-[10px] font-mono-tech text-fuchsia-100 shrink-0 cursor-pointer ml-auto"
        >
          Apply wall cue
        </button>
      </div>
      {error && <p role="alert" className="text-[10px] text-amber-300">{error}</p>}
    </div>
  );
}
