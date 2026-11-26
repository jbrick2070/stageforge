import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudioMetrics, CameraPreset, MusicRef, RigConfig, ScreenRef, ShowCue, ShowState } from '../types/show';
import type { NativeStage, ShowInterchange, ShowTimeline } from '../data/showFile';
import type { PreflightReport } from '../data/preflight';
import { allows, type ClockMode } from '../showControl/clockOwner';
import {
  AiProposalStore,
  appendToolLog,
  applyAudioMappingPatchToDesk,
  assertNoAudienceScan,
  AUDIENCE_SCAN_ERROR,
  buildAiCatalogSummary,
  buildAiSafetyReport,
  buildAiStateSummary,
  compileAudioMappingProposal,
  compileCueProposal,
  compileLookProposal,
  compileShowProposal,
  compileTakeProposal,
  compileWallCueProposal,
  computeAuthoredRevision,
  createAiRevertSnapshot,
  formatToolLogText,
  summarizeToolArgs,
  timelineEnablesAudienceScan,
  type AiDeskSnapshot,
  type AiProposalCandidate,
  type AiProposalRecord,
  type AiRevertSnapshot,
  type AiToolLogEntry,
} from './aiBridgeProtocol';

export const DEFAULT_AI_BRIDGE_PORT = 47821;
export type { AiRevertSnapshot };

export interface AiBridgeCallbacks {
  getDeskSnapshot: () => AiDeskSnapshot;
  getSafetyReport: () => PreflightReport | null;
  getAudioLevels: () => AudioMetrics;
  captureFrame: (maxWidth?: number) => Promise<{ base64: string; width: number; height: number; byteLength: number }>;
  applyCandidate: (candidate: AiProposalCandidate) => boolean;
  restoreSnapshot: (snapshot: AiRevertSnapshot) => void;
  // Run-tool callbacks (all checked through `allows(clockMode, 'ai', action)` first)
  onGo: () => { ok?: boolean; isError?: boolean; activeCueId?: string | null; message?: string };
  onBack: () => { ok?: boolean; isError?: boolean; activeCueId?: string | null; message?: string };
  onStop: () => void;
  onResume: () => { ok?: boolean; isError?: boolean; message?: string };
  onTriggerCue: (target: { cueId?: string; index?: number }) => { ok?: boolean; isError?: boolean; activeCueId?: string | null; message?: string };
  onPlayTake: () => { ok: boolean; message?: string };
  onPauseTake: () => { ok: boolean; message?: string };
  onSeekTake: (positionMs: number) => { ok: boolean; message?: string };
  onSetBlackout: (active?: boolean) => boolean;
  onSetMaster: (value: number) => number;
  onSetBpm: (bpm: number) => { ok: boolean; bpm: number; message?: string };
  onToast: (message: string) => void;
}

export interface AiBridgeApi {
  hasDesktopBridge: boolean;
  status: AiBridgeStatusBridge;
  enabled: boolean;
  busy: boolean;
  port: number;
  setPort: (port: number) => void;
  error: string | null;
  blockedByOutput: boolean;
  autoAccept: boolean;
  setAutoAccept: (enabled: boolean) => void;
  pendingProposals: AiProposalRecord[];
  hasRevertSnapshot: boolean;
  revertCapturedAt: number | null;
  toolLog: AiToolLogEntry[];
  enable: (overridePort?: number) => Promise<boolean>;
  disable: () => Promise<void>;
  acceptProposal: (id: string) => boolean;
  rejectProposal: (id: string) => void;
  revertAiChanges: () => void;
  clearToolLog: () => void;
  copyToolLogText: () => string;
  notifyDocumentChanged: () => void;
  isProposalStale: (proposal: AiProposalRecord) => boolean;
}

const INITIAL_STATUS: AiBridgeStatusBridge = {
  enabled: false,
  state: 'off',
  generation: 0,
  port: null,
  url: null,
  token: null,
  activeSessions: 0,
  activeToolCalls: 0,
  lastError: null,
};

export function useAiBridge(
  callbacks: AiBridgeCallbacks,
  opts: {
    capabilityAllowed: boolean;
    outputBlocking: boolean;
  },
): AiBridgeApi {
  const hasDesktopBridge = Boolean(typeof window !== 'undefined' && window.stageforgeDesktop?.aiBridgeControl);
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  const capRef = useRef(opts.capabilityAllowed);
  capRef.current = opts.capabilityAllowed;
  const outputBlockingRef = useRef(opts.outputBlocking);
  outputBlockingRef.current = opts.outputBlocking;

  const [status, setStatus] = useState<AiBridgeStatusBridge>(INITIAL_STATUS);
  const statusRef = useRef<AiBridgeStatusBridge>(INITIAL_STATUS);
  statusRef.current = status;

  const [port, setPortState] = useState<number>(DEFAULT_AI_BRIDGE_PORT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoAccept, setAutoAcceptState] = useState(false);
  const autoAcceptRef = useRef(false);
  autoAcceptRef.current = autoAccept;

  const proposalStoreRef = useRef(new AiProposalStore());
  const [pendingProposals, setPendingProposals] = useState<AiProposalRecord[]>([]);

  const revertSnapshotRef = useRef<AiRevertSnapshot | null>(null);
  const [revertCapturedAt, setRevertCapturedAt] = useState<number | null>(null);

  const [toolLog, setToolLog] = useState<AiToolLogEntry[]>([]);
  const nextLogIdRef = useRef(1);
  const documentEpochRef = useRef(1);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(true);

  const syncPendingState = useCallback(() => {
    setPendingProposals([...proposalStoreRef.current.listPending()]);
  }, []);

  const recordLog = useCallback((tool: string, args: Record<string, unknown>, ok: boolean, resultSummary: string) => {
    const id = nextLogIdRef.current++;
    setToolLog((prev) =>
      appendToolLog(
        prev,
        {
          at: Date.now(),
          tool,
          argSummary: summarizeToolArgs(args),
          ok,
          resultSummary: resultSummary.length > 220 ? resultSummary.slice(0, 217) + '…' : resultSummary,
        },
        id,
      ),
    );
  }, []);

  const snapshotCurrentDesk = useCallback((): AiRevertSnapshot => {
    return createAiRevertSnapshot(cbRef.current.getDeskSnapshot());
  }, []);

  const clearPendingAndAutoAccept = useCallback(() => {
    proposalStoreRef.current.clearAll();
    syncPendingState();
    autoAcceptRef.current = false;
    setAutoAcceptState(false);
  }, [syncPendingState]);

  const notifyDocumentChanged = useCallback(() => {
    documentEpochRef.current += 1;
    clearPendingAndAutoAccept();
    revertSnapshotRef.current = null;
    setRevertCapturedAt(null);
  }, [clearPendingAndAutoAccept]);

  const isProposalStale = useCallback((proposal: AiProposalRecord): boolean => {
    if (proposal.bridgeGeneration !== statusRef.current.generation) return true;
    if (proposal.documentEpoch !== documentEpochRef.current) return true;
    const currentRev = computeAuthoredRevision(cbRef.current.getDeskSnapshot());
    return proposal.baseRevision !== currentRev;
  }, []);

  const acceptProposal = useCallback((id: string): boolean => {
    if (!capRef.current) return false;
    if (outputBlockingRef.current) {
      setError('Cannot accept AI proposals while live DMX output is armed or active.');
      return false;
    }
    const store = proposalStoreRef.current;
    const rec = store.get(id);
    if (!rec || rec.status !== 'pending') return false;
    if (rec.bridgeGeneration !== statusRef.current.generation || !statusRef.current.enabled) {
      store.transition(id, 'rejected');
      syncPendingState();
      cbRef.current.onToast('AI proposal expired because the bridge was disabled.');
      return false;
    }
    if (rec.documentEpoch !== documentEpochRef.current) {
      store.transition(id, 'rejected');
      syncPendingState();
      cbRef.current.onToast('AI proposal rejected because another show was opened.');
      return false;
    }
    const currentDesk = cbRef.current.getDeskSnapshot();
    const currentRev = computeAuthoredRevision(currentDesk);
    if (rec.baseRevision !== currentRev) {
      cbRef.current.onToast('Show document changed since this AI proposal was created. Reject it or ask the AI to re-propose.');
      return false;
    }

    // For partial look and audio-mapping patches, re-apply cleanly against the current live look
    // so runtime safety/operator changes (audienceScan off, blackout, master dimmer, cue Go, take playback)
    // are never clobbered by a stale snapshot (M6 + Pass 2 M-A).
    let candidateToApply: AiProposalCandidate;
    try {
      if (rec.candidate.kind === 'propose_look' && rec.candidate.lookPatch) {
        candidateToApply = compileLookProposal(rec.candidate.lookPatch, rec.summary, currentDesk).candidate;
      } else if (rec.candidate.kind === 'propose_audio_mapping' && rec.candidate.audioMappingPatch) {
        candidateToApply = applyAudioMappingPatchToDesk(rec.candidate.audioMappingPatch, currentDesk);
      } else {
        candidateToApply = structuredClone(rec.candidate);
      }
      if (candidateToApply.kind === 'propose_show' || candidateToApply.kind === 'propose_take') {
        assertNoAudienceScan(candidateToApply);
      } else if (candidateToApply.look) {
        // Belt-and-suspenders: an AI proposal may never newly turn audienceScan on.
        if (!currentDesk.look.laser.audienceScan && candidateToApply.look.laser.audienceScan) {
          throw new Error(AUDIENCE_SCAN_ERROR);
        }
      } else if (candidateToApply.kind === 'propose_cue' && candidateToApply.cues) {
        const existingScanIds = new Set(
          currentDesk.cues.filter((c) => c.state.laser?.audienceScan === true).map((c) => c.id),
        );
        for (const c of candidateToApply.cues) {
          if (c.state.laser?.audienceScan === true && !existingScanIds.has(c.id)) {
            throw new Error(AUDIENCE_SCAN_ERROR);
          }
        }
      }
    } catch (err) {
      store.transition(id, 'rejected');
      syncPendingState();
      cbRef.current.onToast(err instanceof Error ? err.message : AUDIENCE_SCAN_ERROR);
      return false;
    }

    // Transactional apply (M1): capture pre-apply rollback snapshot BEFORE mutating;
    // roll back on failure and mark accepted only after apply succeeds.
    const preApplySnapshot = snapshotCurrentDesk();
    const hadRevert = revertSnapshotRef.current !== null;
    try {
      const applied = cbRef.current.applyCandidate(candidateToApply);
      if (!applied) {
        cbRef.current.onToast('Could not apply AI proposal in current mode.');
        return false;
      }
    } catch (err) {
      try {
        cbRef.current.restoreSnapshot(structuredClone(preApplySnapshot));
      } catch {
        // Best-effort rollback.
      }
      cbRef.current.onToast(err instanceof Error ? `Failed to apply AI proposal: ${err.message}` : 'Failed to apply AI proposal.');
      return false;
    }

    if (!hadRevert) {
      revertSnapshotRef.current = preApplySnapshot;
      setRevertCapturedAt(preApplySnapshot.capturedAt);
    }
    store.transition(id, 'accepted');
    syncPendingState();
    cbRef.current.onToast(`Applied AI proposal: ${rec.summary}`);
    return true;
  }, [snapshotCurrentDesk, syncPendingState]);

  const rejectProposal = useCallback((id: string) => {
    const rec = proposalStoreRef.current.transition(id, 'rejected');
    if (rec) {
      syncPendingState();
      cbRef.current.onToast(`Rejected AI proposal: ${rec.summary}`);
    }
  }, [syncPendingState]);

  const revertAiChanges = useCallback(() => {
    if (!capRef.current) return;
    const snap = revertSnapshotRef.current;
    if (!snap) return;
    clearPendingAndAutoAccept();
    const toRestore = structuredClone(snap);
    revertSnapshotRef.current = null;
    setRevertCapturedAt(null);
    cbRef.current.restoreSnapshot(toRestore);
    cbRef.current.onToast('Reverted desk to snapshot taken before first AI change.');
  }, [clearPendingAndAutoAccept]);

  const handleToolCall = useCallback(async (req: AiBridgeRequestBridge): Promise<unknown> => {
    const { tool, arguments: rawArgs, bridgeGeneration, deadlineMs } = req;
    const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};

    const verifyActive = () => {
      if (!capRef.current) throw new Error('AI bridge is unavailable in pitch viewer mode.');
      if (!statusRef.current.enabled || statusRef.current.generation !== bridgeGeneration) {
        throw new Error('AI bridge was disabled or restarted.');
      }
      if (outputBlockingRef.current) {
        throw new Error('Live DMX output is active; AI bridge requests are blocked.');
      }
      if (Date.now() > deadlineMs) {
        throw new Error('Request deadline exceeded.');
      }
    };

    verifyActive();
    const desk = cbRef.current.getDeskSnapshot();
    const clockMode: ClockMode = desk.clockMode;

    const requireClockAction = (action: Parameters<typeof allows>[2], label: string) => {
      if (!allows(clockMode, 'ai', action)) {
        return {
          ok: false,
          ignored: true,
          clockMode,
          reason: `Blocked by clock mode "${clockMode}" (${label} is not allowed).`,
        };
      }
      return null;
    };

    switch (tool) {
      case 'get_state':
        return buildAiStateSummary(desk);

      case 'get_cues':
        return {
          activeCueId: desk.activeCueId,
          cues: desk.cues.map((c, idx) => ({
            index: idx + 1,
            id: c.id,
            name: c.name,
            tag: c.tag,
            accent: c.accent,
            fadeSeconds: c.fadeSeconds ?? null,
            followSeconds: c.followSeconds ?? null,
            state: c.state,
          })),
        };

      case 'list_catalog':
        return buildAiCatalogSummary(typeof args.category === 'string' ? args.category : 'all');

      case 'get_safety_report':
        return buildAiSafetyReport(cbRef.current.getSafetyReport());

      case 'get_audio_levels': {
        const m = cbRef.current.getAudioLevels();
        return {
          playing: m.playing,
          source: m.source,
          trackName: m.trackName,
          bass: Math.round(m.bass * 1000) / 1000,
          mid: Math.round(m.mid * 1000) / 1000,
          high: Math.round(m.high * 1000) / 1000,
          energy: Math.round(m.energy * 1000) / 1000,
          beat: m.beat,
          beatPulse: Math.round(m.beatPulse * 1000) / 1000,
          drop: m.drop,
        };
      }

      case 'capture_frame': {
        const maxWidth = typeof args.maxWidth === 'number' ? args.maxWidth : 1280;
        const img = await cbRef.current.captureFrame(maxWidth);
        verifyActive();
        return img;
      }

      // --- Compose tools (always create a validated proposal first) ---
      case 'propose_show':
      case 'propose_look':
      case 'propose_cue':
      case 'propose_take':
      case 'propose_wall_cue':
      case 'propose_audio_mapping': {
        const summaryArg = typeof args.summary === 'string' ? args.summary : undefined;
        let compiled: { summary: string; diffLines: string[]; candidate: AiProposalCandidate };
        if (tool === 'propose_show') {
          compiled = compileShowProposal(args.show, summaryArg, desk);
        } else if (tool === 'propose_look') {
          compiled = compileLookProposal(args.patch, summaryArg, desk);
        } else if (tool === 'propose_cue') {
          compiled = compileCueProposal(
            args as Parameters<typeof compileCueProposal>[0],
            desk,
          );
        } else if (tool === 'propose_take') {
          compiled = compileTakeProposal(args.timeline, summaryArg, desk);
        } else if (tool === 'propose_wall_cue') {
          compiled = compileWallCueProposal(
            args as Parameters<typeof compileWallCueProposal>[0],
            desk,
          );
        } else {
          compiled = compileAudioMappingProposal(
            args as Parameters<typeof compileAudioMappingProposal>[0],
            desk,
          );
        }

        verifyActive();
        const baseRevision = computeAuthoredRevision(desk);
        const proposalId = crypto.randomUUID();
        const rec = proposalStoreRef.current.add({
          id: proposalId,
          tool,
          bridgeGeneration,
          documentEpoch: documentEpochRef.current,
          baseRevision,
          summary: compiled.summary,
          diffLines: compiled.diffLines,
          createdAt: Date.now(),
          candidate: compiled.candidate,
        });
        syncPendingState();

        // Human-only session auto-accept (still runs full re-validation & revert snapshot inside acceptProposal).
        if (autoAcceptRef.current) {
          const applied = acceptProposal(rec.id);
          const actualStatus = proposalStoreRef.current.get(rec.id)?.status ?? (applied ? 'accepted' : 'pending');
          return {
            proposalId: rec.id,
            status: actualStatus,
            autoAccepted: applied,
            summary: rec.summary,
            diff: rec.diffLines,
          };
        }

        return {
          proposalId: rec.id,
          status: 'pending',
          summary: rec.summary,
          diff: rec.diffLines,
          note: 'Awaiting human review in StageForge.',
        };
      }

      // --- Review tools ---
      case 'get_proposal': {
        const proposalId = typeof args.proposalId === 'string' ? args.proposalId : undefined;
        if (proposalId) {
          const rec = proposalStoreRef.current.get(proposalId);
          if (!rec) return { isError: true, message: `Proposal "${proposalId}" was not found.` };
          return {
            proposalId: rec.id,
            tool: rec.tool,
            status: rec.status,
            stale: rec.status === 'pending' ? isProposalStale(rec) : false,
            summary: rec.summary,
            diff: rec.diffLines,
            createdAt: rec.createdAt,
          };
        }
        return {
          pending: proposalStoreRef.current.listPending().map((rec) => ({
            proposalId: rec.id,
            tool: rec.tool,
            status: rec.status,
            stale: isProposalStale(rec),
            summary: rec.summary,
            diff: rec.diffLines,
            createdAt: rec.createdAt,
          })),
        };
      }

      case 'withdraw_proposal': {
        const proposalId = String(args.proposalId ?? '');
        const rec = proposalStoreRef.current.get(proposalId);
        if (!rec) return { isError: true, message: `Proposal "${proposalId}" was not found.` };
        if (rec.status !== 'pending') {
          return { isError: true, message: `Proposal "${proposalId}" is already ${rec.status}.` };
        }
        proposalStoreRef.current.transition(proposalId, 'withdrawn');
        syncPendingState();
        return { proposalId, status: 'withdrawn' };
      }

      // --- Run tools (enforced via single clock owner + authoritative audienceScan/follow-chain guards inside callbacks) ---
      case 'go': {
        const blocked = requireClockAction('go', 'go');
        if (blocked) return blocked;
        return cbRef.current.onGo();
      }

      case 'back': {
        const blocked = requireClockAction('back', 'back');
        if (blocked) return blocked;
        return cbRef.current.onBack();
      }

      case 'stop': {
        const blocked = requireClockAction('stop', 'stop');
        if (blocked) return blocked;
        cbRef.current.onStop();
        return { ok: true };
      }

      case 'resume': {
        const blocked = requireClockAction('resume', 'resume');
        if (blocked) return blocked;
        return cbRef.current.onResume();
      }

      case 'trigger_cue': {
        const blocked = requireClockAction('go', 'trigger_cue');
        if (blocked) return blocked;
        const cueId = typeof args.cueId === 'string' ? args.cueId : undefined;
        const index = typeof args.index === 'number' ? args.index : undefined;
        return cbRef.current.onTriggerCue({ cueId, index });
      }

      case 'play_take': {
        const blocked = requireClockAction('take_play', 'play_take');
        if (blocked) return blocked;
        if (timelineEnablesAudienceScan(desk.timeline)) {
          return { isError: true, message: AUDIENCE_SCAN_ERROR };
        }
        return cbRef.current.onPlayTake();
      }

      case 'pause_take': {
        const blocked = requireClockAction('take_play', 'pause_take');
        if (blocked) return blocked;
        return cbRef.current.onPauseTake();
      }

      case 'seek_take': {
        const blocked = requireClockAction('take_play', 'seek_take');
        if (blocked) return blocked;
        if (timelineEnablesAudienceScan(desk.timeline)) {
          return { isError: true, message: AUDIENCE_SCAN_ERROR };
        }
        return cbRef.current.onSeekTake(Number(args.positionMs));
      }

      case 'blackout': {
        const blocked = requireClockAction('blackout', 'blackout');
        if (blocked) return blocked;
        const active = typeof args.active === 'boolean' ? args.active : undefined;
        const resultActive = cbRef.current.onSetBlackout(active);
        return { ok: true, blackout: resultActive };
      }

      case 'set_master': {
        const blocked = requireClockAction('master', 'set_master');
        if (blocked) return blocked;
        const val = cbRef.current.onSetMaster(Number(args.value));
        return { ok: true, masterDimmer: val };
      }

      case 'set_bpm': {
        const blocked = requireClockAction('tempo', 'set_bpm');
        if (blocked) return blocked;
        return cbRef.current.onSetBpm(Number(args.bpm));
      }

      default:
        return { isError: true, message: `Disallowed tool "${tool}".` };
    }
  }, [acceptProposal, isProposalStale, syncPendingState]);

  // Subscribe to main-process AI bridge status & tool requests.
  useEffect(() => {
    mountedRef.current = true;
    const bridge = window.stageforgeDesktop;
    if (!bridge?.onAiBridgeStatus || !bridge?.onAiBridgeRequest || !bridge?.aiBridgeControl) {
      return () => { mountedRef.current = false; };
    }

    const unsubStatus = bridge.onAiBridgeStatus((next) => {
      if (!mountedRef.current) return;
      const prevGen = statusRef.current.generation;
      statusRef.current = next;
      setStatus(next);
      if (next.lastError) setError(next.lastError);
      if (!next.enabled || next.generation !== prevGen) {
        clearPendingAndAutoAccept();
      }
      if (next.state === 'stopping') {
        const stopGen = next.generation;
        // Drain any in-flight serialized renderer task before acknowledging quiescence (L5).
        void queueRef.current
          .catch(() => {})
          .finally(() => {
            void bridge.aiBridgeControl({ type: 'quiesced', generation: stopGen }).catch(() => {});
          });
      }
    });

    const unsubReq = bridge.onAiBridgeRequest((req) => {
      // Serialize renderer-side tool mutations so two concurrent HTTP calls cannot interleave desk edits.
      queueRef.current = queueRef.current
        .catch(() => {})
        .then(async () => {
          if (!mountedRef.current) return;
          try {
            const result = await handleToolCall(req);
            const isErrObj = Boolean(result && typeof result === 'object' && (result as { isError?: boolean }).isError);
            const summary = isErrObj
              ? String((result as { message?: string }).message ?? 'error')
              : req.tool === 'capture_frame'
                ? `JPEG ${(result as { width?: number }).width ?? '?'}x${(result as { height?: number }).height ?? '?'} (${(result as { byteLength?: number }).byteLength ?? 0} B)`
                : JSON.stringify(result).slice(0, 180);
            recordLog(req.tool, req.arguments, !isErrObj, summary);
            await bridge.replyAiBridgeRequest({
              requestId: req.requestId,
              bridgeGeneration: req.bridgeGeneration,
              ok: true,
              result,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'AI bridge tool failed.';
            recordLog(req.tool, req.arguments, false, msg);
            await bridge.replyAiBridgeRequest({
              requestId: req.requestId,
              bridgeGeneration: req.bridgeGeneration,
              ok: false,
              error: msg,
            }).catch(() => {});
          }
        });
    });

    void bridge.aiBridgeControl({ type: 'getStatus' }).then((st) => {
      if (mountedRef.current) {
        statusRef.current = st;
        setStatus(st);
      }
    }).catch(() => {});

    return () => {
      mountedRef.current = false;
      unsubStatus();
      unsubReq();
    };
  }, [clearPendingAndAutoAccept, handleToolCall, recordLog]);

  // Shut down AI bridge immediately if capability is revoked (e.g. entering pitch viewer).
  useEffect(() => {
    if (opts.capabilityAllowed) return;
    clearPendingAndAutoAccept();
    if (statusRef.current.enabled && window.stageforgeDesktop?.aiBridgeControl) {
      void window.stageforgeDesktop.aiBridgeControl({ type: 'disable' }).catch(() => {});
    }
  }, [opts.capabilityAllowed, clearPendingAndAutoAccept]);

  const setPort = useCallback((nextPort: number) => {
    const clamped = Number.isInteger(nextPort) && nextPort >= 1024 && nextPort <= 65535
      ? nextPort
      : DEFAULT_AI_BRIDGE_PORT;
    setPortState(clamped);
  }, []);

  const setAutoAccept = useCallback((next: boolean) => {
    // Human UI control only — never persisted, never enabled when bridge is off.
    const effective = Boolean(next && statusRef.current.enabled && capRef.current);
    autoAcceptRef.current = effective;
    setAutoAcceptState(effective);
  }, []);

  const enable = useCallback(async (overridePort?: number): Promise<boolean> => {
    if (!capRef.current) return false;
    if (outputBlockingRef.current) {
      setError('Stop or disarm live DMX output before enabling the AI bridge.');
      return false;
    }
    const bridge = window.stageforgeDesktop;
    if (!bridge?.aiBridgeControl) {
      setError('AI bridge requires the StageForge desktop app.');
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      const targetPort = overridePort !== undefined ? overridePort : port;
      const next = await bridge.aiBridgeControl({ type: 'enable', config: { port: targetPort } });
      if (mountedRef.current) {
        statusRef.current = next;
        setStatus(next);
        autoAcceptRef.current = false;
        setAutoAcceptState(false);
        cbRef.current.onToast(`AI bridge listening on 127.0.0.1:${next.port}`);
      }
      return true;
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Could not enable AI bridge.');
      }
      return false;
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [port]);

  const disable = useCallback(async () => {
    const bridge = window.stageforgeDesktop;
    clearPendingAndAutoAccept();
    if (!bridge?.aiBridgeControl) return;
    setBusy(true);
    setError(null);
    try {
      const next = await bridge.aiBridgeControl({ type: 'disable' });
      if (mountedRef.current) {
        statusRef.current = next;
        setStatus(next);
        cbRef.current.onToast('AI bridge stopped.');
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Could not stop AI bridge.');
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [clearPendingAndAutoAccept]);

  const clearToolLog = useCallback(() => setToolLog([]), []);
  const copyToolLogText = useCallback(() => formatToolLogText(toolLog), [toolLog]);

  return {
    hasDesktopBridge,
    status,
    enabled: status.enabled,
    busy,
    port,
    setPort,
    error,
    blockedByOutput: opts.outputBlocking,
    autoAccept,
    setAutoAccept,
    pendingProposals,
    hasRevertSnapshot: revertCapturedAt !== null,
    revertCapturedAt,
    toolLog,
    enable,
    disable,
    acceptProposal,
    rejectProposal,
    revertAiChanges,
    clearToolLog,
    copyToolLogText,
    notifyDocumentChanged,
    isProposalStale,
  };
}
