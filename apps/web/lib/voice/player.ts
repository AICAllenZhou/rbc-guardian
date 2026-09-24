/**
 * Agent audio playback: ordered 24 kHz PCM16LE chunks scheduled on an
 * AudioContext with a small adaptive jitter buffer (PlaybackTimeline).
 * - `mark` frames are released only when the audio queued before them has played.
 * - `clear()` (clear_audio or barge-in) stops everything queued immediately and
 *   discards unplayed marks — they are never echoed.
 */
import { leBytesToInt16, OUTPUT_SAMPLE_RATE, pcm16ToFloat, PlaybackTimeline, rmsLevel } from "@guardian/alebex-protocol";

export class PcmPlayer {
  private readonly ctx: AudioContext;
  private readonly gain: GainNode;
  private readonly timeline = new PlaybackTimeline<Record<string, unknown>>({ initialLead: 0.08, maxLead: 0.3 });
  private readonly sources = new Map<number, AudioBufferSourceNode>();
  private readonly markTimer: ReturnType<typeof setInterval>;
  private closed = false;
  decodeErrors = 0;

  constructor(
    private readonly onMarkPlayed: (mark: Record<string, unknown>) => void,
    private readonly onLevel: (level: number) => void,
    private sampleRate: number = OUTPUT_SAMPLE_RATE,
  ) {
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
    this.markTimer = setInterval(() => this.tick(), 40);
  }

  async resume(): Promise<void> {
    if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => undefined);
  }

  enqueue(bytes: ArrayBuffer): void {
    if (this.closed) return;
    let samples: Float32Array;
    try {
      if (bytes.byteLength < 2) return;
      samples = pcm16ToFloat(leBytesToInt16(new Uint8Array(bytes)));
    } catch {
      this.decodeErrors++;
      return;
    }
    const buffer = this.ctx.createBuffer(1, samples.length, this.sampleRate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const chunk = this.timeline.enqueue(buffer.duration, this.ctx.currentTime);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gain);
    src.onended = () => this.sources.delete(chunk.id);
    this.sources.set(chunk.id, src);
    src.start(chunk.startAt);
    const level = rmsLevel(samples);
    setTimeout(() => !this.closed && this.onLevel(level * 3), Math.max(0, (chunk.startAt - this.ctx.currentTime) * 1000));
  }

  /** The engine reports its output rate on every audio frame; the gateway forwards changes. */
  setSampleRate(rate: number): void {
    if (Number.isInteger(rate) && rate >= 8_000 && rate <= 96_000) this.sampleRate = rate;
  }

  addMark(mark: Record<string, unknown>): void {
    if (!this.closed) this.timeline.addMark(mark, this.ctx.currentTime);
  }

  /** Flush queued audio and unplayed marks right now. */
  clear(): number {
    const { stoppedChunkIds, droppedMarks } = this.timeline.clear(this.ctx.currentTime);
    for (const id of stoppedChunkIds) {
      const s = this.sources.get(id);
      try {
        s?.stop();
      } catch {}
      this.sources.delete(id);
    }
    this.onLevel(0);
    return droppedMarks.length;
  }

  setMuted(muted: boolean): void {
    this.gain.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.02);
  }

  isPlaying(): boolean {
    return this.timeline.isPlaying(this.ctx.currentTime);
  }

  get stats() {
    return { underruns: this.timeline.underruns, jitterLeadMs: Math.round(this.timeline.jitterLead * 1000), decodeErrors: this.decodeErrors };
  }

  private tick(): void {
    if (this.closed) return;
    for (const m of this.timeline.takeDueMarks(this.ctx.currentTime)) this.onMarkPlayed(m);
    if (!this.timeline.isPlaying(this.ctx.currentTime)) this.onLevel(0);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.clear();
    this.closed = true;
    clearInterval(this.markTimer);
    if (this.ctx.state !== "closed") await this.ctx.close().catch(() => undefined);
  }
}
