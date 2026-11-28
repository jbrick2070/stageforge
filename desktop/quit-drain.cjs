'use strict';

// Keep Electron in before-quit until the same real shutdown has completed.
function createQuitDrain({ closeAdmissions, hasWork, drain, quit }) {
  let pending = null;
  let complete = false;
  return (event) => {
    closeAdmissions();
    if (complete || (!pending && !hasWork())) return;
    event.preventDefault();
    if (pending) return;
    pending = Promise.resolve().then(drain).catch(() => {}).finally(() => {
      complete = true;
      quit();
    });
  };
}

module.exports = { createQuitDrain };
