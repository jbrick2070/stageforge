import type { SmpteFrameRate } from '../data/showFile';

export type { SmpteFrameRate };

export interface SmpteTimecode {
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
  fps: SmpteFrameRate;
}

export const SMPTE_RATES: readonly SmpteFrameRate[] = [24, 25, 29.97, 30];
export const DAY_MS = 86_400_000;

export function fpsToSmpteType(fps: SmpteFrameRate): 0 | 1 | 2 | 3 {
  if (fps === 24) return 0;
  if (fps === 25) return 1;
  if (fps === 29.97) return 2;
  return 3;
}

export function smpteTypeToFps(type: number): SmpteFrameRate | null {
  if (type === 0) return 24;
  if (type === 1) return 25;
  if (type === 2) return 29.97;
  if (type === 3) return 30;
  return null;
}

export function frameDurationMs(fps: SmpteFrameRate): number {
  return fps === 29.97 ? 1001 / 30 : 1000 / fps;
}

export function isValidSmpte(tc: SmpteTimecode): boolean {
  const { hours, minutes, seconds, frames, fps } = tc;
  if (!Number.isInteger(hours) || hours < 0 || hours > 23) return false;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) return false;
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 59) return false;
  const maxFrames = fps === 24 ? 23 : fps === 25 ? 24 : fps === 29.97 || fps === 30 ? 29 : -1;
  if (maxFrames < 0 || !Number.isInteger(frames) || frames < 0 || frames > maxFrames) return false;
  // 29.97 DF drops frames 00 and 01 at the start of every minute except every 10th minute.
  if (fps === 29.97 && seconds === 0 && minutes % 10 !== 0 && (frames === 0 || frames === 1)) {
    return false;
  }
  return true;
}

export function smpteToMs(tc: SmpteTimecode): number | null {
  if (!isValidSmpte(tc)) return null;
  const { hours, minutes, seconds, frames, fps } = tc;
  if (fps === 29.97) {
    const totalMinutes = hours * 60 + minutes;
    const dropped = 2 * (totalMinutes - Math.floor(totalMinutes / 10));
    const frameNumber = (hours * 3600 + minutes * 60 + seconds) * 30 + frames - dropped;
    return (frameNumber * 1001) / 30;
  }
  const frameNumber = ((hours * 60 + minutes) * 60 + seconds) * fps + frames;
  return (frameNumber * 1000) / fps;
}

// Offsets are stored as whole milliseconds, so a position can sit up to 0.5 ms before its frame boundary
// (01:00:00;00 at 29.97 DF is 3,599,996.4 ms, stored as 3,599,996). Tolerate half a millisecond so it
// still reads as that frame instead of the one before.
const HALF_MS_IN_FRAMES_DF = (0.5 * 30) / 1001;

export function msToSmpte(rawMs: number, fps: SmpteFrameRate): SmpteTimecode {
  const safeMs = Number.isFinite(rawMs) ? rawMs : 0;
  const wrappedMs = ((safeMs % DAY_MS) + DAY_MS) % DAY_MS;
  if (fps === 29.97) {
    const framesPerDay = 2_589_408; // 144 * 17982 frames in 24h
    const fn = Math.floor((wrappedMs * 30) / 1001 + HALF_MS_IN_FRAMES_DF) % framesPerDay;
    const d = Math.floor(fn / 17982);
    const m = fn % 17982;
    const adjusted = fn + 18 * d + (m < 2 ? 0 : 2 * Math.floor((m - 2) / 1798));
    const frames = adjusted % 30;
    const totalSeconds = Math.floor(adjusted / 30);
    const seconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const minutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60) % 24;
    return { hours, minutes, seconds, frames, fps };
  }
  const framesPerDay = 86_400 * fps;
  const fn = Math.floor((wrappedMs * fps) / 1000 + (0.5 * fps) / 1000) % framesPerDay;
  const frames = fn % fps;
  const totalSeconds = Math.floor(fn / fps);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60) % 24;
  return { hours, minutes, seconds, frames, fps };
}

export function formatSmpte(tc: SmpteTimecode): string {
  const sep = tc.fps === 29.97 ? ';' : ':';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(tc.hours)}:${p(tc.minutes)}:${p(tc.seconds)}${sep}${p(tc.frames)}`;
}

export function parseSmpteString(raw: string, fps: SmpteFrameRate): number | null {
  const match = raw.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[:;](\d{2})$/);
  if (!match) return null;
  const tc: SmpteTimecode = {
    hours: Number(match[1]),
    minutes: Number(match[2]),
    seconds: Number(match[3]),
    frames: Number(match[4]),
    fps,
  };
  const ms = smpteToMs(tc);
  return ms === null ? null : Math.round(ms);
}
