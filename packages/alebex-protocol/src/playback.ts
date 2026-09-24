/**
 * Clock-agnostic playback timeline. The browser drives it with
 * `AudioContext.currentTime`; tests drive it with a fake clock.
 *
 * Contract (from the Alebex browser integration description):
 * - `mark` is echoed only once playback has actually reached it.
 * - `clear_audio` flushes queued agent audio AND unplayed marks immediately;
 *   flushed marks are never echoed.
 */

export interface ScheduledChunk {
  id: number;
  startAt: number;
  endAt: number;
}

export interface PendingMark<M> {
  mark: M;
  dueAt: number;
}

export interface PlaybackTimelineOptions {
  /** Lead time added when the queue has run dry, seconds. */
  initialLead?: number;
  /** Upper bound for the adaptive jitter buffer, seconds. */
  maxLead?: number;
  /** Increase in lead after each underrun, seconds. */
  leadStep?: number;
}

export class PlaybackTimeline<M = unknown> {
  private chunks: ScheduledChunk[] = [];
  private marks: PendingMark<M>[] = [];
  private cursor = 0;
  private nextId = 1;
  private lead: number;
  private readonly maxLead: number;
  private readonly leadStep: number;
  private hadAudio = false;
  underruns = 0;

  constructor(opts: PlaybackTimelineOptions = {}) {
    this.lead = opts.initialLead ?? 0.06;
    this.maxLead = opts.maxLead ?? 0.25;
    this.leadStep = opts.leadStep ?? 0.04;
  }

  get jitterLead(): number {
    return this.lead;
  }

  /** Schedule a chunk; returns when it should start. */
  enqueue(durationSec: number, now: number): ScheduledChunk {
    this.prune(now);
    let startAt = this.cursor;
    if (startAt < now) {
      // Queue ran dry. If audio was flowing mid-utterance this is an underrun: grow the buffer.
      if (this.hadAudio && this.chunks.length === 0 && startAt > 0 && now - startAt < 1) {
        this.underruns++;
        this.lead = Math.min(this.maxLead, this.lead + this.leadStep);
      }
      startAt = now + this.lead;
    }
    const chunk = { id: this.nextId++, startAt, endAt: startAt + durationSec };
    this.cursor = chunk.endAt;
    this.chunks.push(chunk);
    this.hadAudio = true;
    return chunk;
  }

  /** A mark is due when all audio queued before it has finished playing. */
  addMark(mark: M, now: number): PendingMark<M> {
    const pending = { mark, dueAt: Math.max(now, this.cursor) };
    this.marks.push(pending);
    return pending;
  }

  /** Marks whose playback point has been reached, in order. Removes them. */
  takeDueMarks(now: number): M[] {
    const due: M[] = [];
    while (this.marks.length > 0 && (this.marks[0]?.dueAt ?? Infinity) <= now) {
      due.push(this.marks.shift()!.mark);
    }
    this.prune(now);
    return due;
  }

  /** clear_audio / barge-in: drop everything queued; returns the chunk ids to stop and the dropped marks. */
  clear(now: number): { stoppedChunkIds: number[]; droppedMarks: M[] } {
    const stoppedChunkIds = this.chunks.filter((c) => c.endAt > now).map((c) => c.id);
    const droppedMarks = this.marks.map((m) => m.mark);
    this.chunks = [];
    this.marks = [];
    this.cursor = now;
    this.hadAudio = false;
    return { stoppedChunkIds, droppedMarks };
  }

  /** True while scheduled audio is still audible. */
  isPlaying(now: number): boolean {
    return this.chunks.some((c) => c.startAt <= now && c.endAt > now) || this.cursor > now;
  }

  get queuedSeconds(): number {
    const last = this.chunks[this.chunks.length - 1];
    const first = this.chunks[0];
    return last && first ? last.endAt - first.startAt : 0;
  }

  get pendingMarkCount(): number {
    return this.marks.length;
  }

  private prune(now: number): void {
    this.chunks = this.chunks.filter((c) => c.endAt > now);
  }
}

export interface TranscriptEntry {
  id: string;
  role: "user" | "agent";
  text: string;
  at: number;
}

/**
 * Transcript state. Partials are replacement snapshots (assign, never append);
 * a committed message clears the live draft for that speaker.
 */
export class TranscriptStore {
  private drafts: Partial<Record<"user" | "agent", TranscriptEntry>> = {};
  private committed: TranscriptEntry[] = [];
  private seq = 0;

  constructor(private readonly clock: () => number = () => Date.now()) {}

  partial(role: "user" | "agent", text: string): void {
    const existing = this.drafts[role];
    this.drafts[role] = { id: existing?.id ?? `draft-${role}-${++this.seq}`, role, text, at: existing?.at ?? this.clock() };
  }

  /** Commit a stable message. Duplicate commits (same id, or same role+text as the last one) are ignored. */
  commit(role: "user" | "agent", text: string, id?: string): boolean {
    delete this.drafts[role];
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (id && this.committed.some((m) => m.id === id)) return false;
    const last = [...this.committed].reverse().find((m) => m.role === role);
    if (!id && last && last.text === trimmed && this.clock() - last.at < 5_000) return false;
    this.committed.push({ id: id ?? `msg-${++this.seq}`, role, text: trimmed, at: this.clock() });
    return true;
  }

  /** A final transcript with no conversation_message: commit it the same way. */
  final(role: "user" | "agent", text: string): boolean {
    return this.commit(role, text);
  }

  get messages(): readonly TranscriptEntry[] {
    return this.committed;
  }

  get liveDrafts(): TranscriptEntry[] {
    return (["user", "agent"] as const).flatMap((r) => (this.drafts[r] ? [this.drafts[r]!] : []));
  }

  clear(): void {
    this.drafts = {};
    this.committed = [];
  }
}
