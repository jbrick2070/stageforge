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
): LiveDmxControllerApi {
  const hasDesktopBridge = Boolean(typeof window !== 'undefined' && window.stageforgeDesktop);
  const hasWebSerial = isWebSerialSupported();
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const onBeforeDisableRef = useRef(onBeforeDisable);
  onBeforeDisableRef.current = onBeforeDisable;

  const [settings, setSettings] = useState<DmxOutputSettings>(() => loadDmxOutputSettings(hasDesktopBridge));
  const [interfaces, setInterfaces] = useState<DmxNetworkInterfaceBridge[]>([]);
  const [desktopStatus, setDesktopStatus] = useState<DmxStatusBridge | null>(null);
  const [serialStatus, setSerialStatus] = useState<SerialTransportStatus>(INITIAL_SERIAL_STATUS);
  const [discoveredNodes, setDiscoveredNodes] = useState<ArtNetDiscoveredNodeBridge[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryWarning, setDiscoveryWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissedStopEventId, setDismissedStopEventId] = useState<number | null>(null);

  const serialRef = useRef<EnttecProTransport | null>(null);
  if (!serialRef.current) {
    serialRef.current = new EnttecProTransport((next) => {
      setSerialStatus(next);
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
    if (serialRef.current?.isRunning()) {
      void serialRef.current.disable();
    }
    if (desktopLiveRef.current && window.stageforgeDesktop?.dmxControl) {
      void window.stageforgeDesktop.dmxControl({ type: 'disable' }).then(setDesktopStatus).catch(() => {});
    }
    setDesktopStatus((prev) => (prev?.enabled ? { ...prev, enabled: false, state: 'idle' } : prev));
    setSerialStatus((prev) => (prev.enabled ? { ...prev, enabled: false } : prev));
    setDiscovering(false);
    setError(null);
  }, [enabled, engineRef]);

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
      if (enabledRef.current || serialRef.current?.isRunning()) {
        void serialRef.current?.disable();
      }
      if (desktopLiveRef.current && window.stageforgeDesktop?.dmxControl) {
        void window.stageforgeDesktop.dmxControl({ type: 'disable' }).catch(() => {});
      }
    };
  }, []);

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
    setBusy(true);
    setError(null);
    const wasActive = Boolean(serialRef.current?.isRunning() || desktopLiveRef.current);
    try {
      const tasks: Promise<unknown>[] = [];
      if (serialRef.current?.isRunning()) {
        tasks.push(serialRef.current.disable());
      }
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
  }, [onToast]);

  const enable = useCallback(async (): Promise<boolean> => {
    if (!enabledRef.current) return false;
    setBusy(true);
    setError(null);
    try {
      if (settings.mode === 'serial') {
        if (window.stageforgeDesktop?.dmxControl && desktopStatus?.enabled) {
          await window.stageforgeDesktop.dmxControl({ type: 'disable' }).then(setDesktopStatus);
        }
        if (!enabledRef.current) return false;
        const status = await serialRef.current!.enable({
          universe: settings.serialUniverse,
          rateHz: Math.min(44, Math.max(1, settings.rateHz)),
          allowAllDevices: settings.serialAllowAll,
        });
        if (!mountedRef.current || !enabledRef.current) {
          void serialRef.current?.disable();
          return false;
        }
        setSerialStatus(status);
        onToast(`Live USB DMX active on Universe ${status.universe}.`);
        return true;
      }

      const bridge = window.stageforgeDesktop;
      if (!bridge?.dmxControl) {
        throw new Error('Network DMX (sACN / Art-Net 4) requires the StageForge desktop app.');
      }
      if (serialRef.current?.isRunning()) {
        await serialRef.current.disable();
      }
      if (!enabledRef.current) return false;
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
      if (!mountedRef.current || !enabledRef.current) {
        void bridge.dmxControl({ type: 'disable' }).catch(() => {});
        return false;
      }
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
  }, [desktopStatus?.enabled, onToast, settings]);

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
    isLive,
    banner,
    dismissStoppedNotice,
    enable,
    disable,
  };
}
