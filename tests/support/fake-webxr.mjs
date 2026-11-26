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
      deferEndNext: false,
      rejectEndNext: false,
      requests: [],
      sessions: [],
      pending: [],
      pendingEnds: [],
      activeSession: null,
      scaleFactor: null,
      foveation: null,
      referenceSpaces: [],
      failReferenceSpaceNext: false,
      offsetTransforms: [],
      inputEvents: [],
    };

    const quatMultiply = (a, b) => ({
      x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
      w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    });
    const quatInverse = (q) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
    const rotate = (q, p) => {
      const out = quatMultiply(quatMultiply(q, { ...p, w: 0 }), quatInverse(q));
      return { x: out.x, y: out.y, z: out.z };
    };
    const compose = (a, b) => {
      const p = rotate(a.orientation, b.position);
      return {
        position: { x: a.position.x + p.x, y: a.position.y + p.y, z: a.position.z + p.z },
        orientation: quatMultiply(a.orientation, b.orientation),
      };
    };
    const inverse = (pose) => {
      const orientation = quatInverse(pose.orientation);
      return {
        position: rotate(orientation, { x: -pose.position.x, y: -pose.position.y, z: -pose.position.z }),
        orientation,
      };
    };
    const matrixFor = (pose) => {
      const { x, y, z, w } = pose.orientation;
      const x2 = x + x, y2 = y + y, z2 = z + z;
      const xx = x * x2, xy = x * y2, xz = x * z2;
      const yy = y * y2, yz = y * z2, zz = z * z2;
      const wx = w * x2, wy = w * y2, wz = w * z2;
      return new Float32Array([
        1 - (yy + zz), xy + wz, xz - wy, 0,
        xy - wz, 1 - (xx + zz), yz + wx, 0,
        xz + wy, yz - wx, 1 - (xx + yy), 0,
        pose.position.x, pose.position.y, pose.position.z, 1,
      ]);
    };
    class FakeRigidTransform {
      constructor(position = {}, orientation = {}) {
        this.position = { x: position.x ?? 0, y: position.y ?? 0, z: position.z ?? 0, w: 1 };
        this.orientation = { x: orientation.x ?? 0, y: orientation.y ?? 0, z: orientation.z ?? 0, w: orientation.w ?? 1 };
        this.matrix = matrixFor(this);
      }
      get inverse() {
        const pose = inverse(this);
        return new FakeRigidTransform(pose.position, pose.orientation);
      }
    }
    globalThis.XRRigidTransform = FakeRigidTransform;

    class FakeReferenceSpace extends EventTarget {
      constructor(type, offset = new FakeRigidTransform()) {
        super();
        this.type = type;
        this.offset = offset;
      }
      getOffsetReferenceSpace(originOffset) {
        const combined = compose(this.offset, originOffset);
        const next = new FakeReferenceSpace(this.type, new FakeRigidTransform(combined.position, combined.orientation));
        state.offsetTransforms.push({
          position: { ...next.offset.position },
          orientation: { ...next.offset.orientation },
        });
        return next;
      }
    }

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
    const eyeView = (eye, x, referenceSpace) => {
      const base = { position: { x, y: 1.62, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } };
      const derived = referenceSpace?.offset ? compose(inverse(referenceSpace.offset), base) : base;
      return ({
      eye,
      projectionMatrix: perspective(),
      transform: new FakeRigidTransform(derived.position, derived.orientation),
    });
    };

    class FakeSession extends EventTarget {
      constructor() {
        super();
        this.visibilityState = 'visible';
        this.environmentBlendMode = 'opaque';
        this.inputSources = [];
        this.enabledFeatures = ['local-floor'];
        this.renderState = { baseLayer: null, depthNear: 0.1, depthFar: 220 };
        this.ended = false;
        this.ending = false;
        this.endPromise = null;
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
        return Promise.resolve(new FakeReferenceSpace(type));
      }
      requestAnimationFrame(callback) {
        const id = window.requestAnimationFrame((time) => {
          this.rafIds.delete(id);
          if (this.ended) return;
          const frame = {
            session: this,
            getViewerPose: (referenceSpace) => {
              const baseHead = { position: { x: 0, y: 1.62, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } };
              const derived = referenceSpace?.offset ? compose(inverse(referenceSpace.offset), baseHead) : baseHead;
              return {
                transform: new FakeRigidTransform(derived.position, derived.orientation),
                views: [eyeView('left', -0.032, referenceSpace), eyeView('right', 0.032, referenceSpace)],
              };
            },
            getPose: (space, referenceSpace) => {
              const base = space?.pose ?? { position: { x: 0, y: 1.3, z: -0.35 }, orientation: { x: 0, y: 0, z: 0, w: 1 } };
              const derived = referenceSpace?.offset ? compose(inverse(referenceSpace.offset), base) : base;
              return { transform: new FakeRigidTransform(derived.position, derived.orientation) };
            },
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
      finishEnd() {
        if (this.ended) return;
        this.ended = true;
        this.ending = false;
        for (const id of this.rafIds) window.cancelAnimationFrame(id);
        this.rafIds.clear();
        this.dispatchEvent(new Event('end'));
        if (state.activeSession === this) state.activeSession = null;
      }
      end() {
        if (this.ended) return Promise.resolve();
        if (this.ending && this.endPromise) return this.endPromise;
        if (state.rejectEndNext) {
          state.rejectEndNext = false;
          return Promise.reject(new DOMException('End rejected by test', 'OperationError'));
        }
        if (state.deferEndNext) {
          state.deferEndNext = false;
          this.ending = true;
          this.endPromise = new Promise((resolve) => state.pendingEnds.push({
            session: this,
            resolve: () => {
              this.finishEnd();
              resolve();
            },
          }));
          return this.endPromise;
        }
        this.finishEnd();
        return Promise.resolve();
      }
      setVisibility(value) {
        this.visibilityState = value;
        this.dispatchEvent(new Event('visibilitychange'));
      }
      connectController(index = 0) {
        const source = {
          handedness: index === 0 ? 'right' : 'left',
          targetRayMode: 'tracked-pointer',
          targetRaySpace: { pose: { position: { x: index ? -0.25 : 0.25, y: 1.3, z: -0.35 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } },
          gripSpace: null,
          profiles: ['generic-trigger'],
          gamepad: null,
          hand: null,
        };
        this.inputSources.push(source);
        const event = new Event('inputsourceschange');
        Object.defineProperties(event, { added: { value: [source] }, removed: { value: [] } });
        this.dispatchEvent(event);
        return source;
      }
      dispatchInput(type, index = 0) {
        const inputSource = this.inputSources[index] ?? this.connectController(index);
        const referenceSpace = new FakeReferenceSpace('local-floor');
        const frame = {
          session: this,
          getPose: (space) => ({ transform: new FakeRigidTransform(space.pose.position, space.pose.orientation) }),
          getViewerPose: () => ({ transform: new FakeRigidTransform({ x: 0, y: 1.62, z: 0 }), views: [eyeView('left', -0.032, referenceSpace), eyeView('right', 0.032, referenceSpace)] }),
        };
        const event = new Event(type);
        Object.defineProperties(event, { inputSource: { value: inputSource }, frame: { value: frame } });
        state.inputEvents.push({ type, index });
        this.dispatchEvent(event);
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
      deferEndNext() { state.deferEndNext = true; },
      rejectEndNext() { state.rejectEndNext = true; },
      resolvePendingEnd() { state.pendingEnds.shift()?.resolve(); },
      systemExit() { return state.activeSession?.end(); },
      setVisibility(value) { state.activeSession?.setVisibility(value); },
      connectController(index = 0) { return state.activeSession?.connectController(index); },
      dispatchInput(type, index = 0) { state.activeSession?.dispatchInput(type, index); },
      snapshot() {
        return {
          supported: state.supported,
          requests: state.requests.map((request) => ({ ...request })),
          sessions: state.sessions.length,
          pending: state.pending.length,
          pendingEnds: state.pendingEnds.length,
          active: Boolean(state.activeSession),
          scaleFactor: state.scaleFactor,
          foveation: state.foveation,
          referenceSpaces: [...state.referenceSpaces],
          offsetTransforms: state.offsetTransforms.map((value) => ({ position: { ...value.position }, orientation: { ...value.orientation } })),
          inputEvents: state.inputEvents.map((value) => ({ ...value })),
          listenerBalances: state.sessions.map((session) => session.listenerBalance),
          rafCounts: state.sessions.map((session) => session.rafIds.size),
        };
      },
    };
  }, options);
}
