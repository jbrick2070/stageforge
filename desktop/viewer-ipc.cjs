'use strict';

// Pure Electron main-process viewer-mode tracker and IPC handler.
// Extracted so Node security tests can exercise sender/type validation and menu-restriction logic directly.

const { isAuthorizedDmxSender } = require('./dmx-ipc.cjs');

// File menu item IDs that mutate desk state or export/save files; disabled while the active window is in viewer mode.
const MUTATING_FILE_MENU_IDS = Object.freeze([
  'file-open',
  'file-save-show',
  'file-save-bundle',
  'file-export-rig',
  'file-export-submenu',
  'file-export-mvr',
  'file-export-dxf',
  'file-export-glb',
  'file-export-csv',
]);

function createViewerModeTracker() {
  const viewerWindows = new Set();

  function isViewerWindow(wcId) {
    return typeof wcId === 'number' && viewerWindows.has(wcId);
  }

  function setViewerWindow(wcId, active) {
    if (typeof wcId !== 'number') return false;
    if (active) viewerWindows.add(wcId);
    else viewerWindows.delete(wcId);
    return viewerWindows.has(wcId);
  }

  function clearWindow(wcId) {
    if (typeof wcId !== 'number') return;
    viewerWindows.delete(wcId);
  }

  function applyMenuRestrictions(menu, restricted) {
    if (!menu || typeof menu.getMenuItemById !== 'function') return;
    const enabled = !restricted;
    for (const id of MUTATING_FILE_MENU_IDS) {
      const item = menu.getMenuItemById(id);
      if (item) item.enabled = enabled;
    }
  }

  return {
    isViewerWindow,
    setViewerWindow,
    clearWindow,
    applyMenuRestrictions,
  };
}

function createViewerIpcHandler({ tracker, onEnterViewer, onStateChanged }) {
  return async function onSetViewerMode(event, active) {
    if (!isAuthorizedDmxSender(event)) {
      throw new Error('Unauthorized viewer mode request.');
    }
    if (typeof active !== 'boolean') {
      throw new Error('Expected a boolean viewer mode flag.');
    }
    const wcId = event.sender.id;
    tracker.setViewerWindow(wcId, active);
    if (active && typeof onEnterViewer === 'function') {
      await onEnterViewer(wcId);
    }
    if (typeof onStateChanged === 'function') {
      onStateChanged(wcId, active);
    }
    return { viewer: active };
  };
}

module.exports = {
  MUTATING_FILE_MENU_IDS,
  createViewerModeTracker,
  createViewerIpcHandler,
};
