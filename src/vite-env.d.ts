/// <reference types="vite/client" />

interface Window {
  stageforgeDesktop?: {
    onRigCommand(listener: (command: 'open' | 'export', json?: string) => void): () => void;
  };
}
