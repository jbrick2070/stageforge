/// <reference types="vite/client" />

interface Window {
  stageforgeDesktop?: {
    onRigCommand(listener: (command: 'open' | 'openBundle' | 'openMvr' | 'export' | 'show' | 'bundle' | 'dxf' | 'glb' | 'csv' | 'mvr', source?: string | Uint8Array) => void): () => void;
  };
}
