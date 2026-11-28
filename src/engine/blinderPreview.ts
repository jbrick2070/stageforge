import { isLogicalDmxUniverse, type LogicalDmxUniverse } from '../data/dmxUniverses';
import type { FixturePatchUnit } from '../data/dmxPatch';
import type { ArtNetPreviewLevels } from '../dmx/artNetPreviewLevels';
import {
  canReleaseScalarHandoff,
  copyScalarGovernorState,
  createScalarGovernorState,
  observeScalarDelivery,
  recordFlashFall,
  stepFinalPreviewScalar,
  stepGovernedScalar,
  type ScalarGovernorState,
} from './flashGovernor';
import type { PreviewFlashState } from './previewFlash';

interface BlinderInputAddress { universe: LogicalDmxUniverse; start: number }
export interface BlinderPreviewBinding {
  unitId: string;
  address: BlinderInputAddress | null;
}

export function resolveBlinderPreviewBinding(
  group: { type: string; catalogId?: string; dmxChannels?: number },
  patch: FixturePatchUnit,
): BlinderPreviewBinding {
  const valid = group.type === 'blinder' && group.catalogId === undefined && group.dmxChannels === 1 &&
    patch.width === 1 && isLogicalDmxUniverse(patch.universe) && Number.isInteger(patch.effectiveStart) &&
    patch.effectiveStart > 0 && patch.effectiveStart <= 512 && !patch.conflict && !patch.overflow && !patch.unsupportedUniverse;
  return { unitId: patch.unitId, address: valid ? { universe: patch.universe, start: patch.effectiveStart } : null };
}

interface BlinderPreviewUnit extends BlinderPreviewBinding {
  governor: ScalarGovernorState;
  route: 'desk' | 'external' | 'returning' | 'joiningDesk';
  changedAt: number;
  generation: number | null;
  seenSequence: number;
}

const sameAddress = (a: BlinderInputAddress | null, b: BlinderInputAddress | null) =>
  a?.universe === b?.universe && a?.start === b?.start;

/** Final visual lens owners. The desk still synthesizes all DMX bytes independently. */
export class BlinderPreviewBank {
  private units = new Map<string, BlinderPreviewUnit>();
  private readonly roomGovernor = createScalarGovernorState();
  private emptyHandoff = false;
  private documentEpoch = 0;
  private hasDeskLens = true;
  private pendingFall = false;
  limited = false;

  reconcile(bindings: readonly BlinderPreviewBinding[], input: ArtNetPreviewLevels, state: PreviewFlashState, now: number): void {
    const previous = this.units;
    const next = new Map<string, BlinderPreviewUnit>();
    const hadHandoff = this.hasExternalOrHandoff();
    const mixedDelivery = input.source === 'external' || hadHandoff;
    for (const binding of bindings) {
      const old = previous.get(binding.unitId);
      if (old && sameAddress(old.address, binding.address)) {
        next.set(binding.unitId, old);
        continue;
      }
      const governor = old?.governor ?? createScalarGovernorState();
      // Every new lens starts visibly dark. Prior local history survives a changed patch.
      governor.initialized = true;
      if (old && old.route !== 'desk') this.darken(old.governor, state);
      next.set(binding.unitId, {
        ...binding, governor,
        route: old?.route ?? (mixedDelivery ? 'joiningDesk' : 'desk'),
        changedAt: now,
        generation: input.authority?.generation ?? null,
        seenSequence: binding.address ? input.latestSequence(binding.address.universe) : 0,
      });
    }
    for (const [unitId, old] of previous) {
      if (!next.has(unitId)) this.darken(old.governor, state);
    }
    if (previous.size && !next.size) this.emptyHandoff = hadHandoff;
    else if (next.size) this.emptyHandoff = false;
    this.units = next;
  }

  prepare(input: ArtNetPreviewLevels, state: PreviewFlashState, nextClockMs = state.clockMs, deskLimited = true): boolean {
    const newDocument = input.documentEpoch !== this.documentEpoch;
    this.documentEpoch = input.documentEpoch;
    this.hasDeskLens = this.units.size === 0 && !this.emptyHandoff;
    for (const unit of this.units.values()) {
      if (newDocument && unit.route !== 'desk') this.darken(unit.governor, state);
      if (input.source === 'external' && unit.address) unit.route = 'external';
      else if (unit.route === 'external') unit.route = 'returning';
      else if (unit.route === 'joiningDesk' && input.source === 'external' && !deskLimited) unit.route = 'desk';
      if (unit.route === 'desk') this.hasDeskLens = true;
    }
    if (this.pendingFall) {
      recordFlashFall(state.budgetClock, nextClockMs);
      this.pendingFall = false;
    }
    return this.hasDeskLens;
  }

  deliver(input: ArtNetPreviewLevels, state: PreviewFlashState, now: number,
    desk: number, rawDesk: number, master: number, blackout: boolean, deskLimited: boolean): number {
    this.limited = false;
    const clock = state.budgetClock;
    const t = state.clockMs;
    if (!this.units.size) {
      if (!this.emptyHandoff) {
        observeScalarDelivery(this.roomGovernor, null, t, desk);
        return desk;
      }
      // Preserve the last visible room level across a rebuild that removes all lamps.
      const governed = stepFinalPreviewScalar(this.roomGovernor, clock, t, rawDesk, blackout);
      this.limited = governed.limited;
      if (atDeskParity(this.roomGovernor, state, blackout ? 0 : rawDesk)) {
        copyScalarGovernorState(state.blinderGov, this.roomGovernor);
        this.emptyHandoff = false;
      }
      return governed.value;
    }
    let room = 0;
    // Observe actual Desk siblings before admitting individual lens rises on this same frame.
    for (const unit of this.units.values()) {
      if (unit.route !== 'desk') continue;
      observeScalarDelivery(unit.governor, deskLimited ? null : clock, t, desk);
      room = Math.max(room, desk);
    }
    let returning: ScalarGovernorState | null = null;
    let canReturn = true;
    const deskTarget = this.hasDeskLens ? desk : rawDesk;
    for (const unit of this.units.values()) {
      if (unit.route === 'desk') continue;
      let target = deskTarget;
      let dark = blackout;
      if (unit.route === 'external') {
        const address = unit.address!;
        const sample = input.read(address.universe, now);
        const newer = sample && sample.acceptedAtLower > unit.changedAt &&
          (unit.generation !== input.authority?.generation || sample.sequence > unit.seenSequence);
        dark ||= !newer;
        target = newer ? sample.data[address.start - 1] / 255 * master : 0;
      }
      const governed = stepFinalPreviewScalar(unit.governor, clock, t, target, dark);
      room = Math.max(room, governed.value);
      this.limited ||= governed.limited;
      if (unit.route === 'returning' || unit.route === 'joiningDesk') {
        if (!returning || unit.governor.lastRiseMs > returning.lastRiseMs) returning = unit.governor;
        if (!atDeskParity(unit.governor, state, dark ? 0 : target)) canReturn = false;
      }
    }
    if (returning && canReturn) {
      if (!this.hasDeskLens) copyScalarGovernorState(state.blinderGov, returning);
      for (const unit of this.units.values()) if (unit.route === 'returning' || unit.route === 'joiningDesk') unit.route = 'desk';
    }
    observeScalarDelivery(this.roomGovernor, null, t, room);
    return room;
  }

  level(unitId: string): number { return this.units.get(unitId)?.governor.delivered ?? 0; }

  hasExternalOrHandoff(): boolean {
    if (this.emptyHandoff) return true;
    for (const unit of this.units.values()) if (unit.route !== 'desk') return true;
    return false;
  }

  blackout(state: PreviewFlashState): void {
    for (const unit of this.units.values()) this.darken(unit.governor, state);
    this.darken(this.roomGovernor, state);
  }

  private darken(governor: ScalarGovernorState, state: PreviewFlashState): void {
    // Rebuild and operator events can occur after a rise at the previous tick's timestamp.
    // Account for this real fall at the next control tick, independently of same-frame dedup.
    this.pendingFall ||= governor.delivered >= 0.02;
    stepGovernedScalar(governor, null, state.clockMs, 0, true);
  }
}

function atDeskParity(governor: ScalarGovernorState, state: PreviewFlashState, target: number): boolean {
  return Math.abs(governor.delivered - target) <= 1e-6 &&
    canReleaseScalarHandoff(governor, state.budgetClock, state.clockMs);
}
