/**
 * Sprint 15 graphics measurement probe:
 * - Deterministic percentile aggregation
 * - Asynchronous WebGL2 EXT_disjoint_timer_query_webgl2 ring buffer (never blocks or calls gl.finish)
 * - Zero-cost-when-idle per-frame CPU phase & upload profiler
 * - Pure WCAG relative-luminance & saturated-red rolling 1-second flash evaluator
 */

export interface PercentileSummary {
  count: number;
  mean: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}

export function computePercentiles(samples: ArrayLike<number>, length = samples.length): PercentileSummary {
  const n = Math.max(0, Math.min(length, samples.length));
  if (n === 0) {
    return { count: 0, mean: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0 };
  }
  const sorted = new Float64Array(n);
  let sum = 0;
  let valid = 0;
  for (let i = 0; i < n; i++) {
    const v = samples[i];
    if (Number.isFinite(v)) {
      sorted[valid++] = v;
      sum += v;
    }
  }
  if (valid === 0) {
    return { count: 0, mean: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0 };
  }
  const view = sorted.subarray(0, valid);
  view.sort();
  const at = (q: number) => {
    if (valid === 1) return view[0];
    const idx = Math.min(valid - 1, Math.max(0, Math.ceil(q * valid) - 1));
    return view[idx];
  };
  return {
    count: valid,
    mean: sum / valid,
    min: view[0],
    max: view[valid - 1],
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
  };
}

export type GpuTimerStatus = 'ok' | 'unsupported' | 'lost';

interface DisjointTimerQueryExt {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

const GPU_QUERY_RING_SIZE = 8;

/**
 * Non-blocking WebGL2 GPU timer query ring using EXT_disjoint_timer_query_webgl2.
 * Rejects disjoint results, skips frames when the ring is full, and releases all queries on dispose or context loss.
 */
export class GpuTimerRing {
  private gl: WebGL2RenderingContext | null = null;
  private ext: DisjointTimerQueryExt | null = null;
  private status: GpuTimerStatus = 'unsupported';
  private pending: WebGLQuery[] = [];
  private active = false;
  private disposed = false;
  public discarded = 0;
  public skipped = 0;

  constructor(gl: WebGLRenderingContext | WebGL2RenderingContext | null | undefined) {
    if (!gl || typeof (gl as WebGL2RenderingContext).createQuery !== 'function') {
      this.status = 'unsupported';
      return;
    }
    const gl2 = gl as WebGL2RenderingContext;
    const ext = gl2.getExtension('EXT_disjoint_timer_query_webgl2') as DisjointTimerQueryExt | null;
    if (!ext) {
      this.status = 'unsupported';
      return;
    }
    this.gl = gl2;
    this.ext = ext;
    this.status = 'ok';
  }

  public getStatus(): GpuTimerStatus {
    return this.status;
  }

  public pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Poll completed earlier-frame queries without blocking. Invokes `onSample(durationMs)` for valid results.
   */
  public poll(onSample: (ms: number) => void): void {
    const gl = this.gl;
    const ext = this.ext;
    if (!gl || !ext || this.disposed || this.status !== 'ok') return;
    if (typeof gl.isContextLost === 'function' && gl.isContextLost()) {
      this.onContextLost();
      return;
    }

    const disjoint = Boolean(gl.getParameter(ext.GPU_DISJOINT_EXT));
    if (disjoint) {
      for (const q of this.pending) {
        gl.deleteQuery(q);
        this.discarded++;
      }
      this.pending.length = 0;
      return;
    }

    while (this.pending.length > 0) {
      const q = this.pending[0];
      const available = Boolean(gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE));
      if (!available) break;
      this.pending.shift();
      const ns = Number(gl.getQueryParameter(q, gl.QUERY_RESULT));
      gl.deleteQuery(q);
      // Re-check disjoint after reading the result per EXT_disjoint_timer_query_webgl2 spec.
      if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
        this.discarded++;
        for (const rem of this.pending) {
          gl.deleteQuery(rem);
          this.discarded++;
        }
        this.pending.length = 0;
        break;
      }
      if (Number.isFinite(ns) && ns >= 0) {
        onSample(ns / 1e6);
      } else {
        this.discarded++;
      }
    }
  }

  /** Begin timing the GPU work of the current frame. Returns true if a query was started. */
  public beginFrame(): boolean {
    const gl = this.gl;
    const ext = this.ext;
    if (!gl || !ext || this.disposed || this.status !== 'ok' || this.active) return false;
    if (typeof gl.isContextLost === 'function' && gl.isContextLost()) {
      this.onContextLost();
      return false;
    }
    if (this.pending.length >= GPU_QUERY_RING_SIZE) {
      this.skipped++;
      return false;
    }
    const query = gl.createQuery();
    if (!query) {
      this.skipped++;
      return false;
    }
    gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    this.pending.push(query);
    this.active = true;
    return true;
  }

  /** End timing the current frame. Safe no-op if beginFrame did not start a query. */
  public endFrame(): void {
    const gl = this.gl;
    const ext = this.ext;
    if (!this.active || !gl || !ext) return;
    this.active = false;
    if (typeof gl.isContextLost === 'function' && gl.isContextLost()) {
      this.onContextLost();
      return;
    }
    gl.endQuery(ext.TIME_ELAPSED_EXT);
  }

  public onContextLost(): void {
    this.active = false;
    this.discarded += this.pending.length;
    this.pending.length = 0;
    if (this.status === 'ok') this.status = 'lost';
  }

  public onContextRestored(gl: WebGLRenderingContext | WebGL2RenderingContext | null | undefined): void {
    this.active = false;
    this.pending.length = 0;
    this.disposed = false;
    if (!gl || typeof (gl as WebGL2RenderingContext).createQuery !== 'function') {
      this.gl = null;
      this.ext = null;
      this.status = 'unsupported';
      return;
    }
    const gl2 = gl as WebGL2RenderingContext;
    const ext = gl2.getExtension('EXT_disjoint_timer_query_webgl2') as DisjointTimerQueryExt | null;
    if (!ext) {
      this.gl = null;
      this.ext = null;
      this.status = 'unsupported';
      return;
    }
    this.gl = gl2;
    this.ext = ext;
    this.status = 'ok';
  }

  /** Delete any in-flight queries when a measurement session completes so zero WebGLQuery handles linger. */
  public clearPending(): void {
    const gl = this.gl;
    const ext = this.ext;
    const lost = !gl || (typeof gl.isContextLost === 'function' && gl.isContextLost());
    if (this.active && gl && ext && !lost) {
      try { gl.endQuery(ext.TIME_ELAPSED_EXT); } catch { /* ignore */ }
    }
    this.active = false;
    if (gl && !lost) {
      for (const q of this.pending) {
        try { gl.deleteQuery(q); } catch { /* ignore */ }
      }
    }
    this.pending.length = 0;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    const ext = this.ext;
    const lost = !gl || (typeof gl.isContextLost === 'function' && gl.isContextLost());
    if (this.active && gl && ext && !lost) {
      try { gl.endQuery(ext.TIME_ELAPSED_EXT); } catch { /* ignore on teardown */ }
    }
    this.active = false;
    if (gl && !lost) {
      for (const q of this.pending) {
        try { gl.deleteQuery(q); } catch { /* ignore */ }
      }
    }
    this.pending.length = 0;
    this.gl = null;
    this.ext = null;
  }
}

export interface FrameMeasureReport {
  warmupFrames: number;
  recordedFrames: number;
  frameIntervalMs: PercentileSummary;
  cpuTotalMs: PercentileSummary;
  simMs: PercentileSummary;
  crowdMs: PercentileSummary;
  particlesMs: PercentileSummary;
  batchSyncMs: PercentileSummary;
  renderSubmitMs: PercentileSummary;
  gpuMs: PercentileSummary;
  gpuTimerStatus: GpuTimerStatus;
  gpuDiscarded: number;
  gpuSkipped: number;
  meanUploadBytes: number;
  meanCalls: number;
  meanTriangles: number;
}

/**
 * Preallocated per-frame CPU/GPU profiler session.
 * Zero allocations during active recording, and zero overhead when `profiler` is null in StageEngine.
 */
export class FrameProfilerSession {
  public readonly warmupFrames: number;
  public readonly targetFrames: number;
  private seenWarmup = 0;
  private recorded = 0;
  private lastRafMs = 0;
  private frameIntervalMs: Float64Array;
  private cpuTotalMs: Float64Array;
  private simMs: Float64Array;
  private crowdMs: Float64Array;
  private particlesMs: Float64Array;
  private batchSyncMs: Float64Array;
  private renderSubmitMs: Float64Array;
  private gpuMs: Float64Array;
  private gpuCount = 0;
  private uploadBytesSum = 0;
  private callsSum = 0;
  private trianglesSum = 0;
  private resolveDone: ((report: FrameMeasureReport) => void) | null = null;
  public readonly promise: Promise<FrameMeasureReport>;

  // Scratch fields for the active frame
  public curSimMs = 0;
  public curCrowdMs = 0;
  public curParticlesMs = 0;
  public curBatchSyncMs = 0;
  public curRenderSubmitMs = 0;
  public curUploadBytes = 0;
  private frameStartMs = 0;

  constructor(warmupFrames: number, targetFrames: number) {
    this.warmupFrames = Math.max(0, Math.min(600, Math.floor(warmupFrames)));
    this.targetFrames = Math.max(1, Math.min(2000, Math.floor(targetFrames)));
    this.frameIntervalMs = new Float64Array(this.targetFrames);
    this.cpuTotalMs = new Float64Array(this.targetFrames);
    this.simMs = new Float64Array(this.targetFrames);
    this.crowdMs = new Float64Array(this.targetFrames);
    this.particlesMs = new Float64Array(this.targetFrames);
    this.batchSyncMs = new Float64Array(this.targetFrames);
    this.renderSubmitMs = new Float64Array(this.targetFrames);
    this.gpuMs = new Float64Array(this.targetFrames + GPU_QUERY_RING_SIZE);
    this.promise = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  public isDone(): boolean {
    return this.recorded >= this.targetFrames;
  }

  /** True once warm-up frames have elapsed and the session is recording samples. */
  public isRecording(): boolean {
    return this.seenWarmup >= this.warmupFrames && this.recorded < this.targetFrames;
  }

  public beginFrame(nowMs: number): void {
    this.frameStartMs = nowMs;
    this.curSimMs = 0;
    this.curCrowdMs = 0;
    this.curParticlesMs = 0;
    this.curBatchSyncMs = 0;
    this.curRenderSubmitMs = 0;
    this.curUploadBytes = 0;
  }

  public recordGpuSample(ms: number): void {
    if (this.seenWarmup < this.warmupFrames) return;
    if (this.gpuCount < this.gpuMs.length) {
      this.gpuMs[this.gpuCount++] = ms;
    }
  }

  public endFrame(
    nowMs: number,
    calls: number,
    triangles: number,
    gpuTimer: GpuTimerRing | null,
  ): boolean {
    const interval = this.lastRafMs > 0 ? Math.max(0, nowMs - this.lastRafMs) : 0;
    this.lastRafMs = nowMs;

    if (this.seenWarmup < this.warmupFrames) {
      this.seenWarmup++;
      return false;
    }

    if (this.recorded < this.targetFrames) {
      const i = this.recorded++;
      const cpuTotal = Math.max(0, nowMs - this.frameStartMs);
      this.frameIntervalMs[i] = interval;
      this.cpuTotalMs[i] = cpuTotal;
      this.simMs[i] = this.curSimMs;
      this.crowdMs[i] = this.curCrowdMs;
      this.particlesMs[i] = this.curParticlesMs;
      this.batchSyncMs[i] = this.curBatchSyncMs;
      this.renderSubmitMs[i] = this.curRenderSubmitMs;
      this.uploadBytesSum += this.curUploadBytes;
      this.callsSum += calls;
      this.trianglesSum += triangles;
    }

    if (this.recorded >= this.targetFrames) {
      this.finish(gpuTimer);
      return true;
    }
    return false;
  }

  public finish(gpuTimer: GpuTimerRing | null): void {
    if (!this.resolveDone) return;
    const resolve = this.resolveDone;
    this.resolveDone = null;
    const n = this.recorded;
    resolve({
      warmupFrames: this.warmupFrames,
      recordedFrames: n,
      frameIntervalMs: computePercentiles(this.frameIntervalMs, n),
      cpuTotalMs: computePercentiles(this.cpuTotalMs, n),
      simMs: computePercentiles(this.simMs, n),
      crowdMs: computePercentiles(this.crowdMs, n),
      particlesMs: computePercentiles(this.particlesMs, n),
      batchSyncMs: computePercentiles(this.batchSyncMs, n),
      renderSubmitMs: computePercentiles(this.renderSubmitMs, n),
      gpuMs: computePercentiles(this.gpuMs, this.gpuCount),
      gpuTimerStatus: gpuTimer?.getStatus() ?? 'unsupported',
      gpuDiscarded: gpuTimer?.discarded ?? 0,
      gpuSkipped: gpuTimer?.skipped ?? 0,
      meanUploadBytes: n > 0 ? this.uploadBytesSum / n : 0,
      meanCalls: n > 0 ? this.callsSum / n : 0,
      meanTriangles: n > 0 ? this.trianglesSum / n : 0,
    });
  }
}

/**
 * sRGB channel (0..1) -> linear luminance component per WCAG 2.x relative luminance definition.
 */
export function srgbChannelToLinear(c: number): number {
  const clamped = c <= 0 ? 0 : c >= 1 ? 1 : c;
  return clamped <= 0.04045 ? clamped / 12.92 : Math.pow((clamped + 0.055) / 1.055, 2.4);
}

export interface CellColorMetrics {
  /** Mean WCAG relative luminance Y in [0, 1]. */
  y: number;
  /** Mean linear R, G, B in [0, 1]. */
  r: number;
  g: number;
  b: number;
  /** WCAG red saturation fraction R / (R + G + B) in linear RGB. */
  redRatio: number;
  /** WCAG saturated red metric max(0, (R - G - B) * 320). */
  redMetric: number;
}

export interface FrameLuminanceGrid {
  cols: number;
  rows: number;
  whole: CellColorMetrics;
  cells: CellColorMetrics[];
}

/**
 * Compute mean WCAG relative luminance and saturated-red metrics across an `cols × rows` grid
 * plus the whole frame from an RGBA Uint8Array (e.g., WebGL readPixels or 2D ImageData).
 */
export function computeFrameLuminanceGrid(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  cols = 8,
  rows = 8,
  flipY = false,
): FrameLuminanceGrid {
  const cellCount = cols * rows;
  const sumR = new Float64Array(cellCount);
  const sumG = new Float64Array(cellCount);
  const sumB = new Float64Array(cellCount);
  const counts = new Uint32Array(cellCount);

  // Precompute sRGB byte -> linear lookup table once per call (256 entries).
  const lut = new Float64Array(256);
  for (let i = 0; i < 256; i++) lut[i] = srgbChannelToLinear(i / 255);

  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  const totalPx = Math.max(1, width * height);

  for (let y = 0; y < height; y++) {
    const logicalY = flipY ? height - 1 - y : y;
    const cy = Math.min(rows - 1, Math.floor((logicalY * rows) / height));
    const rowOff = y * width * 4;
    for (let x = 0; x < width; x++) {
      const cx = Math.min(cols - 1, Math.floor((x * cols) / width));
      const idx = rowOff + x * 4;
      const r = lut[rgba[idx]];
      const g = lut[rgba[idx + 1]];
      const b = lut[rgba[idx + 2]];
      const cell = cy * cols + cx;
      sumR[cell] += r;
      sumG[cell] += g;
      sumB[cell] += b;
      counts[cell]++;
      totalR += r;
      totalG += g;
      totalB += b;
    }
  }

  const makeMetric = (r: number, g: number, b: number): CellColorMetrics => {
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const sum = r + g + b;
    const redRatio = sum > 1e-6 ? r / sum : 0;
    const redMetric = Math.max(0, (r - g - b) * 320);
    return { y, r, g, b, redRatio, redMetric };
  };

  const cells: CellColorMetrics[] = new Array(cellCount);
  for (let i = 0; i < cellCount; i++) {
    const c = Math.max(1, counts[i]);
    cells[i] = makeMetric(sumR[i] / c, sumG[i] / c, sumB[i] / c);
  }
  return {
    cols,
    rows,
    whole: makeMetric(totalR / totalPx, totalG / totalPx, totalB / totalPx),
    cells,
  };
}

export interface FlashSample {
  timeMs: number;
  grid: FrameLuminanceGrid;
}

export interface FlashAnalysisResult {
  maxGeneralFlashesPerSec: number;
  maxRedFlashesPerSec: number;
  maxWholeFrameFlashesPerSec: number;
  worstCellIndex: number;
  worstRedCellIndex: number;
}

/**
 * Count opposing luminance transitions (ΔY >= 0.10 with darker state < 0.80) and saturated-red
 * transitions (either state R/(R+G+B) >= 0.80 and |Δ((R-G-B)*320)| > 20) in a rolling 1,000 ms window.
 * One flash = one pair of opposing transitions (rise + fall or fall + rise).
 */
export function analyzeRollingFlashRate(samples: readonly FlashSample[]): FlashAnalysisResult {
  if (samples.length < 2) {
    return {
      maxGeneralFlashesPerSec: 0,
      maxRedFlashesPerSec: 0,
      maxWholeFrameFlashesPerSec: 0,
      worstCellIndex: -1,
      worstRedCellIndex: -1,
    };
  }

  const countSeries = (extract: (s: FlashSample) => CellColorMetrics) => {
    const genTimes: number[] = [];
    const redTimes: number[] = [];

    let anchorY = extract(samples[0]).y;
    let lastGenDir = 0; // +1 rising, -1 falling

    let anchorRed = extract(samples[0]);
    let lastRedDir = 0;

    for (let i = 1; i < samples.length; i++) {
      const t = samples[i].timeMs;
      const m = extract(samples[i]);

      // General flash opposing transitions (WCAG 2.x threshold: ΔY >= 0.10, darker < 0.80).
      const dy = m.y - anchorY;
      if (Math.abs(dy) >= 0.10 && Math.min(m.y, anchorY) < 0.80) {
        const dir = dy > 0 ? 1 : -1;
        if (lastGenDir !== 0 && dir !== lastGenDir) {
          genTimes.push(t);
        }
        lastGenDir = dir;
        anchorY = m.y;
      } else if ((lastGenDir > 0 && m.y > anchorY) || (lastGenDir < 0 && m.y < anchorY)) {
        // Track monotonic extrema so peaks/troughs are accurate across multi-frame ramps.
        anchorY = m.y;
      }

      // Saturated red opposing transitions.
      const dRed = m.redMetric - anchorRed.redMetric;
      if ((m.redRatio >= 0.80 || anchorRed.redRatio >= 0.80) && Math.abs(dRed) > 20) {
        const dir = dRed > 0 ? 1 : -1;
        if (lastRedDir !== 0 && dir !== lastRedDir) {
          redTimes.push(t);
        }
        lastRedDir = dir;
        anchorRed = m;
      } else if (
        (lastRedDir > 0 && m.redMetric > anchorRed.redMetric) ||
        (lastRedDir < 0 && m.redMetric < anchorRed.redMetric)
      ) {
        anchorRed = m;
      }
    }

    const maxInWindow = (times: number[]) => {
      let best = 0;
      let left = 0;
      for (let right = 0; right < times.length; right++) {
        while (times[right] - times[left] >= 1000) left++;
        const count = right - left + 1;
        if (count > best) best = count;
      }
      // Each entry in `times` is an opposing reversal (half-cycle -> 1 flash = 2 reversals,
      // OR conservative count: ceil(reversals / 2) flashes? Note: a 3 Hz square wave has 6 transitions/s
      // = 5 opposing reversals inside a 1000 ms window, i.e., ceil(reversals / 2) = 3 flashes/s,
      // while 4 Hz has 7 reversals -> 4 flashes/s!).
      return Math.ceil(best / 2);
    };

    return {
      gen: maxInWindow(genTimes),
      red: maxInWindow(redTimes),
    };
  };

  const whole = countSeries((s) => s.grid.whole);
  let maxGen = whole.gen;
  let maxRed = whole.red;
  let worstCellIndex = -1;
  let worstRedCellIndex = -1;

  const cellCount = samples[0].grid.cells.length;
  for (let c = 0; c < cellCount; c++) {
    const res = countSeries((s) => s.grid.cells[c]);
    if (res.gen > maxGen) {
      maxGen = res.gen;
      worstCellIndex = c;
    }
    if (res.red > maxRed) {
      maxRed = res.red;
      worstRedCellIndex = c;
    }
  }

  return {
    maxGeneralFlashesPerSec: maxGen,
    maxRedFlashesPerSec: maxRed,
    maxWholeFrameFlashesPerSec: whole.gen,
    worstCellIndex,
    worstRedCellIndex,
  };
}
