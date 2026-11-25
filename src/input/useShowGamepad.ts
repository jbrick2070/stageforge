import { useEffect, useRef, useState } from 'react';
import type { BumpState } from '../types/show';

type Command = 'play' | 'prevCue' | 'nextCue' | 'prevCamera' | 'nextCamera' | 'masterUp' | 'masterDown' | 'auto' | 'cinema' | 'audioReactive';
const taps: [number, Command][] = [
  [0, 'play'], [4, 'prevCamera'], [5, 'nextCamera'], [8, 'auto'], [9, 'cinema'],
  [12, 'masterUp'], [13, 'masterDown'], [14, 'prevCue'], [15, 'nextCue'],
];
const AUDIO_REACTIVE_BUTTON = 10; // L3 (left stick click): require a brief 250 ms hold to prevent accidental clicks while orbiting.
const AUDIO_REACTIVE_HOLD_MS = 250;
const holds: [number, keyof BumpState][] = [
  [1, 'blinder'], [2, 'laser'], [3, 'co2'], [6, 'smoke'], [7, 'strobe'],
];
type Handlers = {
  enabled: boolean;
  command: (action: Command) => void;
  hold: (effect: keyof BumpState, down: boolean) => void;
  orbit: (horizontal: number, vertical: number) => void;
};
type ControllerStatus = 'waiting' | 'connected' | 'unsupported';

export function useShowGamepad(handlers: Handlers) {
  const latest = useRef(handlers);
  latest.current = handlers;
  const [status, setStatus] = useState<ControllerStatus>('waiting');
  useEffect(() => {
    if (!navigator.getGamepads) {
      setStatus('unsupported');
      return;
    }
    let frame = 0;
    let lastStatus: ControllerStatus = 'waiting';
    const report = (next: ControllerStatus) => {
      if (next !== lastStatus) {
        lastStatus = next;
        setStatus(next);
      }
    };
    let current = '';
    let previous: boolean[] = [];
    let previousTime = 0;
    let stickReady = false;
    let activeWindow = document.hasFocus();
    const held = new Set<keyof BumpState>();
    let audioHoldStart: number | null = null;
    let audioHoldFired = false;
    const reset = () => {
      held.forEach(effect => latest.current.hold(effect, false));
      held.clear();
      current = '';
      previous = [];
      stickReady = false;
      audioHoldStart = null;
      audioHoldFired = false;
    };
    const poll = (now: number) => {
      const dt = Math.min(0.05, (now - previousTime) / 1000);
      previousTime = now;
      let pads: (Gamepad | null)[];
      try {
        pads = Array.from(navigator.getGamepads());
      } catch {
        reset();
        report('unsupported');
        return;
      }
      const pad = pads.find(p => p?.connected && p.mapping === 'standard');
      const editable = document.activeElement?.matches('textarea, input:not([type=button]):not([type=range]), [contenteditable=true]');
      const ready = latest.current.enabled && activeWindow && !document.hidden && !editable;
      if (!pad || !ready) {
        if (current) reset();
        report(pad ? 'connected' : 'waiting');
      } else {
        const identity = pad.index + '/' + pad.id;
        const buttons = pad.buttons.map((button, index) => button.pressed ||
          ((index === 6 || index === 7) && button.value > (previous[index] ? 0.30 : 0.55)));
        if (current !== identity) {
          reset();
          current = identity;
          report('connected');
        } else {
          for (const [i, action] of taps) if (buttons[i] && !previous[i]) latest.current.command(action);
          if (buttons[AUDIO_REACTIVE_BUTTON]) {
            if (audioHoldStart === null) audioHoldStart = now;
            else if (!audioHoldFired && now - audioHoldStart >= AUDIO_REACTIVE_HOLD_MS) {
              audioHoldFired = true;
              latest.current.command('audioReactive');
            }
          } else {
            audioHoldStart = null;
            audioHoldFired = false;
          }
          for (const [i, effect] of holds) {
            if (buttons[i] && !previous[i]) {
              held.add(effect);
              latest.current.hold(effect, true);
            } else if (!buttons[i] && held.delete(effect)) latest.current.hold(effect, false);
          }
          const x = pad.axes[2] ?? 0, y = pad.axes[3] ?? 0;
          const length = Math.hypot(x, y);
          if (length <= 0.18) stickReady = true;
          else if (stickReady && dt > 0) {
            const scale = Math.min(1, (length - 0.18) / 0.82) ** 1.5 * 1.65 * dt / length;
            latest.current.orbit(x * scale, y * scale);
          }
        }
        previous = buttons;
      }
      frame = requestAnimationFrame(poll);
    };
    const blur = () => { activeWindow = false; reset(); };
    const focus = () => { activeWindow = true; };
    const visibility = () => { if (document.hidden) reset(); };
    const disconnect = (event: GamepadEvent) => {
      if (current === event.gamepad.index + '/' + event.gamepad.id) { reset(); report('waiting'); }
    };
    window.addEventListener('blur', blur);
    window.addEventListener('focus', focus);
    window.addEventListener('gamepaddisconnected', disconnect);
    document.addEventListener('visibilitychange', visibility);
    frame = requestAnimationFrame(poll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('blur', blur);
      window.removeEventListener('focus', focus);
      window.removeEventListener('gamepaddisconnected', disconnect);
      document.removeEventListener('visibilitychange', visibility);
      reset();
    };
  }, []);
  return status;
}
