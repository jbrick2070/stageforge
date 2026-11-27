'use strict';

// Shared main-process mutual-exclusion coordinator between physical lighting output
// (desktop sACN/Art-Net DMX, armed-not-live UI state, Web Serial Enttec Pro) and the AI bridge.
//
// Phase 1 invariant:
// - Live output cannot be armed or enabled while the AI bridge holds authority (starting/on/stopping).
// - The AI bridge cannot be enabled while live output holds authority (armed/serial/starting/live).
// - All authority checks and transitions are synchronous before any `await` so racing IPC calls
//   across one or multiple windows cannot both succeed.

const VALID_CLAIM_KINDS = new Set(['armed', 'serial']);
const isDmxAuthority = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === 2 && typeof value.revision === 'string' && value.revision.length > 0 && value.revision.length <= 128 &&
  Number.isSafeInteger(value.generation) && value.generation >= 0);
const sameAuthority = (a, b) => Boolean(a && b && a.revision === b.revision && a.generation === b.generation);

function createOutputInterlock(options = {}) {
  const isDmxActive = typeof options.isDmxActive === 'function' ? options.isDmxActive : () => false;
  const requireDmxAuthority = Boolean(options.requireDmxAuthority);

  /** @type {'off' | 'starting' | 'on' | 'stopping'} */
  let bridgePhase = 'off';
  /** @type {number | null} */
  let bridgeOwnerId = null;
  let dmxAttempt = null;
  /** @type {Map<number, Set<'armed' | 'serial'>>} */
  const claims = new Map();
  const eligibility = new Map();
  const armAuthority = new Map();
  const serialAuthority = new Map();

  function isCurrentDmxAuthority(wcId, authority) {
    const current = eligibility.get(wcId);
    return Boolean(current?.eligible && sameAuthority(current.authority, authority));
  }

  function updateDmxEligibility(wcId, authority, eligible) {
    if (!isDmxAuthority(authority) || typeof eligible !== 'boolean') return { ok: false, changed: false };
    const prev = eligibility.get(wcId);
    if (prev && authority.generation <= prev.authority.generation) {
      return { ok: sameAuthority(prev.authority, authority) && prev.eligible === eligible, changed: false };
    }
    revokeDmxClaims(wcId);
    eligibility.set(wcId, { authority, eligible });
    return { ok: true, changed: true };
  }

  function revokeDmxClaims(wcId) {
    if (dmxAttempt?.wcId === wcId) dmxAttempt = null;
    const arm = armAuthority.get(wcId);
    if (arm) releaseOutput(wcId, 'armed', arm);
    // USB has no main-process writer to stop. Keep its exclusion claim until the
    // owning renderer has sent blackout and closed, but make the chooser ineligible now.
  }

  function invalidateDmxEligibility(wcId, expected) {
    const current = eligibility.get(wcId);
    if (!current || (expected && !sameAuthority(current.authority, expected))) return false;
    revokeDmxClaims(wcId);
    // Preserve the high-water generation so an old affirmative message cannot undo Stop.
    eligibility.set(wcId, { ...current, eligible: false });
    return true;
  }

  function invalidateAllDmxEligibility(notify) {
    for (const [wcId, current] of eligibility) {
      if (!current.eligible) continue;
      invalidateDmxEligibility(wcId, current.authority);
      notify(wcId, current.authority);
    }
  }

  function currentSerialAuthority(wcId) {
    const authority = serialAuthority.get(wcId);
    return isCurrentDmxAuthority(wcId, authority) ? authority : null;
  }

  function listClaimKinds() {
    const out = new Set();
    for (const set of claims.values()) {
      for (const kind of set) out.add(kind);
    }
    return out;
  }

  function hasWindowClaim(wcId, kind) {
    const set = claims.get(wcId);
    return Boolean(set && set.has(kind));
  }

  function hasOutputAuthority() {
    if (dmxAttempt || isDmxActive()) return true;
    return claims.size > 0;
  }

  function isBridgeHoldingAuthority() {
    return bridgePhase !== 'off';
  }

  function canEnableBridge() {
    if (bridgePhase === 'starting' || bridgePhase === 'stopping') {
      return 'AI bridge is currently changing state; wait a moment and try again.';
    }
    if (dmxAttempt || isDmxActive()) {
      return 'Stop live DMX output before enabling the AI bridge.';
    }
    const activeClaims = listClaimKinds();
    if (activeClaims.has('serial')) {
      return 'Disconnect Enttec USB Serial DMX output before enabling the AI bridge.';
    }
    if (activeClaims.has('armed')) {
      return 'Disarm live DMX output before enabling the AI bridge.';
    }
    return null;
  }

  function canClaimOutput() {
    if (bridgePhase !== 'off') {
      return 'Disable the AI bridge before arming or enabling live DMX output.';
    }
    return null;
  }

  function tryBeginBridgeStart(wcId) {
    if (typeof wcId !== 'number') {
      return { ok: false, reason: 'Invalid window identity for AI bridge.' };
    }
    if (bridgePhase === 'on' && bridgeOwnerId === wcId) {
      return { ok: false, reason: 'AI bridge is already enabled.' };
    }
    if (bridgePhase !== 'off') {
      return { ok: false, reason: 'AI bridge is already active in another window or changing state.' };
    }
    const reason = canEnableBridge();
    if (reason) return { ok: false, reason };
    bridgePhase = 'starting';
    bridgeOwnerId = wcId;
    return { ok: true, reason: null };
  }

  function markBridgeOn(wcId) {
    if (bridgePhase === 'starting' && bridgeOwnerId === wcId) {
      bridgePhase = 'on';
      return true;
    }
    return false;
  }

  function beginBridgeStop() {
    if (bridgePhase !== 'off') {
      bridgePhase = 'stopping';
    }
  }

  function finishBridgeStop() {
    bridgePhase = 'off';
    bridgeOwnerId = null;
  }

  function claimOutput(wcId, kind, authority) {
    if (typeof wcId !== 'number' || !VALID_CLAIM_KINDS.has(kind)) {
      return { ok: false, reason: 'Invalid output claim.' };
    }
    const reason = canClaimOutput();
    if (reason) return { ok: false, reason };
    if (requireDmxAuthority && (!isDmxAuthority(authority) || !isCurrentDmxAuthority(wcId, authority))) {
      return { ok: false, reason: 'Current pre-flight eligibility is required for physical output.' };
    }
    if (requireDmxAuthority && kind === 'serial' && !sameAuthority(armAuthority.get(wcId), authority)) {
      return { ok: false, reason: 'Arm USB DMX at the current pre-flight revision before going live.' };
    }
    if (requireDmxAuthority && kind === 'serial' && serialAuthority.size > 0) {
      return { ok: false, reason: 'USB DMX is already active or still closing.' };
    }
    if (requireDmxAuthority && kind === 'serial') releaseOutput(wcId, 'armed', authority);
    let set = claims.get(wcId);
    if (!set) {
      set = new Set();
      claims.set(wcId, set);
    }
    set.add(kind);
    if (requireDmxAuthority) (kind === 'armed' ? armAuthority : serialAuthority).set(wcId, authority);
    return { ok: true, reason: null };
  }

  function releaseOutput(wcId, kind, authority) {
    if (typeof wcId !== 'number' || !VALID_CLAIM_KINDS.has(kind)) return false;
    const set = claims.get(wcId);
    if (!set) return false;
    const authorities = kind === 'armed' ? armAuthority : serialAuthority;
    if (requireDmxAuthority && !sameAuthority(authorities.get(wcId), authority)) return false;
    authorities.delete(wcId);
    const removed = set.delete(kind);
    if (set.size === 0) claims.delete(wcId);
    return removed;
  }

  function clearWindowClaims(wcId) {
    if (typeof wcId !== 'number') return false;
    if (requireDmxAuthority && dmxAttempt?.wcId === wcId) dmxAttempt = null;
    eligibility.delete(wcId);
    armAuthority.delete(wcId);
    serialAuthority.delete(wcId);
    return claims.delete(wcId);
  }

  function tryBeginDmxEnable(wcId, opts = {}) {
    const reason = canClaimOutput();
    if (reason) return { ok: false, reason };
    const authority = opts.authority;
    if (requireDmxAuthority && (!isDmxAuthority(authority) || !isCurrentDmxAuthority(wcId, authority) ||
        !sameAuthority(armAuthority.get(wcId), authority))) {
      return { ok: false, reason: 'Arm at the current pre-flight revision before enabling DMX output.' };
    }
    if (!requireDmxAuthority && opts.requireArmedClaim && !hasWindowClaim(wcId, 'armed')) {
      return { ok: false, reason: 'Arm live DMX output before going live.' };
    }
    if (dmxAttempt) {
      return { ok: false, reason: 'Live DMX output is already starting.' };
    }
    const lease = { wcId, authority };
    dmxAttempt = lease;
    if (requireDmxAuthority) releaseOutput(wcId, 'armed', authority);
    return { ok: true, reason: null, lease };
  }

  function dmxEnableIsCurrent(lease) {
    return dmxAttempt === lease && (!requireDmxAuthority || isCurrentDmxAuthority(lease.wcId, lease.authority));
  }

  function finishDmxEnableAttempt(lease) {
    if (!requireDmxAuthority || dmxAttempt === lease) dmxAttempt = null;
  }

  function getState() {
    return {
      bridgePhase,
      bridgeOwnerId,
      dmxStarting: Boolean(dmxAttempt),
      dmxActive: Boolean(isDmxActive()),
      claims: [...listClaimKinds()].sort(),
    };
  }

  return {
    VALID_CLAIM_KINDS,
    canEnableBridge,
    canClaimOutput,
    isBridgeHoldingAuthority,
    hasOutputAuthority,
    hasWindowClaim,
    requireDmxAuthority,
    updateDmxEligibility,
    invalidateDmxEligibility,
    invalidateAllDmxEligibility,
    isCurrentDmxAuthority,
    currentSerialAuthority,
    tryBeginBridgeStart,
    markBridgeOn,
    beginBridgeStop,
    finishBridgeStop,
    claimOutput,
    releaseOutput,
    clearWindowClaims,
    tryBeginDmxEnable,
    dmxEnableIsCurrent,
    finishDmxEnableAttempt,
    getState,
  };
}

module.exports = {
  VALID_CLAIM_KINDS,
  isDmxAuthority,
  sameAuthority,
  createOutputInterlock,
};
