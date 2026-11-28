import { isLogicalDmxUniverse } from '../data/dmxUniverses';

export const ARTNET_PREVIEW_TIMEOUT_MS = 3000;
export type PreviewLevelSource = 'desk' | 'external';
type PreviewTiming = 'pending' | 'ready' | 'unavailable';

export interface ExternalLevelSample {
  sequence: number;
  acceptedAtLower: number;
  deadline: number;
  data: Uint8Array;
}

const equalAuthority = (a: DmxAuthorityBridge | null, b: DmxAuthorityBridge) =>
  a !== null && a.revision === b.revision && a.generation === b.generation;

/** Renderer-only monitor metadata admitted for visual use. No authored or output buffers. */
export class ArtNetPreviewLevels {
  source: PreviewLevelSource = 'desk';
  timing: PreviewTiming = 'pending';
  documentEpoch = 0;
  authority: DmxAuthorityBridge | null = null;
  private requestedAt = 0;
  private anchorMs = 0;
  private offsetLower = 0;
  private lastSentAt = -Infinity;
  private readonly mappings = new Map<number, ArtNetInputMappingBridge>();
  private readonly seen = new Float64Array(17);
  private readonly sampleTimes = new Float64Array(17);
  private readonly samples: (ExternalLevelSample | null)[] = Array(17).fill(null);

  begin(authority: DmxAuthorityBridge, mappings: readonly ArtNetInputMappingBridge[], requestedAt: number): void {
    this.end();
    this.authority = authority;
    this.requestedAt = requestedAt;
    for (const mapping of mappings) this.mappings.set(mapping.universe, mapping);
  }

  acceptAnchor(authority: DmxAuthorityBridge, anchorMs: number, now: number): void {
    if (!equalAuthority(this.authority, authority) || this.timing !== 'pending') return;
    const transit = now - this.requestedAt;
    const offset = this.requestedAt - anchorMs;
    if (!Number.isFinite(anchorMs) || anchorMs < 0 || !Number.isFinite(transit) || !Number.isFinite(offset) ||
        transit < 0 || transit >= ARTNET_PREVIEW_TIMEOUT_MS) {
      this.timing = 'unavailable';
      return;
    }
    this.anchorMs = anchorMs;
    this.offsetLower = offset;
    this.timing = 'ready';
  }

  acceptBatch(batch: ArtNetInputBatchBridge, now: number): void {
    if (this.timing !== 'ready' || !equalAuthority(this.authority, batch.authority)) return;
    const sentAt = batch.sentAtMs;
    if (!Number.isFinite(now) || !Number.isFinite(sentAt) || sentAt < this.anchorMs || sentAt < this.lastSentAt ||
        sentAt + this.offsetLower > now || batch.rows.length > 16) {
      this.samples.fill(null);
      return;
    }
    this.lastSentAt = sentAt;
    for (const row of batch.rows) {
      const universe = row.universe;
      const mapping = this.mappings.get(universe);
      if (!isLogicalDmxUniverse(universe) || !mapping || row.sender !== mapping.sender ||
          row.portAddress !== mapping.portAddress) continue;
      const sequence = row.sampleSeq;
      if (sequence === null) {
        this.seen[universe] = Infinity; // this generation exhausted its sequence representation
        this.samples[universe] = null;
        continue;
      }
      if (!Number.isSafeInteger(sequence) || sequence < 0) {
        this.samples[universe] = null;
        continue;
      }
      const last = this.seen[universe];
      if (sequence < last) continue;
      if (row.state !== 'active') {
        this.seen[universe] = sequence;
        this.samples[universe] = null;
        continue;
      }
      if (sequence === 0 || sequence === last) continue; // repeated rows never refresh a deadline
      this.seen[universe] = sequence;
      this.samples[universe] = null;
      const { ageMs, sampleAtMs } = row;
      if (ageMs === null || sampleAtMs === null || !Number.isFinite(ageMs) || ageMs < 0 ||
          !Number.isFinite(sampleAtMs) || sampleAtMs < this.anchorMs || sampleAtMs > sentAt ||
          sampleAtMs < this.sampleTimes[universe] || ageMs !== Math.floor(sentAt - sampleAtMs) ||
          row.data.byteLength !== 512) continue;
      this.sampleTimes[universe] = sampleAtMs;
      const acceptedAtLower = sampleAtMs + this.offsetLower;
      const deadline = Math.min(now - ageMs, acceptedAtLower) + ARTNET_PREVIEW_TIMEOUT_MS;
      if (Number.isFinite(deadline) && now < deadline) {
        this.samples[universe] = { sequence, acceptedAtLower, deadline, data: row.data };
      }
    }
  }

  latestSequence(universe: number): number { return this.seen[universe] ?? 0; }

  read(universe: number, now: number): ExternalLevelSample | null {
    const sample = this.samples[universe];
    return sample && Number.isFinite(now) && now < sample.deadline ? sample : null;
  }

  end(): void {
    this.authority = null;
    this.lastSentAt = -Infinity;
    this.timing = 'pending';
    this.mappings.clear();
    this.seen.fill(0);
    this.sampleTimes.fill(0);
    this.samples.fill(null);
  }

  resetDocument(): void {
    this.source = 'desk';
    this.documentEpoch++;
    this.end();
  }
}
