import React, { createContext, useContext } from 'react';
import type { BumpState, CameraPreset } from '../types/show';

export interface Capabilities {
  readonly edit: boolean;
  readonly save: boolean;
  readonly autosave: boolean;
  readonly liveOutput: boolean;
  readonly showControl: boolean;
  readonly mutatingHotkeys: boolean;
  readonly controllers: boolean;
}

export type AppMode = 'editor' | 'viewer';

export const EDITOR_CAPABILITIES: Capabilities = Object.freeze({
  edit: true,
  save: true,
  autosave: true,
  liveOutput: true,
  showControl: true,
  mutatingHotkeys: true,
  controllers: true,
});

export const VIEWER_CAPABILITIES: Capabilities = Object.freeze({
  edit: false,
  save: false,
  autosave: false,
  liveOutput: false,
  showControl: false,
  mutatingHotkeys: false,
  controllers: false,
});

export function capabilitiesForMode(mode: AppMode): Capabilities {
  return mode === 'viewer' ? VIEWER_CAPABILITIES : EDITOR_CAPABILITIES;
}

/**
 * Pure URL query check for the `?view` flag.
 * Strictly boolean: any parameter value is ignored and never treated as a URL to fetch.
 */
export function isViewerUrlSearch(search: string): boolean {
  if (!search) return false;
  return new URLSearchParams(search).has('view');
}

export type GlobalHotkeyAction =
  | { readonly type: 'playPause' }
  | { readonly type: 'go' }
  | { readonly type: 'back' }
  | { readonly type: 'camera'; readonly preset: CameraPreset }
  | { readonly type: 'cinema' }
  | { readonly type: 'blackout' }
  | { readonly type: 'bump'; readonly key: keyof BumpState }
  | { readonly type: 'tapTempo' };

const CAMERA_HOTKEYS: Readonly<Record<string, CameraPreset>> = Object.freeze({
  Digit1: 'foh',
  Digit2: 'front_row',
  Digit3: 'wide_arena',
  Digit4: 'stage_side',
  Digit5: 'overhead',
  Digit6: 'orbit',
  Digit7: 'pa_closeup',
});

const BUMP_HOTKEYS: Readonly<Record<string, keyof BumpState>> = Object.freeze({
  KeyB: 'blinder',
  KeyS: 'strobe',
  KeyC: 'co2',
  KeyF: 'smoke',
  KeyL: 'laser',
  KeyD: 'motorDrop',
});

/**
 * Resolve a physical KeyboardEvent.code to a StageForge global hotkey action under the
 * active capability set.
 *
 * - Both modes allow camera presets (Digit1–Digit7) and cinema mode (KeyH).
 * - Editor mode (`mutatingHotkeys: true`) keeps blackout (Space), momentary FX bumps
 *   (B/S/C/F/L/D), and tap tempo (T).
 * - Viewer mode (`mutatingHotkeys: false`) allows ONLY playback/navigation: play/pause
 *   (Space), cue GO (ArrowRight / PageDown), cue Back (ArrowLeft / PageUp), camera
 *   presets (Digit1–Digit7), and cinema mode (KeyH). All mutating keys return `null`.
 */
export function resolveGlobalHotkey(
  code: string,
  capabilities: Capabilities,
): GlobalHotkeyAction | null {
  if (Object.hasOwn(CAMERA_HOTKEYS, code)) {
    return { type: 'camera', preset: CAMERA_HOTKEYS[code] };
  }
  if (code === 'KeyH') {
    return { type: 'cinema' };
  }

  if (capabilities.mutatingHotkeys) {
    if (code === 'Space') return { type: 'blackout' };
    if (code === 'KeyT') return { type: 'tapTempo' };
    if (Object.hasOwn(BUMP_HOTKEYS, code)) {
      return { type: 'bump', key: BUMP_HOTKEYS[code] };
    }
    return null;
  }

  // Read-only viewer allow-list: play/pause, go/back (plus camera + cinema above).
  if (code === 'Space') return { type: 'playPause' };
  if (code === 'ArrowRight' || code === 'PageDown') return { type: 'go' };
  if (code === 'ArrowLeft' || code === 'PageUp') return { type: 'back' };
  return null;
}

const CapabilitiesContext = createContext<Capabilities>(EDITOR_CAPABILITIES);

export function CapabilitiesProvider({
  value,
  children,
}: {
  value: Capabilities;
  children: React.ReactNode;
}) {
  return React.createElement(CapabilitiesContext.Provider, { value }, children);
}

export function useCapabilities(): Capabilities {
  return useContext(CapabilitiesContext);
}
