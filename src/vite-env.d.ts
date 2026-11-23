/// <reference types="vite/client" />

interface Window {
  stageforgeDesktop?: {
    onRigCommand(listener: (command: 'open' | 'export' | 'show' | 'dxf' | 'glb' | 'csv', json?: string) => void): () => void;
  };
}
