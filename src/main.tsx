import React from 'react';
import ReactDOM from 'react-dom/client';
import App, { webXrPageLatchDiagnostics } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

const rootElement = document.getElementById('root')!;
let root = ReactDOM.createRoot(rootElement);
let mounted = true;

function appTree() {
  return (
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
}

root.render(appTree());

if (new URLSearchParams(window.location.search).has('probe')) {
  window.stageforgeReactProbe = {
    unmountApp() {
      if (!mounted) return;
      root.unmount();
      mounted = false;
    },
    mountApp() {
      if (mounted) return;
      root = ReactDOM.createRoot(rootElement);
      root.render(appTree());
      mounted = true;
    },
    webXrPageLatch: webXrPageLatchDiagnostics,
  };
}
