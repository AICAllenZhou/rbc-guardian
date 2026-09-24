import { describe, expect, it } from "vitest";
import { PlaybackTimeline, TranscriptStore } from "../src/playback";

describe("PlaybackTimeline", () => {
  it("schedules chunks back to back in order", () => {
    const t = new PlaybackTimeline({ initialLead: 0.05 });
    const a = t.enqueue(0.2, 1);
    const b = t.enqueue(0.2, 1.01);
    expect(a.startAt).toBeCloseTo(1.05);
    expect(b.startAt).toBeCloseTo(a.endAt);
    expect(b.id).toBeGreaterThan(a.id);
  });

  it("echoes a mark only after the audio before it has played", () => {
    const t = new PlaybackTimeline<string>({ initialLead: 0 });
    t.enqueue(0.5, 0);
    t.addMark("m1", 0);
    expect(t.takeDueMarks(0.25)).toEqual([]);
    expect(t.takeDueMarks(0.5)).toEqual(["m1"]);
    expect(t.takeDueMarks(1)).toEqual([]);
  });

  it("releases a mark immediately when nothing is queued", () => {
    const t = new PlaybackTimeline<string>();
    t.addMark("m0", 3);
    expect(t.takeDueMarks(3)).toEqual(["m0"]);
  });

  it("keeps multiple marks in order", () => {
    const t = new PlaybackTimeline<string>({ initialLead: 0 });
    t.enqueue(0.2, 0);
    t.addMark("a", 0);
    t.enqueue(0.2, 0);
    t.addMark("b", 0);
    expect(t.takeDueMarks(0.3)).toEqual(["a"]);
    expect(t.takeDueMarks(0.4)).toEqual(["b"]);
  });

  it("clear_audio flushes queued audio and unplayed marks, which are never echoed", () => {
    const t = new PlaybackTimeline<string>({ initialLead: 0 });
    const c1 = t.enqueue(1, 0);
    t.addMark("stale", 0);
    const { stoppedChunkIds, droppedMarks } = t.clear(0.3);
    expect(stoppedChunkIds).toEqual([c1.id]);
    expect(droppedMarks).toEqual(["stale"]);
    expect(t.takeDueMarks(5)).toEqual([]);
    // New audio after the flush starts now, not after the stale audio.
    expect(t.enqueue(0.1, 0.3).startAt).toBeLessThan(0.5);
  });

  it("grows the jitter buffer after an underrun, up to a cap", () => {
    const t = new PlaybackTimeline({ initialLead: 0.05, leadStep: 0.05, maxLead: 0.12 });
    t.enqueue(0.1, 0); // ends 0.15
    t.enqueue(0.1, 0.3); // gap → underrun
    expect(t.underruns).toBe(1);
    expect(t.jitterLead).toBeCloseTo(0.1);
    t.enqueue(0.1, 1.0);
    expect(t.jitterLead).toBeLessThanOrEqual(0.12);
  });
});

describe("TranscriptStore", () => {
  it("replaces partial snapshots instead of appending", () => {
    const s = new TranscriptStore();
    s.partial("user", "I received");
    s.partial("user", "I received a suspicious");
    s.partial("user", "I received a suspicious bank call");
    expect(s.liveDrafts).toHaveLength(1);
    expect(s.liveDrafts[0]?.text).toBe("I received a suspicious bank call");
  });

  it("allows partials to shrink as the decoder settles", () => {
    const s = new TranscriptStore();
    s.partial("agent", "mister quilt her");
    s.partial("agent", "Mr. Quilter");
    expect(s.liveDrafts[0]?.text).toBe("Mr. Quilter");
  });

  it("commit clears the draft and ignores duplicates", () => {
    let now = 0;
    const s = new TranscriptStore(() => now);
    s.partial("agent", "Hello");
    expect(s.commit("agent", "Hello there")).toBe(true);
    expect(s.liveDrafts).toHaveLength(0);
    expect(s.commit("agent", "Hello there")).toBe(false);
    expect(s.commit("agent", "Other", "id-1")).toBe(true);
    expect(s.commit("agent", "Other", "id-1")).toBe(false);
    now = 10_000;
    expect(s.commit("agent", "Hello there")).toBe(true);
    expect(s.messages.map((m) => m.text)).toEqual(["Hello there", "Other", "Hello there"]);
  });
});
