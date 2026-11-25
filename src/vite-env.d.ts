/// <reference types="vite/client" />

interface DmxNetworkInterfaceBridge {
  name: string;
  address: string;
  netmask: string;
  broadcast: string | null;
  internal: boolean;
}

interface ArtNetDiscoveredNodeBridge {
  ip: string;
  port: number;
  shortName: string;
  longName: string;
  netSwitch: number;
  subSwitch: number;
  outputs: number[];
  mac: string;
  bindIp: string;
  bindIndex: number;
}

interface DmxStatusBridge {
  enabled: boolean;
  state: 'idle' | 'running' | 'stopping';
  protocol: 'sacn' | 'artnet' | null;
  iface: string | null;
  rateHz: number;
  measuredHz: number;
  packetsSent: number;
  degraded: boolean;
  lastError: string | null;
  lastStopReason?: string | null;
  lastStopOwnerId?: number | null;
  stopEventId?: number;
  cid: string;
  universes: [number, number] | null;
  nodes: ArtNetDiscoveredNodeBridge[];
}

type DmxControlCommandBridge =
  | { type: 'listInterfaces' }
  | { type: 'getStatus' }
  | { type: 'disable' }
  | { type: 'discover'; iface: string }
  | {
      type: 'enable';
      config: {
        protocol: 'sacn' | 'artnet';
        iface: string;
        rateHz: number;
        sourceName?: string;
        sacn?: {
          mode: 'multicast' | 'unicast';
          universes: [number, number];
          priority: number;
          ttl: number;
          targets: string[];
        };
        artnet?: {
          base: number;
          targets: string[];
          broadcast: boolean;
        };
      };
    };

interface ShowControlConfigBridge {
  oscRxEnabled: boolean;
  oscPort: number;
  oscAllowAllInterfaces: boolean;
  oscTxEnabled: boolean;
  oscTxHost: string;
  oscTxPort: number;
  artnetTcRxEnabled: boolean;
  artnetTcTxEnabled: boolean;
  artnetTcTxHost: string;
}

interface ShowControlStatusBridge {
  active: boolean;
  oscRxListening: boolean;
  oscRxPort: number | null;
  oscRxAddress: string | null;
  oscTxEnabled: boolean;
  oscTxHost: string;
  oscTxPort: number;
  artnetTcRxListening: boolean;
  artnetTcRxPort: number | null;
  artnetTcTxEnabled: boolean;
  artnetTcTxHost: string;
  oscRxCount: number;
  oscDroppedCount: number;
  artnetTcRxCount: number;
  oscError: string | null;
  artnetTcError: string | null;
}

type ShowControlEventBridge =
  | {
      source: 'osc' | 'msc';
      kind: 'trigger';
      command: 'go' | 'back' | 'stop' | 'resume' | 'reset' | 'blackout' | 'master' | 'bump' | 'tempo_tap' | 'tempo_bpm' | 'tempo_half' | 'tempo_double' | 'audio_reactive' | 'audio_mapping_amount';
      cue?: { index?: number; ref?: string };
      bumpKey?: 'blinder' | 'strobe' | 'co2' | 'smoke' | 'laser' | 'motorDrop';
      mappingId?: string;
      value?: number;
      sender?: string;
      at: number;
    }
  | {
      source: 'artnetTC' | 'mtc';
      kind: 'timecode';
      ms: number;
      fps: 24 | 25 | 29.97 | 30;
      hours?: number;
      minutes?: number;
      seconds?: number;
      frames?: number;
      locate?: boolean;
      reverse?: boolean;
      at: number;
    };

type ShowControlSendBridge =
  | { kind: 'timecode'; ms: number; fps: 24 | 25 | 29.97 | 30 }
  | { kind: 'feedback'; cue?: string; timecode?: string; bpm?: number; clock?: 'master' | 'chase' | 'caller' };

type ShowControlCommandBridge =
  | { type: 'getStatus' }
  | { type: 'stop' }
  | { type: 'configure'; config: ShowControlConfigBridge }
  | { type: 'send'; payload: ShowControlSendBridge };

interface Window {
  stageforgeDesktop?: {
    onRigCommand(listener: (command: 'open' | 'openBundle' | 'openMvr' | 'openViewer' | 'export' | 'show' | 'bundle' | 'dxf' | 'glb' | 'csv' | 'mvr', source?: string | Uint8Array) => void): () => void;
    sendDmxFrame(universe: 1 | 2, data: Uint8Array): boolean;
    sendDmxHeartbeat(): boolean;
    dmxControl(command: { type: 'listInterfaces' }): Promise<DmxNetworkInterfaceBridge[]>;
    dmxControl(command: { type: 'getStatus' }): Promise<DmxStatusBridge>;
    dmxControl(command: { type: 'disable' }): Promise<DmxStatusBridge>;
    dmxControl(command: { type: 'discover'; iface: string }): Promise<{ nodes: ArtNetDiscoveredNodeBridge[]; warning: string | null }>;
    dmxControl(command: Extract<DmxControlCommandBridge, { type: 'enable' }>): Promise<DmxStatusBridge>;
    dmxControl(command: DmxControlCommandBridge): Promise<unknown>;
    onDmxStatus(listener: (status: DmxStatusBridge) => void): () => void;
    showControl(command: { type: 'getStatus' }): Promise<ShowControlStatusBridge>;
    showControl(command: { type: 'stop' }): Promise<ShowControlStatusBridge>;
    showControl(command: { type: 'configure'; config: ShowControlConfigBridge }): Promise<ShowControlStatusBridge>;
    showControl(command: { type: 'send'; payload: ShowControlSendBridge }): Promise<boolean>;
    showControl(command: ShowControlCommandBridge): Promise<unknown>;
    onShowControlEvent(listener: (event: ShowControlEventBridge) => void): () => void;
    onShowControlStatus(listener: (status: ShowControlStatusBridge) => void): () => void;
    setViewerMode(active: boolean): Promise<{ viewer: boolean }>;
  };
}
