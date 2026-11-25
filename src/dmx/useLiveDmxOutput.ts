import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StageEngine } from '../engine/StageEngine';
import { EnttecProTransport, isWebSerialSupported, type SerialTransportStatus } from './enttecPro';
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
}

export function useLiveDmxOutput(
  engineRef: React.RefObject<StageEngine | null>,
  onToast: (message: string) => void,
  enabled = true,
  onBeforeDisable?: () => void,
  canArmCheck?: () => { allowed: boolean; reason?: string },
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
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  armedRef.current = armed;
  const serialClaimedRef = useRef(false);
  const [dismissedStopEventId, setDismissedStopEventId] = useState<number | null>(null);

  const releaseClaim = useCallback((kind: 'armed' | 'serial') => {
    if (kind === 'armed') {
      if (!armedRef.current) return;
      armedRef.current = false;
      setArmed(false);
    } else {
      if (!serialClaimedRef.current) return;
      serialClaimedRef.current = false;
    }
    const bridge = window.stageforgeDesktop;
    if (bridge?.outputClaim) {
      void bridge.outputClaim({ type: 'release', kind }).catch(() => {});
    }
  }, []);

  const disarm = useCallback(() => {
    releaseClaim('armed');
  }, [releaseClaim]);

  const arm = useCallback(async (): Promise<boolean> => {
    if (!enabledRef.current) return false;
    const preCheck = canArmCheckRef.current?.();
    if (preCheck && !preCheck.allowed) {
      setError(preCheck.reason ?? 'Complete pre-flight checks before arming live DMX output.');
      return false;
    }
    setError(null);
    const bridge = window.stageforgeDesktop;
    if (bridge?.outputClaim) {
      try {
        const res = await bridge.outputClaim({ type: 'claim', kind: 'armed' });
        if (!mountedRef.current || !enabledRef.current) {
          void bridge.outputClaim({ type: 'release', kind: 'armed' }).catch(() => {});
          return false;
        }
        if (!res.ok) {
          setError(res.reason ?? 'Cannot arm live DMX output while AI bridge is enabled.');
          return false;
        }
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : 'Could not reserve output interlock.');
        }
        return false;
      }
    }
    const postCheck = canArmCheckRef.current?.();
    if (postCheck && !postCheck.allowed) {
      if (bridge?.outputClaim) {
        void bridge.outputClaim({ type: 'release', kind: 'armed' }).catch(() => {});
      }
      setError(postCheck.reason ?? 'Pre-flight state changed while arming.');
      return false;
    }
    armedRef.current = true;
    setArmed(true);
    return true;
  }, []);

  const serialRef = useRef<EnttecProTransport | null>(null);
  if (!serialRef.current) {
    serialRef.current = new EnttecProTransport((next) => {
      setSerialStatus(next);
      if (!next.enabled && serialClaimedRef.current) {
        serialClaimedRef.current = false;
        if (window.stageforgeDesktop?.outputClaim) {
          void window.stageforgeDesktop.outputClaim({ type: 'release', kind: 'serial' }).catch(() => {});
        }
      }
      if (next.error) setError(next.error);
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

  // Subscribe to main-process DMX status pushes and query initial (always off) status.
  useEffect(() => {
    const bridge = window.stageforgeDesktop;
    if (!enabled || !bridge?.onDmxStatus || !bridge?.dmxControl) return;
    const unsub = bridge.onDmxStatus((status) => {
      setDesktopStatus(status);
      if (status.nodes.length > 0) setDiscoveredNodes(status.nodes);
    });
    void bridge.dmxControl({ type: 'getStatus' }).then(setDesktopStatus).catch(() => {});
    return unsub;
  }, [enabled]);

  const desktopLive = enabled && Boolean(desktopStatus?.enabled);
  const desktopLiveRef = useRef(false);
  desktopLiveRef.current = Boolean(desktopStatus?.enabled);
  const mountedRef = useRef(true);

  // Runtime-only shutdown when capability is revoked (e.g. entering pitch viewer).
  // Never writes localStorage so operator preferences remain untouched.
  useEffect(() => {
    if (enabled) return;
    engineRef.current?.setDmxFrameListener(undefined);
    releaseClaim('armed');
    void serialRef.current?.disable().finally(() => releaseClaim('serial'));
    if (desktopLiveRef.current && window.stageforgeDesktop?.dmxControl) {
      void window.stageforgeDesktop.dmxControl({ type: 'disable' }).then(setDesktopStatus).catch(() => {});
    }
    setDesktopStatus((prev) => (prev?.enabled ? { ...prev, enabled: false, state: 'idle' } : prev));
    setSerialStatus((prev) => (prev.enabled ? { ...prev, enabled: false } : prev));
    setDiscovering(false);
    setError(null);
  }, [enabled, engineRef, releaseClaim]);

  // Best-effort browser Web Serial blackout on page unload / tab close.
  useEffect(() => {
    mountedRef.current = true;
    const onPageHide = () => {
      if (enabledRef.current) {
        serialRef.current?.emergencyBlackoutBestEffort();
      }
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      mountedRef.current = false;
      window.removeEventListener('pagehide', onPageHide);
      releaseClaim('armed');
      void serialRef.current?.disable().finally(() => releaseClaim('serial'));
      if (desktopLiveRef.current && window.stageforgeDesktop?.dmxControl) {
        void window.stageforgeDesktop.dmxControl({ type: 'disable' }).catch(() => {});
      }
    };
  }, [releaseClaim]);

  const serialLive = enabled && serialStatus.enabled;
  const isLive = enabled && (desktopLive || serialLive);

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
    engine.setDmxFrameListener((u1, u2, u1Changed, u2Changed) => {
      if (!enabledRef.current) return;
      if (desktopLive && bridge?.sendDmxFrame) {
        if (u1Changed) bridge.sendDmxFrame(1, u1);
        if (u2Changed) bridge.sendDmxFrame(2, u2);
      }
      if (serialLive && serial) {
        if (u1Changed) serial.update(1, u1);
        if (u2Changed) serial.update(2, u2);
      }
    });
    return () => {
      engine.setDmxFrameListener(undefined);
    };
  }, [engineRef, enabled, isLive, desktopLive, serialLive]);

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

  const disable = useCallback(async () => {
    onBeforeDisableRef.current?.();
    releaseClaim('armed');
    setBusy(true);
    setError(null);
    const wasActive = Boolean(serialRef.current?.isRunning() || desktopLiveRef.current);
    try {
      const tasks: Promise<unknown>[] = [];
      tasks.push(serialRef.current!.disable().finally(() => releaseClaim('serial')));
      if (desktopLiveRef.current && window.stageforgeDesktop?.dmxControl) {
        tasks.push(window.stageforgeDesktop.dmxControl({ type: 'disable' }).then(setDesktopStatus));
      }
      await Promise.all(tasks);
      if (wasActive) onToast('DMX output stopped · blackout sent.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not stop DMX output.');
    } finally {
      setBusy(false);
    }
  }, [onToast, releaseClaim]);

  const enable = useCallback(async (): Promise<boolean> => {
    if (!enabledRef.current) return false;
    const preCheck = canArmCheckRef.current?.();
    if (preCheck && !preCheck.allowed) {
      setError(preCheck.reason ?? 'Complete pre-flight checks before starting live DMX output.');
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      if (settings.mode === 'serial') {
        const bridge = window.stageforgeDesktop;
        if (bridge?.outputClaim) {
          const claimRes = await bridge.outputClaim({ type: 'claim', kind: 'serial' });
          if (!claimRes.ok) {
            setError(claimRes.reason ?? 'Disable the AI bridge before enabling USB Serial DMX.');
            return false;
          }
          serialClaimedRef.current = true;
        }
        if (bridge?.dmxControl && desktopStatus?.enabled) {
          await bridge.dmxControl({ type: 'disable' }).then(setDesktopStatus);
        }
        if (!enabledRef.current) {
          releaseClaim('serial');
          return false;
        }
        let status: SerialTransportStatus;
        try {
          status = await serialRef.current!.enable({
            universe: settings.serialUniverse,
            rateHz: Math.min(44, Math.max(1, settings.rateHz)),
            allowAllDevices: settings.serialAllowAll,
          });
        } catch (err) {
          releaseClaim('serial');
          throw err;
        }
        const postCheck = canArmCheckRef.current?.();
        if (!mountedRef.current || !enabledRef.current || (postCheck && !postCheck.allowed)) {
          await serialRef.current?.disable().finally(() => releaseClaim('serial'));
          if (mountedRef.current && postCheck && !postCheck.allowed) {
            setError(postCheck.reason ?? 'Pre-flight state changed while opening serial output.');
          }
          return false;
        }
        releaseClaim('armed');
        setSerialStatus(status);
        onToast(`Live USB DMX active on Universe ${status.universe}.`);
        return true;
      }

      const bridge = window.stageforgeDesktop;
      if (!bridge?.dmxControl) {
        throw new Error('Network DMX (sACN / Art-Net 4) requires the StageForge desktop app.');
      }
      if (serialRef.current?.isRunning()) {
        await serialRef.current.disable().finally(() => releaseClaim('serial'));
      }
      if (!enabledRef.current) return false;
      const midCheck = canArmCheckRef.current?.();
      if (midCheck && !midCheck.allowed) {
        setError(midCheck.reason ?? 'Pre-flight state changed before starting output.');
        return false;
      }
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
            artnet: {
              base: settings.artnetBase,
              targets: parseTargetList(settings.artnetTargets),
              broadcast: settings.artnetBroadcast,
            },
          };

      const status = await bridge.dmxControl({ type: 'enable', config });
      const postNetCheck = canArmCheckRef.current?.();
      if (!mountedRef.current || !enabledRef.current || (postNetCheck && !postNetCheck.allowed)) {
        void bridge.dmxControl({ type: 'disable' }).catch(() => {});
        if (mountedRef.current && postNetCheck && !postNetCheck.allowed) {
          setError(postNetCheck.reason ?? 'Pre-flight state changed while starting network output.');
        }
        return false;
      }
      releaseClaim('armed');
      setDesktopStatus(status);
      onToast(`Live ${settings.mode === 'sacn' ? 'sACN' : 'Art-Net 4'} output active.`);
      return true;
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Could not start DMX output.');
      }
      return false;
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [desktopStatus?.enabled, onToast, releaseClaim, settings]);

  // Send renderer liveness heartbeat (~1 Hz) to Electron main while live network DMX is active.
  // Independent of unchanged-frame suppression so static looks stay alive while a frozen renderer times out in 5 s.
  useEffect(() => {
    if (!enabled || !desktopLive) return;
    const bridge = window.stageforgeDesktop;
    if (!bridge?.sendDmxHeartbeat) return;
    bridge.sendDmxHeartbeat();
    const timer = window.setInterval(() => {
      if (enabledRef.current) bridge.sendDmxHeartbeat();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [enabled, desktopLive]);

  const dismissStoppedNotice = useCallback(() => {
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
      desktopStatus?.lastStopReason === 'heartbeat-timeout' &&
      desktopStatus.stopEventId !== dismissedStopEventId
        ? 'Output stopped: app stopped responding'
        : null;
    return {
      active: false,
      label: 'OFF',
      detail: '',
      degraded: false,
      error: null,
      stoppedNotice,
    };
  }, [desktopStatus, dismissedStopEventId, enabled, serialStatus]);

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
  };
}
