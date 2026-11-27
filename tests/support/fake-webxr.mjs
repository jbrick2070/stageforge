/** Small permissive test double for the WebXR subset consumed by three r187. */
export async function installFakeWebXr(page, options = {}) {
  await page.addInitScript((initial) => {
    try {
      localStorage.setItem('stageforge.render.v1', JSON.stringify({ webxrAudience: true }));
    } catch { /* origin is not available on about:blank */ }

    let reducedMotion = Boolean(initial.reducedMotion);
    const reducedMotionListeners = new Set();
    const nativeMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      if (query !== '(prefers-reduced-motion: reduce)') return nativeMatchMedia(query);
      return {
        media: query,
        get matches() { return reducedMotion; },
        onchange: null,
        addEventListener(type, listener) { if (type === 'change') reducedMotionListeners.add(listener); },
        removeEventListener(type, listener) { if (type === 'change') reducedMotionListeners.delete(listener); },
        addListener(listener) { reducedMotionListeners.add(listener); },
        removeListener(listener) { reducedMotionListeners.delete(listener); },
        dispatchEvent() { return true; },
      };
    };

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
      reducedMotion,
    };


    // Opt-in readback of Three's actual emulated XR base layer. Never render an extra frame.
    const directEyes = initial.directEyeCapture === true;
    const dedicatedLayer = directEyes && initial.dedicatedXrFramebuffer === true;
    const layerContexts = new WeakMap();
    const layerReleases = new WeakMap();

    // Single-sample emulator-owned color/depth storage. Keep Three's cached bindings valid by
    // restoring the separate read/draw bindings and renderbuffer before returning its XR layer.
    function allocateLayerFramebuffer(session, gl, width, height, init) {
      const draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
      const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
      const oldRenderbuffer = gl.getParameter(gl.RENDERBUFFER_BINDING);
      const framebuffer = gl.createFramebuffer();
      if (!framebuffer) throw new Error('Cannot allocate the emulated XR framebuffer.');
      const storage = [];
      const release = () => {
        if (!gl.isContextLost()) {
          gl.deleteFramebuffer(framebuffer);
          for (const buffer of storage) gl.deleteRenderbuffer(buffer);
        }
      };
      function attach(format, attachment) {
        const buffer = gl.createRenderbuffer();
        if (!buffer) throw new Error('Cannot allocate emulated XR attachment.');
        storage.push(buffer);
        gl.bindRenderbuffer(gl.RENDERBUFFER, buffer);
        gl.renderbufferStorage(gl.RENDERBUFFER, format, width, height);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, attachment, gl.RENDERBUFFER, buffer);
      }
      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        attach(gl.RGBA8, gl.COLOR_ATTACHMENT0);
        if (init.depth && init.stencil) attach(gl.DEPTH24_STENCIL8, gl.DEPTH_STENCIL_ATTACHMENT);
        else if (init.depth) attach(gl.DEPTH_COMPONENT16, gl.DEPTH_ATTACHMENT);
        else if (init.stencil) attach(gl.STENCIL_INDEX8, gl.STENCIL_ATTACHMENT);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error('Incomplete emulated XR framebuffer.');
        }
        const releases = layerReleases.get(session) ?? [];
        releases.push(release);
        layerReleases.set(session, releases);
        return framebuffer;
      } catch (error) {
        release();
        throw error;
      } finally {
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
        gl.bindRenderbuffer(gl.RENDERBUFFER, oldRenderbuffer);
      }
    }
    let pendingEyes = null;
    let collectingEyes = null;

    function copyTransform(transform) {
      return { position: { ...transform.position }, orientation: { ...transform.orientation }, matrix: Array.from(transform.matrix) };
    }

    function pngFromBottomLeft(bytes, width, height) {
      // WebGL rows start at the bottom, whereas ImageData and PNG rows start at the top.
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Missing 2D context for eye PNG encoding.');
      const image = ctx.createImageData(width, height);
      const stride = width * 4;
      for (let y = 0; y < height; y++) {
        const start = (height - y - 1) * stride;
        image.data.set(bytes.subarray(start, start + stride), y * stride);
      }
      ctx.putImageData(image, 0, 0);
      const png = canvas.toDataURL('image/png');
      if (!png.startsWith('data:image/png;base64,')) throw new Error('Eye framebuffer could not be encoded.');
      return png;
    }

    function captureNextEyePair({ timeoutMs = 4000, expectedSubmission = 'scene' } = {}) {
      if (expectedSubmission !== 'scene' && expectedSubmission !== 'blackout-clear') {
        return Promise.reject(new Error('Unknown XR submission type.'));
      }
      if (pendingEyes) return Promise.reject(new Error('An eye pair is already pending.'));
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) {
        return Promise.reject(new RangeError('Eye capture timeout must be 1–10000 ms.'));
      }
      const session = state.activeSession;
      const layer = session?.renderState.baseLayer;
      const gl = layerContexts.get(layer);
      const xr = window.stageforgeProbe?.webXr();
      if (!session || session.ended || session.ending || session.visibilityState !== 'visible' ||
          !gl || typeof gl.readBuffer !== 'function' || gl.isContextLost() || !gl.canvas.isConnected || gl.canvas.ownerDocument !== document ||
          !xr?.active || !xr.directRendering || xr.phase !== 'active') {
        return Promise.reject(new Error('Eye capture requires a visible, active direct XR session and its live canvas.'));
      }
      return new Promise((resolve, reject) => {
        const request = { session, layer, gl, expectedSubmission, encoding: false, deadline: performance.now() + timeoutMs };
        const finish = (error, pair) => {
          if (pendingEyes !== request) return;
          pendingEyes = null;
          clearTimeout(timer);
          session.removeEventListener('end', onEnd);
          session.removeEventListener('visibilitychange', onVisibility);
          gl.canvas.removeEventListener('webglcontextlost', onLoss);
          if (error) reject(error);
          else resolve(pair);
        };
        const onEnd = () => finish(new Error('XR session ended before eye capture completed.'));
        const onVisibility = () => {
          if (session.visibilityState !== 'visible') finish(new Error('XR visibility changed before eye capture completed.'));
        };
        const onLoss = () => finish(new Error('WebGL context lost before eye capture completed.'));
        request.finish = finish;
        pendingEyes = request;
        session.addEventListener('end', onEnd);
        session.addEventListener('visibilitychange', onVisibility);
        gl.canvas.addEventListener('webglcontextlost', onLoss);
        const timer = setTimeout(() => finish(new Error('Timed out waiting for a rendered stereo eye pair.')), timeoutMs);
      });
    }

    // Observe only the armed blackout callback. This creates no GL resource and does not issue a clear.
    function observeBlackoutClear(frame) {
      const { gl, layer } = frame.request;
      const original = gl.clear;
      const descriptor = Object.getOwnPropertyDescriptor(gl, 'clear');
      Object.defineProperty(gl, 'clear', { configurable: true, writable: true, value(mask) {
        if (this === gl && (mask & gl.COLOR_BUFFER_BIT)) {
          const color = Array.from(gl.getParameter(gl.COLOR_CLEAR_VALUE));
          const scissor = Array.from(gl.getParameter(gl.SCISSOR_BOX));
          const coversAtlas = !gl.isEnabled(gl.SCISSOR_TEST) ||
            (scissor[0] <= 0 && scissor[1] <= 0 && scissor[0] + scissor[2] >= layer.framebufferWidth &&
             scissor[1] + scissor[3] >= layer.framebufferHeight);
          if (coversAtlas && Array.from(gl.getParameter(gl.COLOR_WRITEMASK)).every(Boolean) &&
              gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) === layer.framebuffer &&
              color[0] === 0 && color[1] === 0 && color[2] === 0 && color[3] === 1) frame.blackClears++;
        }
        return Reflect.apply(original, this, arguments);
      } });
      return () => {
        if (descriptor) Object.defineProperty(gl, 'clear', descriptor);
        else delete gl.clear;
      };
    }

    function captureRenderedEyes(frame, time) {
      const { request, viewports, framesBefore } = frame;
      if (pendingEyes !== request) return;
      const { session, gl, layer } = request;
      const xr = window.stageforgeProbe.webXr();
      if (session !== state.activeSession || session.renderState.baseLayer !== layer || session.ended || session.ending ||
          session.visibilityState !== 'visible' || gl.isContextLost() || !xr.active || !xr.directRendering) {
        throw new Error('XR capture lost its original visible session or rendering layer.');
      }
      // An unrelated XR RAF or pending teleport can occur before the desired rendered frame.
      if (xr.frames === framesBefore || xr.audience?.blink !== null) return;
      if (xr.frames !== framesBefore + 1 || xr.lastViews !== 2 || viewports.length !== 2 ||
          !xr.rendererXrEnabled || xr.loopOwner !== 'webxr-setAnimationLoop') {
        throw new Error('The callback did not advance a complete two-view XR frame.');
      }
      const blackout = request.expectedSubmission === 'blackout-clear';
      if (blackout) {
        if (!frame.blackClears || xr.lastCalls !== 0 || xr.lastTriangles !== 0 || xr.lastLayerTargetPreserved !== true) {
          throw new Error('Expected a witnessed full-layer opaque black clear, zero scene submissions, and the original Three XR target.');
        }
      } else if (xr.lastCalls <= 0 || xr.lastTriangles <= 0) {
        throw new Error('The callback did not submit a forward stereo scene.');
      }
      const left = viewports.find(item => item.view.eye === 'left');
      const right = viewports.find(item => item.view.eye === 'right');
      if (!left || !right || !left.pose || left.pose !== right.pose) throw new Error('Expected one viewport per eye from the same XRViewerPose.');
      const w = layer.framebufferWidth, h = layer.framebufferHeight;
      const isViewport = (v, x) => v.x === x && v.y === 0 && v.width === w / 2 && v.height === h;
      if (!isViewport(left.rect, 0) || !isViewport(right.rect, w / 2) ||
          (dedicatedLayer ? !gl.isFramebuffer(layer.framebuffer)
            : layer.framebuffer !== null || w !== gl.drawingBufferWidth || h !== gl.drawingBufferHeight) ||
          gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) !== layer.framebuffer ||
          gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) !== layer.framebuffer ||
          gl.getParameter(gl.READ_BUFFER) !== (dedicatedLayer ? gl.COLOR_ATTACHMENT0 : gl.BACK) ||
          gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error('The eye viewports do not map to the live emulated XR back buffer.');
      }
      if (gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) !== null || gl.getParameter(gl.PACK_ROW_LENGTH) !== 0 ||
          gl.getParameter(gl.PACK_SKIP_ROWS) !== 0 || gl.getParameter(gl.PACK_SKIP_PIXELS) !== 0 ||
          ((w / 2) * 4) % gl.getParameter(gl.PACK_ALIGNMENT) !== 0) {
        throw new Error('Unexpected pixel packing state for the XR frame.');
      }
      const priorError = gl.getError();
      if (priorError !== gl.NO_ERROR) throw new Error('GL error before eye readback: ' + priorError);
      gl.flush();
      const readEye = ({ view, rect }) => {
        const bytes = new Uint8Array(rect.width * rect.height * 4);
        gl.readPixels(rect.x, rect.y, rect.width, rect.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
        const error = gl.getError();
        if (error !== gl.NO_ERROR || gl.isContextLost()) throw new Error('Failed to read ' + view.eye + ' eye: ' + error);
        const pose = copyTransform(view.transform);
        let nonOpaqueBlackPixels = 0, litPixels = 0;
        if (blackout || dedicatedLayer) for (let i = 0; i < bytes.length; i += 4) {
          const rgbIsLit = bytes[i] !== 0 || bytes[i+1] !== 0 || bytes[i+2] !== 0;
          if (rgbIsLit || bytes[i+3] !== 255) nonOpaqueBlackPixels++;
          if (dedicatedLayer && rgbIsLit) litPixels++;
        }
        return { bytes, result: { eye: view.eye, viewport: rect, position: pose.position, orientation: pose.orientation,
          ...(blackout || dedicatedLayer ? { nonOpaqueBlackPixels, pixels: bytes.length / 4 } : {}),
          ...(dedicatedLayer ? { litPixels } : {}),
          viewToReferenceMatrix: pose.matrix, projectionMatrix: Array.from(view.projectionMatrix) } };
      };
      // Complete both synchronous reads before returning to window RAF / browser compositing.
      const leftRead = readEye(left);
      const rightRead = readEye(right);
      const result = {
        frame: xr.frames, session: state.sessions.indexOf(session) + 1, timeMs: time,
        submission: request.expectedSubmission, lastLayerTargetPreserved: xr.lastLayerTargetPreserved,
        ...(dedicatedLayer ? { framebufferKind: 'emulated-single-sample-fbo' } : {}),
        ...(blackout ? { witnessedBlackClears: frame.blackClears } : {}),
        atlas: { width: w, height: h, viewportOrigin: 'bottom-left', pngOrigin: 'top-left' },
        profile: xr.audience.currentQuality, viewpoint: xr.audience.currentViewpoint, eyeMode: xr.audience.eyeMode,
        scaleFactor: state.scaleFactor, requestedFoveation: state.foveation,
        head: copyTransform(left.pose.transform), desiredHeadPose: xr.audience.desiredHeadPose,
        counters: { views: xr.lastViews, calls: xr.lastCalls, triangles: xr.lastTriangles,
          rendererTextures: xr.memory.textures, ownedTextures: xr.audience.ownedTextures },
      };
      request.encoding = true;
      queueMicrotask(() => {
        if (pendingEyes !== request) return;
        try {
          for (const { bytes, result: eye } of [leftRead, rightRead]) {
            eye.png = pngFromBottomLeft(bytes, eye.viewport.width, eye.viewport.height);
            result[eye.eye] = eye;
          }
          if (performance.now() > request.deadline) throw new Error('Eye pair exceeded the capture timeout.');
          if (session.ended || session.ending || session.visibilityState !== 'visible' || gl.isContextLost() ||
              state.activeSession !== session || session.renderState.baseLayer !== layer) throw new Error('Eye capture was interrupted.');
          request.finish(null, result);
        } catch (error) { request.finish(error); }
      });
    }

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
          const request = pendingEyes;
          const capture = request && !request.encoding && request.session === this
            ? { request, poses: new WeakMap(), viewports: [], blackClears: 0, framesBefore: window.stageforgeProbe?.webXr().frames }
            : null;
          const frame = {
            session: this,
            getViewerPose: (referenceSpace) => {
              const baseHead = { position: { x: 0, y: 1.62, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } };
              const derived = referenceSpace?.offset ? compose(inverse(referenceSpace.offset), baseHead) : baseHead;
              const pose = {
                transform: new FakeRigidTransform(derived.position, derived.orientation),
                views: [eyeView('left', -0.032, referenceSpace), eyeView('right', 0.032, referenceSpace)],
              };
              if (capture) for (const view of pose.views) capture.poses.set(view, pose);
              return pose;
            },
            getPose: (space, referenceSpace) => {
              const base = space?.pose ?? { position: { x: 0, y: 1.3, z: -0.35 }, orientation: { x: 0, y: 0, z: 0, w: 1 } };
              const derived = referenceSpace?.offset ? compose(inverse(referenceSpace.offset), base) : base;
              return { transform: new FakeRigidTransform(derived.position, derived.orientation) };
            },
          };
          if (!capture) {
            callback(time, frame);
            return;
          }
          let undoClearObservation;
          if (request.expectedSubmission === 'blackout-clear') {
            try { undoClearObservation = observeBlackoutClear(capture); }
            catch (error) { request.finish(error); callback(time, frame); return; }
          }
          collectingEyes = capture;
          try {
            callback(time, frame);
          } catch (error) {
            request.finish(error);
            throw error;
          } finally {
            collectingEyes = null;
            undoClearObservation?.();
          }
          try {
            captureRenderedEyes(capture, time);
          } catch (error) {
            request.finish(error);
          }
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
        // Let Three restore the desktop target before releasing the fake layer's attachments.
        try {
          this.dispatchEvent(new Event('end'));
        } finally {
          for (const release of layerReleases.get(this) ?? []) release();
          layerReleases.delete(this);
          if (state.activeSession === this) state.activeSession = null;
        }
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
          getPose: (space, activeReferenceSpace) => {
            const base = space.pose;
            const derived = activeReferenceSpace?.offset ? compose(inverse(activeReferenceSpace.offset), base) : base;
            return { transform: new FakeRigidTransform(derived.position, derived.orientation) };
          },
          getViewerPose: () => ({ transform: new FakeRigidTransform({ x: 0, y: 1.62, z: 0 }), views: [eyeView('left', -0.032, referenceSpace), eyeView('right', 0.032, referenceSpace)] }),
        };
        const event = new Event(type);
        Object.defineProperties(event, { inputSource: { value: inputSource }, frame: { value: frame } });
        state.inputEvents.push({ type, index });
        this.dispatchEvent(event);
      }
    }

    class FakeWebGLLayer {
      constructor(session, gl, init = {}) {
        const dimension = directEyes ? Math.round(512 * (init.framebufferScaleFactor ?? 1)) : 512;
        if (directEyes) layerContexts.set(this, gl);
        this.framebufferWidth = dimension * 2;
        this.framebufferHeight = dimension;
        this.framebuffer = dedicatedLayer
          ? allocateLayerFramebuffer(session, gl, this.framebufferWidth, this.framebufferHeight, init)
          : null;
        this.ignoreDepthValues = false;
        this.fixedFoveation = 0;
        state.scaleFactor = init.framebufferScaleFactor ?? 1;
      }
      getViewport(view) {
        const width = this.framebufferWidth / 2;
        const rect = { x: view.eye === 'left' ? 0 : width, y: 0, width, height: this.framebufferHeight };
        if (collectingEyes?.request.layer === this) {
          collectingEyes.viewports.push({ view, rect: { ...rect }, pose: collectingEyes.poses.get(view) });
        }
        return rect;
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
      ...(directEyes ? { captureNextEyePair } : {}),
      ...(dedicatedLayer ? {
        layerIsLive(session) {
          const layer = session?.renderState.baseLayer;
          return Boolean(layer && layerContexts.get(layer)?.isFramebuffer(layer.framebuffer));
        },
        observeControllerPress(index = 0) {
          // The Playwright caller dispatches this input between XR callbacks. Observe actual GL
          // calls made during the input; never bind a target, inject a clear, or imitate a frame.
          const session = state.activeSession;
          const layer = session.renderState.baseLayer;
          const gl = layerContexts.get(layer);
          const boundToLayer = () => gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) === layer.framebuffer;
          const before = boundToLayer();
          const clears = [];
          const original = gl.clear, descriptor = Object.getOwnPropertyDescriptor(gl, 'clear');
          Object.defineProperty(gl, 'clear', {configurable: true, writable: true, value(mask) {
            if (this === gl && (mask & gl.COLOR_BUFFER_BIT)) {
              const target = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
              clears.push(target === layer.framebuffer ? 'xr-layer' : target === null ? 'desktop' : 'other');
            }
            return Reflect.apply(original, this, arguments);
          }});
          try {
            session.dispatchInput('selectstart', index);
            session.dispatchInput('selectend', index);
            return { before, after: boundToLayer(), clears };
          } finally {
            if (descriptor) Object.defineProperty(gl, 'clear', descriptor);
            else delete gl.clear;
          }
        },
      } : {}),
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
      aimControllerAtMenu(menuPose, pixelX = 750, pixelY = 520, index = 0) {
        const session = state.activeSession;
        if (!session) return;
        const source = session.inputSources[index] ?? session.connectController(index);
        const local = {
          position: {
            x: (pixelX / 1024 - 0.5) * 1.25,
            y: (0.5 - pixelY / 1024) * 1.25,
            z: 0.8,
          },
          orientation: { x: 0, y: 0, z: 0, w: 1 },
        };
        const desired = compose(menuPose, local);
        const offset = state.offsetTransforms.at(-1) ?? {
          position: { x: 0, y: 0, z: 0 },
          orientation: { x: 0, y: 0, z: 0, w: 1 },
        };
        source.targetRaySpace.pose = compose(offset, desired);
      },
      setReducedMotion(value) {
        reducedMotion = Boolean(value);
        state.reducedMotion = reducedMotion;
        const event = new Event('change');
        Object.defineProperties(event, {
          matches: { value: reducedMotion },
          media: { value: '(prefers-reduced-motion: reduce)' },
        });
        for (const listener of [...reducedMotionListeners]) listener.call(null, event);
      },
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
          reducedMotion: state.reducedMotion,
          listenerBalances: state.sessions.map((session) => session.listenerBalance),
          rafCounts: state.sessions.map((session) => session.rafIds.size),
        };
      },
    };
  }, options);
}
