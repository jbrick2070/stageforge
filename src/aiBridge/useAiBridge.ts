import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudioMetrics, CameraPreset, RigConfig, ShowCue, ShowState } from '../types/show';
import type { NativeStage, ShowInterchange, ShowTimeline } from '../data/showFile';
import type { PreflightReport } from '../data/preflight';
import { allows, type ClockMode } from '../showControl/clockOwner';
import {
  AiProposalStore,
  appendToolLog,
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
  computeDeskRevision,
  cueEnablesAudienceScan,
  formatToolLogText,
  summarizeToolArgs,
  timelineEnablesAudienceScan,
  type AiDeskSnapshot,
  type AiProposalCandidate,
  type AiProposalRecord,
  type AiToolLogEntry,
} from './aiBridgeProtocol';

export const DEFAULT_AI_BRIDGE_PORT = 47821;

export interface AiRevertSnapshot {
  capturedAt: number;
  rig: RigConfig;
  stage?: NativeStage;
  interchange?: ShowInterchange;
  cues: ShowCue[];
  look: ShowState;
  activeCueId: string | null;
  timeline?: ShowTimeline;
  camera: CameraPreset;
  volume: number;
}

export interface AiBridgeCallbacks {
  getDeskSnapshot: () => AiDeskSnapshot;
  getSafetyReport: () => PreflightReport | null;
  getAudioLevels: () => AudioMetrics;
  captureFrame: (maxWidth?: number) => Promise<{ base64: string; width: number; height: number; byteLength: number }>;
  applyCandidate: (candidate: AiProposalCandidate) => void;
  restoreSnapshot: (snapshot: AiRevertSnapshot) => void;
  // Run-tool callbacks (all checked through `allows(clockMode, 'ai', action)` first)
  onGo: () => { ok: boolean; activeCueId: string | null; message?: string };
  onBack: () => { ok: boolean; activeCueId: string | null; message?: string };
  onStop: () => void;
  onResume: () => void;
  onTriggerCue: (target: { cueId?: string; index?: number }) => { ok: boolean; activeCueId: string | null; message?: string };
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

  const captureRevertSnapshotIfNeeded = useCallback(() => {
    if (revertSnapshotRef.current) return;
    const desk = cbRef.current.getDeskSnapshot();
    const snap: AiRevertSnapshot = {
      capturedAt: Date.now(),
      rig: structuredClone(desk.rig),
      stage: desk.stage ? structuredClone(desk.stage) : undefined,
      interchange: desk.interchange ? structuredClone(desk.interchange) : undefined,
      cues: structuredClone(desk.cues),
      look: structuredClone(desk.look),
      activeCueId: desk.activeCueId,
      timeline: desk.timeline ? structuredClone(desk.timeline) : undefined,
      camera: desk.camera,
      volume: desk.volume,
    };
    revertSnapshotRef.current = snap;
    setRevertCapturedAt(snap.capturedAt);
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
    const currentRev = computeDeskRevision(cbRef.current.getDeskSnapshot());
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
    const currentRev = computeDeskRevision(currentDesk);
    if (rec.baseRevision !== currentRev) {
      cbRef.current.onToast('Desk changed since this AI proposal was created. Reject it or ask the AI to re-propose.');
      return false;
    }
    try {
      assertNoAudienceScan(rec.candidate);
    } catch (err) {
      store.transition(id, 'rejected');
      syncPendingState();
      cbRef.current.onToast(err instanceof Error ? err.message : AUDIENCE_SCAN_ERROR);
      return false;
    }

    const candidateToApply = structuredClone(rec.candidate);
    captureRevertSnapshotIfNeeded();
    store.transition(id, 'accepted');
    syncPendingState();
    cbRef.current.applyCandidate(candidateToApply);
    cbRef.current.onToast(`Applied AI proposal: ${rec.summary}`);
    return true;
  }, [captureRevertSnapshotIfNeeded, syncPendingState]);

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
        const baseRevision = computeDeskRevision(desk);
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
          return {
            proposalId: rec.id,
            status: applied ? 'accepted' : 'rejected',
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

      // --- Run tools (enforced via single clock owner + audienceScan guard) ---
      case 'go': {
        const blocked = requireClockAction('go', 'go');
        if (blocked) return blocked;
        const curIdx = desk.cues.findIndex((c) => c.id === desk.activeCueId);
        const nextCue = desk.cues[curIdx >= 0 ? (curIdx + 1) % Math.max(1, desk.cues.length) : 0];
        if (cueEnablesAudienceScan(nextCue)) {
          return { isError: true, message: AUDIENCE_SCAN_ERROR };
        }
        return cbRef.current.onGo();
      }

      case 'back': {
        const blocked = requireClockAction('back', 'back');
        if (blocked) return blocked;
        const curIdx = desk.cues.findIndex((c) => c.id === desk.activeCueId);
        const prevCue = desk.cues[curIdx > 0 ? curIdx - 1 : Math.max(0, desk.cues.length - 1)];
        if (cueEnablesAudienceScan(prevCue)) {
          return { isError: true, message: AUDIENCE_SCAN_ERROR };
        }
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
        cbRef.current.onResume();
        return { ok: true };
      }

      case 'trigger_cue': {
        const blocked = requireClockAction('go', 'trigger_cue');
        if (blocked) return blocked;
        const cueId = typeof args.cueId === 'string' ? args.cueId : undefined;
        const index = typeof args.index === 'number' ? args.index : undefined;
        const targetCue = cueId
          ? desk.cues.find((c) => c.id === cueId)
          : index !== undefined
            ? desk.cues[index - 1]
            : undefined;
        if (!targetCue) {
          return { isError: true, message: 'Requested cue was not found.' };
        }
        if (cueEnablesAudienceScan(targetCue)) {
          return { isError: true, message: AUDIENCE_SCAN_ERROR };
        }
        return cbRef.current.onTriggerCue({ cueId: targetCue.id });
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
        void bridge.aiBridgeControl({ type: 'quiesced', generation: next.generation }).catch(() => {});
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
