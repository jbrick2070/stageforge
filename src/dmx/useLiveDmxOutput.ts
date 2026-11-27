import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StageEngine } from '../engine/StageEngine';
import type { RigConfig } from '../types/show';
import { EnttecProTransport, isWebSerialSupported, type SerialTransportStatus } from './enttecPro';
import { checkSerialTransportSafety } from './physicalDmx';
import { hasExtendedDmx } from '../data/dmxUniverses';
import {
  loadDmxOutputSettings,
  parseTargetList,
  saveDmxOutputSettings,
  type DmxOutputSettings,
  type LiveDmxBannerState,
} from './liveDmx';

const INITIAL_SERIAL_STATUS: SerialTransportStatus = {
  enabled: false,
  universe: 1,
  rateHz: 35,
  measuredHz: 0,
  packetsSent: 0,
  error: null,
  deviceLabel: null,
};

const CONTROL_LOOP_STALL_TIMEOUT_MS = 2500;
let nextAuthorityGeneration = 0;
const sameAuthority = (a: DmxAuthorityBridge | null | undefined, b: DmxAuthorityBridge | null | undefined) =>
  Boolean(a && b && a.revision === b.revision && a.generation === b.generation);

export interface LiveDmxControllerApi {
  hasDesktopBridge: boolean;
  hasWebSerial: boolean;
  settings: DmxOutputSettings;
  updateSettings: (patch: Partial<DmxOutputSettings>) => void;
  interfaces: DmxNetworkInterfaceBridge[];
  refreshInterfaces: () => Promise<void>;
  desktopStatus: DmxStatusBridge | null;
  serialStatus: SerialTransportStatus;
  discoveredNodes: ArtNetDiscoveredNodeBridge[];
  discovering: boolean;
  discoveryWarning: string | null;
  discoverArtNet: () => Promise<void>;
  busy: boolean;
  error: string | null;
  armed: boolean;
  arm: () => Promise<boolean>;
  disarm: () => void;
  isLive: boolean;
  banner: LiveDmxBannerState;
  dismissStoppedNotice: () => void;
  enable: () => Promise<boolean>;
  disable: () => Promise<void>;
  emergencyStopOnFault: (notice: string) => Promise<void>;
}

export function useLiveDmxOutput(
  engineRef: React.RefObject<StageEngine | null>,
  onToast: (message: string) => void,
  enabled = true,
  onBeforeDisable?: () => void,
  canArmCheck?: () => { allowed: boolean; reason?: string; revision?: string },
  rigRef?: React.RefObject<RigConfig>,
): LiveDmxControllerApi {
  const hasDesktopBridge = Boolean(typeof window !== 'undefined' && window.stageforgeDesktop);
  const hasWebSerial = isWebSerialSupported();
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const onBeforeDisableRef = useRef(onBeforeDisable);
  onBeforeDisableRef.current = onBeforeDisable;
  const canArmCheckRef = useRef(canArmCheck);
  canArmCheckRef.current = canArmCheck;

  const [settings, setSettings] = useState<DmxOutputSettings>(() => loadDmxOutputSettings(hasDesktopBridge));
  const [interfaces, setInterfaces] = useState<DmxNetworkInterfaceBridge[]>([]);
  const [desktopStatus, setDesktopStatus] = useState<DmxStatusBridge | null>(null);
  const [serialStatus, setSerialStatus] = useState<SerialTransportStatus>(INITIAL_SERIAL_STATUS);
  const [discoveredNodes, setDiscoveredNodes] = useState<ArtNetDiscoveredNodeBridge[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryWarning, setDiscoveryWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const authorityRef = useRef<DmxAuthorityBridge | null>(null);
  const armedClaimRef = useRef<DmxAuthorityBridge | null>(null);
  const serialClaimRef = useRef<DmxAuthorityBridge | null>(null);
  const networkAuthorityRef = useRef<DmxAuthorityBridge | null>(null);
  const desktopLiveRef = useRef(false);
  const mountedRef = useRef(true);
  const faultGenRef = useRef(0);
  const busyOwnerRef = useRef<symbol | undefined>(undefined);
  const stopCurrentOutputRef = useRef<() => Promise<boolean>>(async () => false);
  const [faultNotice, setFaultNotice] = useState<string | null>(null);
  const [dismissedStopEventId, setDismissedStopEventId] = useState<number | null>(null);

  const beginAction = useCallback(() => {
    const owner = Symbol();
    busyOwnerRef.current = owner;
    busyRef.current = true;
    if (mountedRef.current) setBusy(true);
    return owner;
  }, []);

  const finishAction = useCallback((owner: symbol) => {
    if (busyOwnerRef.current !== owner) return;
    busyOwnerRef.current = undefined;
    busyRef.current = false;
    if (mountedRef.current) setBusy(false);
  }, []);

  const getEligibility = useCallback(() => {
    const check = canArmCheckRef.current?.();
    if (rigRef?.current && hasExtendedDmx(rigRef.current)) {
      return { allowed: false, reason: 'Current physical transports support logical U1–U2 only.', revision: check?.revision };
    }
    const engine = engineRef.current;
    if (!mountedRef.current || !enabledRef.current || engine?.isContextLost() || engine?.isDisposed()) {
      return { allowed: false, reason: 'Physical output is unavailable in the current desk state.', revision: check?.revision };
    }
    return check ?? { allowed: false, reason: 'Run pre-flight before starting live DMX output.', revision: undefined };
  }, [engineRef, rigRef]);

  const isAuthorityCurrent = useCallback((authority: DmxAuthorityBridge) => {
    if (!sameAuthority(authorityRef.current, authority)) return false;
    const check = getEligibility();
    return check.allowed && check.revision === authority.revision;
  }, [getEligibility]);

  const releaseClaim = useCallback((kind: 'armed' | 'serial', expected?: DmxAuthorityBridge) => {
    const ref = kind === 'armed' ? armedClaimRef : serialClaimRef;
    const authority = ref.current;
    if (!authority || (expected && !sameAuthority(authority, expected))) return;
    ref.current = null;
    if (kind === 'armed' && mountedRef.current) setArmed(false);
    void window.stageforgeDesktop?.outputClaim({ type: 'release', kind, authority }).catch(() => {});
  }, []);

  const revokeAuthority = useCallback(() => {
    const revoked = authorityRef.current;
    authorityRef.current = null;
    networkAuthorityRef.current = null;
    desktopLiveRef.current = false;
    const generation = faultGenRef.current = ++nextAuthorityGeneration;
    if (revoked) void window.stageforgeDesktop?.setDmxEligibility?.({
      authority: { revision: revoked.revision, generation }, eligible: false,
    }).catch(() => {});
    releaseClaim('armed');
  }, [releaseClaim]);

  const disarm = useCallback(() => {
    if (networkAuthorityRef.current || serialClaimRef.current || serialRef.current?.isRunning()) {
      void stopCurrentOutputRef.current().catch(() => {});
    } else revokeAuthority();
  }, [revokeAuthority]);

  const arm = useCallback(async (): Promise<boolean> => {
    if (!enabledRef.current || busyRef.current) return false;
    const check = getEligibility();
    if (!check.allowed || !check.revision) {
      setError(check.reason ?? 'Complete pre-flight checks before arming live DMX output.');
      return false;
    }
    if (settings.mode === 'serial' && rigRef?.current) {
      const serialSafety = checkSerialTransportSafety(rigRef.current);
      if (!serialSafety.allowed) { setError(serialSafety.reason); return false; }
    }
    const owner = beginAction();
    const authority = { revision: check.revision, generation: faultGenRef.current = ++nextAuthorityGeneration };
    authorityRef.current = authority;
    setError(null);
    const bridge = window.stageforgeDesktop;
    try {
      if (bridge?.setDmxEligibility && !await bridge.setDmxEligibility({ authority, eligible: true })) {
        throw new Error('The desktop rejected the current pre-flight eligibility.');
      }
      if (!isAuthorityCurrent(authority)) return false;
      if (bridge?.outputClaim) {
        const res = await bridge.outputClaim({ type: 'claim', kind: 'armed', authority });
        if (!res.ok) throw new Error(res.reason ?? 'Cannot reserve the current output interlock.');
        if (!isAuthorityCurrent(authority)) {
          void bridge.outputClaim({ type: 'release', kind: 'armed', authority }).catch(() => {});
          return false;
        }
      }
      armedClaimRef.current = authority;
      setFaultNotice(null);
      setArmed(true);
      return true;
    } catch (err) {
      if (isAuthorityCurrent(authority)) {
        revokeAuthority();
        setError(err instanceof Error ? err.message : 'Could not reserve output interlock.');
      }
      return false;
    } finally {
      finishAction(owner);
    }
  }, [beginAction, finishAction, getEligibility, isAuthorityCurrent, revokeAuthority, rigRef, settings.mode]);

  const serialRef = useRef<EnttecProTransport | null>(null);
  if (!serialRef.current) {
    serialRef.current = new EnttecProTransport((next) => {
      if (!mountedRef.current) return;
      setSerialStatus(next);
      if (next.error) {
        setError(next.error);
        if (!next.enabled) {
          releaseClaim('serial');
          revokeAuthority();
        }
      }
    });
  }

  const updateSettings = useCallback((patch: Partial<DmxOutputSettings>) => {
    if (!enabledRef.current) return;
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveDmxOutputSettings(next);
      return next;
    });
    setError(null);
  }, []);

  const refreshInterfaces = useCallback(async () => {
    if (!enabledRef.current) return;
    const bridge = window.stageforgeDesktop;
    if (!bridge?.dmxControl) return;
    try {
      const list = await bridge.dmxControl({ type: 'listInterfaces' });
      if (!enabledRef.current) return;
      setInterfaces(list);
      setSettings((prev) => {
        if (list.length > 0 && !list.some((item) => item.address === prev.iface)) {
          const next = { ...prev, iface: list[0].address };
          saveDmxOutputSettings(next);
          return next;
        }
        return prev;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not enumerate network interfaces.');
    }
  }, []);

  const receiveDesktopStatus = useCallback((status: DmxStatusBridge) => {
    const current = networkAuthorityRef.current;
    if (status.enabled) {
      if (status.state !== 'running' || !current || !sameAuthority(status.authority, current) || !isAuthorityCurrent(current)) return false;
      desktopLiveRef.current = true;
    } else {
      if (current && status.authority && !sameAuthority(status.authority, current)) return false;
      if (current && !status.authority) return false;
      desktopLiveRef.current = false;
      if (current && status.state === 'idle') {
        networkAuthorityRef.current = null;
        if (sameAuthority(authorityRef.current, current)) revokeAuthority();
      }
    }
    if (mountedRef.current) setDesktopStatus(status);
    return true;
  }, [isAuthorityCurrent, revokeAuthority]);

  // Status for this attempt may arrive before or after the Go reply.
  useEffect(() => {
    const bridge = window.stageforgeDesktop;
    if (!enabled || !bridge?.onDmxStatus || !bridge?.dmxControl) return;
    const unsub = bridge.onDmxStatus((status) => {
      if (receiveDesktopStatus(status) && status.nodes.length > 0) setDiscoveredNodes(status.nodes);
    });
    const unsubRevocation = bridge.onDmxAuthorityRevoked?.((authority, reason) => {
      if (sameAuthority(authorityRef.current, authority)) void emergencyStopRef.current(`Output stopped: ${reason}.`);
    });
    void bridge.dmxControl({ type: 'getStatus' }).then(receiveDesktopStatus).catch(() => {});
    return () => { unsub(); unsubRevocation?.(); };
  }, [enabled, receiveDesktopStatus]);

  const desktopLive = enabled && Boolean(desktopStatus?.enabled);

  // Best-effort browser Web Serial blackout on page unload / tab close, including pending acquisition.
  useEffect(() => {
    mountedRef.current = true;
    const shutdown = () => {
      const network = networkAuthorityRef.current;
      const serialClaim = serialClaimRef.current;
      revokeAuthority();
      engineRef.current?.setDmxFrameListener(undefined);
      serialRef.current?.emergencyBlackoutBestEffort();
      void serialRef.current?.disable().finally(() => {
        if (serialClaim) releaseClaim('serial', serialClaim);
      });
      if (network) void window.stageforgeDesktop?.dmxControl({ type: 'disable' }).catch(() => {});
    };
    window.addEventListener('pagehide', shutdown);
    window.addEventListener('beforeunload', shutdown);
    return () => {
      mountedRef.current = false;
      window.removeEventListener('pagehide', shutdown);
      window.removeEventListener('beforeunload', shutdown);
      shutdown();
    };
  }, [engineRef, releaseClaim, revokeAuthority]);

  const serialLive = enabled && serialStatus.enabled;
  const isLive = enabled && (desktopLive || serialLive);
  const emergencyStopRef = useRef<(notice: string) => Promise<void>>(async () => {});

  // Wire StageEngine's lightweight <= 44 Hz frame listener ONLY while live output is enabled.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (!enabled || !isLive) {
      engine.setDmxFrameListener(undefined);
      return;
    }
    const bridge = window.stageforgeDesktop;
    const serial = serialRef.current;
    const authority = authorityRef.current;
    if (!authority) return;
    engine.setDmxFrameListener((u1, u2, u1Changed, u2Changed, serialU1, serialU2) => {
      if (!isAuthorityCurrent(authority)) return;
      // Reject frames synchronously if pre-flight revision became stale/blocked before React effects run (qa-03 R3).
      const liveCheck = canArmCheckRef.current?.();
      if (liveCheck && !liveCheck.allowed) {
        void emergencyStopRef.current(
          `Output stopped: ${liveCheck.reason ?? 'Pre-flight safety check became stale or blocked.'}`,
        );
        return;
      }
      if (serialLive && rigRef?.current) {
        const serialCheck = checkSerialTransportSafety(rigRef.current);
        if (!serialCheck.allowed) {
          void emergencyStopRef.current(
            `Output stopped: ${serialCheck.reason ?? 'USB Serial DMX is blocked for the current rig.'}`,
          );
          return;
        }
      }
      if (desktopLive && bridge?.sendDmxFrame) {
        if (u1Changed) bridge.sendDmxFrame(1, u1, authority);
        if (u2Changed) bridge.sendDmxFrame(2, u2, authority);
      }
      if (serialLive && serial) {
        if (u1Changed) serial.update(1, serialU1);
        if (u2Changed) serial.update(2, serialU2);
      }
    });
    return () => {
      engine.setDmxFrameListener(undefined);
    };
  }, [engineRef, rigRef, enabled, isLive, desktopLive, serialLive, isAuthorityCurrent]);

  const discoverArtNet = useCallback(async () => {
    if (!enabledRef.current) return;
    const bridge = window.stageforgeDesktop;
    if (!bridge?.dmxControl || discovering) return;
    setDiscovering(true);
    setDiscoveryWarning(null);
    setError(null);
    try {
      const result = await bridge.dmxControl({ type: 'discover', iface: settings.iface });
      if (!enabledRef.current) return;
      setDiscoveredNodes(result.nodes);
      setDiscoveryWarning(result.warning);
      if (result.nodes.length > 0) {
        onToast(`Found ${result.nodes.length} Art-Net ${result.nodes.length === 1 ? 'node' : 'nodes'}.`);
      } else if (!result.warning) {
        onToast('No Art-Net nodes replied on this interface.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Art-Net discovery failed.');
    } finally {
      setDiscovering(false);
    }
  }, [discovering, onToast, settings.iface]);

  const stopCurrentOutput = useCallback(async () => {
    const network = networkAuthorityRef.current;
    const serialClaim = serialClaimRef.current;
    const active = desktopLiveRef.current || serialRef.current?.isRunning();
    revokeAuthority();
    const generation = faultGenRef.current;
    engineRef.current?.setDmxFrameListener(undefined);
    onBeforeDisableRef.current?.();
    if (mountedRef.current) setDesktopStatus(prev => prev?.enabled ? { ...prev, enabled: false, state: 'idle' } : prev);
    const bridge = window.stageforgeDesktop;
    await Promise.all([
      serialRef.current!.disable().finally(() => { if (serialClaim) releaseClaim('serial', serialClaim); }),
      network && bridge?.dmxControl ? bridge.dmxControl({ type: 'disable' }).then(status => {
        if (faultGenRef.current === generation) receiveDesktopStatus(status);
      }) : undefined,
    ]);
    return Boolean(active);
  }, [engineRef, receiveDesktopStatus, releaseClaim, revokeAuthority]);
  stopCurrentOutputRef.current = stopCurrentOutput;

  const emergencyStopOnFault = useCallback(async (notice: string) => {
    const hadActivity = Boolean(authorityRef.current || desktopLiveRef.current || serialRef.current?.isRunning());
    if (mountedRef.current && hadActivity) {
      setFaultNotice(notice);
      setError(notice);
    }
    try { await stopCurrentOutput(); } catch { /* existing transport watchdog remains active */ }
  }, [stopCurrentOutput]);
  emergencyStopRef.current = emergencyStopOnFault;

  // Structural changes revoke synchronously at the desk. Also catch same-revision eligibility
  // loss from warning acknowledgements, lifecycle and bridge state on the committed render.
  useEffect(() => {
    const authority = authorityRef.current;
    if (authority && !isAuthorityCurrent(authority)) {
      const current = getEligibility();
      void emergencyStopRef.current(`Output stopped: ${current.reason ?? 'Pre-flight eligibility changed.'}`);
    }
  });

  const disable = useCallback(async () => {
    const owner = beginAction();
    setError(null);
    try {
      if (await stopCurrentOutput()) onToast('DMX output stopped · blackout sent.');
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : 'Could not stop DMX output.');
    } finally {
      finishAction(owner);
    }
  }, [beginAction, finishAction, onToast, stopCurrentOutput]);

  const enable = useCallback(async (): Promise<boolean> => {
    if (!enabledRef.current || busyRef.current) return false;
    const authority = armedClaimRef.current;
    if (!authority || !isAuthorityCurrent(authority)) {
      disarm();
      setError('Arm live DMX output at the current pre-flight revision before clicking Go live.');
      return false;
    }
    const owner = beginAction();
    const bridge = window.stageforgeDesktop;
    const isCurrent = () => isAuthorityCurrent(authority);
    setError(null);
    try {
      if (settings.mode === 'serial') {
        const serialSafety = rigRef?.current && checkSerialTransportSafety(rigRef.current);
        if (serialSafety && !serialSafety.allowed) throw new Error(serialSafety.reason ?? 'USB Serial DMX is blocked for this rig.');
        if (bridge?.outputClaim) {
          const result = await bridge.outputClaim({ type: 'claim', kind: 'serial', authority });
          if (!result.ok) throw new Error(result.reason ?? 'Could not claim USB Serial DMX output.');
          if (!isCurrent()) {
            void bridge.outputClaim({ type: 'release', kind: 'serial', authority }).catch(() => {});
            return false;
          }
          serialClaimRef.current = authority;
        }
        const status = await serialRef.current!.enable({
          universe: settings.serialUniverse, rateHz: Math.min(44, Math.max(1, settings.rateHz)),
          allowAllDevices: settings.serialAllowAll, isEligible: isCurrent,
        });
        if (!isCurrent()) return false;
        setSerialStatus(status);
        onToast(`Live USB DMX active on Universe ${status.universe}.`);
      } else {
        if (!bridge?.dmxControl) throw new Error('Network DMX (sACN / Art-Net 4) requires the StageForge desktop app.');
        const config = settings.mode === 'sacn'
          ? {
              protocol: 'sacn' as const,
              iface: settings.iface,
              rateHz: Math.min(44, Math.max(1, settings.rateHz)),
              sourceName: 'StageForge',
              sacn: {
                mode: settings.sacnMode,
                universes: [settings.sacnUniverse1, settings.sacnUniverse2] as [number, number],
                priority: settings.sacnPriority,
                ttl: settings.sacnTtl,
                targets: settings.sacnMode === 'unicast' ? parseTargetList(settings.sacnTargets) : [],
              },
            }
          : {
              protocol: 'artnet' as const,
              iface: settings.iface,
              rateHz: Math.min(44, Math.max(1, settings.rateHz)),
              artnet: { base: settings.artnetBase, targets: parseTargetList(settings.artnetTargets), broadcast: settings.artnetBroadcast },
            };
        // The matching running push is accepted while the awaited reply is still pending.
        networkAuthorityRef.current = authority;
        const status = await bridge.dmxControl({ type: 'enable', config, authority });
        if (!isCurrent()) return false;
        if (!status.enabled || !receiveDesktopStatus(status)) throw new Error('Desktop DMX did not start the current claim.');
        onToast(`Live ${settings.mode === 'sacn' ? 'sACN' : 'Art-Net 4'} output active.`);
      }
      releaseClaim('armed', authority);
      setFaultNotice(null);
      return true;
    } catch (err) {
      if (sameAuthority(authorityRef.current, authority)) {
        const message = err instanceof Error ? err.message : 'Could not start DMX output.';
        await emergencyStopOnFault(message);
      }
      return false;
    } finally {
      finishAction(owner);
    }
  }, [beginAction, disarm, emergencyStopOnFault, finishAction, isAuthorityCurrent, onToast, receiveDesktopStatus, releaseClaim, rigRef, settings]);

  // Unified 1 Hz control-loop health + renderer heartbeat watchdog while live DMX (desktop OR Web Serial) is active.
  // Renews Electron's 5 s heartbeat ONLY when StageEngine's control loop is actively advancing (`seq` progress and
  // `lastTickMs` <= 2.5 s) and WebGL is not lost/disposed; actively triggers paced blackout shutdown on stall or context loss.
  useEffect(() => {
    if (!enabled || !isLive) return;
    const bridge = window.stageforgeDesktop;
    const authority = authorityRef.current;
    if (!authority) return;
    let prevSeq: number | null = null;
    let lastProgressMs = performance.now();

    const checkAndHeartbeat = (initial: boolean) => {
      if (!isAuthorityCurrent(authority)) return;
      const engine = engineRef.current;
      const health = engine?.getControlLoopHealth();
      const now = performance.now();
      if (!engine || !health || health.disposed || health.contextLost) {
        void emergencyStopOnFault('Output stopped: graphics context lost');
        return;
      }
      if (prevSeq === null || health.seq !== prevSeq) {
        prevSeq = health.seq;
        lastProgressMs = now;
      }
      const tickAgeMs = health.lastTickMs > 0 ? now - health.lastTickMs : now - lastProgressMs;
      const seqStallMs = now - lastProgressMs;
      if (!initial && (health.standby || tickAgeMs > CONTROL_LOOP_STALL_TIMEOUT_MS || seqStallMs > CONTROL_LOOP_STALL_TIMEOUT_MS)) {
        void emergencyStopOnFault('Output stopped: control loop stalled');
        return;
      }
      if (desktopLive && bridge?.sendDmxHeartbeat) {
        bridge.sendDmxHeartbeat(authority);
      }
    };

    checkAndHeartbeat(true);
    const timer = window.setInterval(() => checkAndHeartbeat(false), 1000);
    return () => window.clearInterval(timer);
  }, [desktopLive, emergencyStopOnFault, enabled, engineRef, isAuthorityCurrent, isLive]);

  const dismissStoppedNotice = useCallback(() => {
    setFaultNotice(null);
    if (desktopStatus?.stopEventId !== undefined) {
      setDismissedStopEventId(desktopStatus.stopEventId);
    }
  }, [desktopStatus?.stopEventId]);

  const banner = useMemo<LiveDmxBannerState>(() => {
    if (!enabled) {
      return { active: false, label: 'OFF', detail: '', degraded: false, error: null, stoppedNotice: null };
    }
    if (desktopStatus?.enabled) {
      const proto = desktopStatus.protocol === 'sacn' ? 'sACN' : 'Art-Net';
      const uniLabel = desktopStatus.universes
        ? `U${desktopStatus.universes[0]}/${desktopStatus.universes[1]}`
        : '';
      const hz = desktopStatus.measuredHz > 0 ? `${desktopStatus.measuredHz} Hz` : `${desktopStatus.rateHz} Hz`;
      return {
        active: true,
        label: `LIVE · ${proto}`,
        detail: [uniLabel, hz].filter(Boolean).join(' · '),
        degraded: desktopStatus.degraded,
        error: desktopStatus.lastError,
        stoppedNotice: null,
      };
    }
    if (serialStatus.enabled) {
      const hz = serialStatus.measuredHz > 0 ? `${serialStatus.measuredHz} Hz` : `${serialStatus.rateHz} Hz`;
      return {
        active: true,
        label: 'LIVE · USB DMX',
        detail: `U${serialStatus.universe} · ${hz}`,
        degraded: Boolean(serialStatus.error),
        error: serialStatus.error,
        stoppedNotice: null,
      };
    }
    const stoppedNotice =
      faultNotice ??
      (desktopStatus?.lastStopReason === 'heartbeat-timeout' &&
      desktopStatus.stopEventId !== dismissedStopEventId
        ? 'Output stopped: app stopped responding'
        : null);
    return {
      active: false,
      label: 'OFF',
      detail: '',
      degraded: false,
      error: null,
      stoppedNotice,
    };
  }, [desktopStatus, dismissedStopEventId, enabled, faultNotice, serialStatus]);

  return {
    hasDesktopBridge,
    hasWebSerial,
    settings,
    updateSettings,
    interfaces,
    refreshInterfaces,
    desktopStatus,
    serialStatus,
    discoveredNodes,
    discovering,
    discoveryWarning,
    discoverArtNet,
    busy,
    error,
    armed,
    arm,
    disarm,
    isLive,
    banner,
    dismissStoppedNotice,
    enable,
    disable,
    emergencyStopOnFault,
  };
}
