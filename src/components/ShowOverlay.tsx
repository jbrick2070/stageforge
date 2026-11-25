import { useEffect, useRef } from 'react';
import { Gamepad2 } from 'lucide-react';
import { DEMO_TOTAL_BARS, DEMO_TOTAL_STEPS } from '../data/demoShow';
import { useLive, type LiveStore } from '../state/liveTelemetry';
import type { AudioMetrics } from '../types/show';

interface Props {
  audioStore: LiveStore<AudioMetrics>;
  controller: 'connected' | 'waiting' | 'unsupported';
  cinema: boolean;
  showControllerGuide?: boolean;
}

export function ShowOverlay({ audioStore, controller, cinema, showControllerGuide = true }: Props) {
  const demo = useLive(audioStore).demo;
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (menu.current?.open && e.target instanceof Node && !menu.current.contains(e.target)) menu.current.open = false;
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && menu.current?.open) {
        menu.current.open = false;
        menu.current.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, []);
  return <div className="stage-show-hud">
    {demo && <div className="demo-progress" data-section={demo.sectionId} data-bar={demo.bar + 1} data-finished={demo.finished}>
      <div><strong>{demo.finished ? 'Show complete' : demo.label}</strong>
        <span>Bar {demo.bar + 1} / {DEMO_TOTAL_BARS}</span></div>
      <progress aria-label="Demo performance" value={demo.step} max={DEMO_TOTAL_STEPS} />
    </div>}
    {!cinema && showControllerGuide && <details ref={menu} className="controller-guide">
      <summary aria-label="Xbox controller guide" title="Xbox controller guide" data-connected={controller === 'connected'}>
        <Gamepad2 size={16} /> <span>Controller</span>
      </summary>
      <div className="controller-card">
        <strong>Xbox controller</strong>
        <p>{controller === 'connected' ? 'Connected' : controller === 'unsupported' ? 'Controller input is unavailable in this browser.' :
          'Connect via USB or Bluetooth, then press a button with this tab active.'}</p>
        <dl>
          <dt>A</dt><dd>Play / pause</dd>
          <dt>D-pad ← / →</dt><dd>Previous / next cue</dd>
          <dt>D-pad ↑ / ↓</dt><dd>Master dimmer ±5%</dd>
          <dt>LB / RB</dt><dd>Previous / next camera</dd>
          <dt>Right stick</dt><dd>Orbit camera</dd>
          <dt>B / X / Y</dt><dd>Hold blinders / laser / CO₂</dd>
          <dt>LT / RT</dt><dd>Hold smoke / strobe</dd>
          <dt>View / Menu</dt><dd>Auto-LD / cinema</dd>
        </dl>
      </div>
    </details>}
  </div>;
}
