/// <reference types="vite/client" />

interface Window {
  stageforgeDesktop?: {
    onRigCommand(listener: (command: 'open' | 'openBundle' | 'export' | 'show' | 'bundle' | 'dxf' | 'glb' | 'csv', source?: string | Uint8Array) => void): () => void;
  };
}
