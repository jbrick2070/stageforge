import React from 'react';
import { Clock, Radio } from 'lucide-react';
import { useLive, type LiveStore } from '../state/liveTelemetry';
import type { ChaseLockState, ClockMode } from '../showControl/clockOwner';
import type { TimecodeReadout } from '../showControl/useShowControl';

interface ClockBadgeProps {
  clockMode: ClockMode;
  lockState: ChaseLockState;
  tcStore: LiveStore<TimecodeReadout>;
  onReturnToMaster: () => void;
  onOpenShowControl: () => void;
}

const LOCK_LABEL: Record<ChaseLockState, string> = {
  UNLOCKED: 'WAIT',
  LOCKING: 'LOCKING',
  LOCKED: 'LOCK',
  FREEWHEEL: 'FREEWHEEL',
  STOPPED: 'STOP',
};

/**
 * Always-visible clock-ownership indicator whenever StageForge is NOT in internal Master mode
 * (including Cinema mode). Renders null in default Master mode so default DOM is unchanged.
 */
export const ClockBadge: React.FC<ClockBadgeProps> = ({
  clockMode,
  lockState,
  tcStore,
  onReturnToMaster,
  onOpenShowControl,
}) => {
  const tc = useLive(tcStore);
  if (clockMode === 'master') return null;

  const isChase = clockMode === 'chase';
  const statusAnnouncement = isChase
    ? `Clock owner: Chase external timecode, ${LOCK_LABEL[lockState]}`
    : 'Clock owner: External cue caller';

  return (
    <div
      data-testid="clock-owner-badge"
      className={`flex items-center gap-2 rounded-full border px-2.5 py-1 shadow-xl backdrop-blur-md font-mono-tech text-[10px] ${
        isChase
          ? lockState === 'LOCKED'
            ? 'bg-emerald-950/90 border-emerald-400/70 text-emerald-100'
            : lockState === 'FREEWHEEL'
              ? 'bg-amber-950/90 border-amber-400/70 text-amber-100'
              : 'bg-cyan-950/90 border-cyan-400/70 text-cyan-100'
          : 'bg-violet-950/90 border-violet-400/70 text-violet-100'
      }`}
    >
      <span role="status" className="sr-only">{statusAnnouncement}</span>
      <button
        type="button"
        onClick={onOpenShowControl}
        className="flex items-center gap-1.5 cursor-pointer hover:opacity-90"
        title="Open Show Control settings"
      >
        {isChase ? <Clock className="w-3 h-3" aria-hidden="true" /> : <Radio className="w-3 h-3" aria-hidden="true" />}
        <span className="font-bold tracking-wider uppercase">
          {isChase ? 'CHASE' : 'CALLER'}
        </span>
        {isChase ? (
          <>
            <span aria-hidden="true" className="tabular-nums text-white">{tc.formatted}</span>
            <span className="rounded bg-black/40 px-1 py-0.5 text-[9px] font-bold">
              {LOCK_LABEL[lockState]}
            </span>
          </>
        ) : (
          <span className="text-violet-200/90">OSC · MSC</span>
        )}
      </button>
      <button
        type="button"
        data-testid="clock-badge-master"
        onClick={onReturnToMaster}
        className="rounded-full bg-white/15 hover:bg-white/25 px-2 py-0.5 text-[9px] font-bold text-white cursor-pointer"
        title="Return clock ownership to StageForge Master"
      >
        Master
      </button>
    </div>
  );
};
