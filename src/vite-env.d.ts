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

interface Window {
  stageforgeDesktop?: {
    onRigCommand(listener: (command: 'open' | 'openBundle' | 'openMvr' | 'export' | 'show' | 'bundle' | 'dxf' | 'glb' | 'csv' | 'mvr', source?: string | Uint8Array) => void): () => void;
    sendDmxFrame(universe: 1 | 2, data: Uint8Array): boolean;
    dmxControl(command: { type: 'listInterfaces' }): Promise<DmxNetworkInterfaceBridge[]>;
    dmxControl(command: { type: 'getStatus' }): Promise<DmxStatusBridge>;
    dmxControl(command: { type: 'disable' }): Promise<DmxStatusBridge>;
    dmxControl(command: { type: 'discover'; iface: string }): Promise<{ nodes: ArtNetDiscoveredNodeBridge[]; warning: string | null }>;
    dmxControl(command: Extract<DmxControlCommandBridge, { type: 'enable' }>): Promise<DmxStatusBridge>;
    dmxControl(command: DmxControlCommandBridge): Promise<unknown>;
    onDmxStatus(listener: (status: DmxStatusBridge) => void): () => void;
  };
}
