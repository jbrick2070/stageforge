/** Small permissive test double for the WebXR subset consumed by three r187. */
export async function installFakeWebXr(page, options = {}) {
  await page.addInitScript((initial) => {
    try {
      localStorage.setItem('stageforge.render.v1', JSON.stringify({ webxrAudience: true }));
    } catch { /* origin is not available on about:blank */ }

    const state = {
      supported: initial.supported !== false,
      denyNext: Boolean(initial.denyNext),
      deferNext: false,
      requests: [],
      sessions: [],
      pending: [],
      activeSession: null,
      scaleFactor: null,
      foveation: null,
      referenceSpaces: [],
      failReferenceSpaceNext: false,
    };

    const perspective = (near = 0.1, far = 220) => {
      const f = 1;
      const nf = 1 / (near - far);
      return new Float32Array([
        f, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) * nf, -1,
        0, 0, 2 * far * near * nf, 0,
      ]);
    };
    const eyeView = (eye, x) => ({
      eye,
      projectionMatrix: perspective(),
      transform: {
        matrix: new Float32Array([
          1, 0, 0, 0,
          0, 1, 0, 0,
          0, 0, 1, 0,
          x, 1.62, 0, 1,
        ]),
      },
    });

    class FakeSession extends EventTarget {
      constructor() {
        super();
        this.visibilityState = 'visible';
        this.environmentBlendMode = 'opaque';
        this.inputSources = [];
        this.enabledFeatures = ['local-floor'];
        this.renderState = { baseLayer: null, depthNear: 0.1, depthFar: 220 };
        this.ended = false;
        this.rafIds = new Set();
        this.listenerBalance = 0;
      }
      addEventListener(type, listener, opts) {
        super.addEventListener(type, listener, opts);
        this.listenerBalance++;
      }
      removeEventListener(type, listener, opts) {
        super.removeEventListener(type, listener, opts);
        this.listenerBalance--;
      }
      updateRenderState(patch) {
        this.renderState = { ...this.renderState, ...patch };
      }
      requestReferenceSpace(type) {
        state.referenceSpaces.push(type);
        if (state.failReferenceSpaceNext) {
          state.failReferenceSpaceNext = false;
          return Promise.reject(new Error('Fake reference-space failure'));
        }
        return Promise.resolve({ type });
      }
      requestAnimationFrame(callback) {
        const id = window.requestAnimationFrame((time) => {
          this.rafIds.delete(id);
          if (this.ended) return;
          const frame = {
            session: this,
            getViewerPose: () => ({ views: [eyeView('left', -0.032), eyeView('right', 0.032)] }),
          };
          callback(time, frame);
        });
        this.rafIds.add(id);
        return id;
      }
      cancelAnimationFrame(id) {
        this.rafIds.delete(id);
        window.cancelAnimationFrame(id);
      }
      end() {
        if (this.ended) return Promise.resolve();
        this.ended = true;
        for (const id of this.rafIds) window.cancelAnimationFrame(id);
        this.rafIds.clear();
        this.dispatchEvent(new Event('end'));
        if (state.activeSession === this) state.activeSession = null;
        return Promise.resolve();
      }
      setVisibility(value) {
        this.visibilityState = value;
        this.dispatchEvent(new Event('visibilitychange'));
      }
    }

    class FakeWebGLLayer {
      constructor(_session, _gl, init = {}) {
        this.framebufferWidth = 1024;
        this.framebufferHeight = 512;
        this.framebuffer = null;
        this.ignoreDepthValues = false;
        this.fixedFoveation = 0;
        state.scaleFactor = init.framebufferScaleFactor ?? 1;
      }
      getViewport(view) {
        return { x: view.eye === 'left' ? 0 : 512, y: 0, width: 512, height: 512 };
      }
    }
    Object.defineProperty(FakeWebGLLayer.prototype, 'fixedFoveation', {
      get() { return this._fixedFoveation ?? 0; },
      set(value) { this._fixedFoveation = value; state.foveation = value; },
      configurable: true,
    });
    globalThis.XRWebGLLayer = FakeWebGLLayer;
    // Force three's compatible XRWebGLLayer path; Chromium's native binding rejects this scoped fake session.
    Object.defineProperty(globalThis, 'XRWebGLBinding', { value: undefined, configurable: true });

    const createSession = () => {
      const session = new FakeSession();
      state.sessions.push(session);
      state.activeSession = session;
      return session;
    };
    const xr = {
      isSessionSupported: async (mode) => state.supported && mode === 'immersive-vr',
      requestSession: (mode, init) => {
        state.requests.push({ mode, requiredFeatures: [...(init?.requiredFeatures ?? [])] });
        if (state.denyNext) {
          state.denyNext = false;
          return Promise.reject(new DOMException('Denied by test', 'NotAllowedError'));
        }
        if (state.deferNext) {
          state.deferNext = false;
          return new Promise((resolve, reject) => state.pending.push({ resolve, reject }));
        }
        return Promise.resolve(createSession());
      },
    };
    Object.defineProperty(navigator, 'xr', { value: xr, configurable: true });
    const oldGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, attrs) {
      const context = oldGetContext.call(this, kind, attrs);
      if (context && (kind === 'webgl' || kind === 'webgl2')) {
        Object.defineProperty(context, 'makeXRCompatible', {
          value: async () => {},
          configurable: true,
        });
      }
      return context;
    };

    globalThis.__fakeWebXr = {
      state,
      denyNext() { state.denyNext = true; },
      deferNext() { state.deferNext = true; },
      resolvePending() {
        const pending = state.pending.shift();
        if (pending) pending.resolve(createSession());
      },
      rejectPending(name = 'AbortError') {
        const pending = state.pending.shift();
        if (pending) pending.reject(new DOMException('Canceled by test', name));
      },
      failReferenceSpaceNext() { state.failReferenceSpaceNext = true; },
      systemExit() { return state.activeSession?.end(); },
      setVisibility(value) { state.activeSession?.setVisibility(value); },
      snapshot() {
        return {
          supported: state.supported,
          requests: state.requests.map((request) => ({ ...request })),
          sessions: state.sessions.length,
          pending: state.pending.length,
          active: Boolean(state.activeSession),
          scaleFactor: state.scaleFactor,
          foveation: state.foveation,
          referenceSpaces: [...state.referenceSpaces],
          listenerBalances: state.sessions.map((session) => session.listenerBalance),
          rafCounts: state.sessions.map((session) => session.rafIds.size),
        };
      },
    };
  }, options);
}
