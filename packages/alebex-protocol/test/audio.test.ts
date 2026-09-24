import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  FRAME_BYTES,
  FRAME_SAMPLES,
  floatToPcm16,
  int16ToLeBytes,
  leBytesToInt16,
  MicEncoder,
  PcmFramer,
  pcm16ToFloat,
  StreamingResampler,
} from "../src/audio";

function sine(rate: number, seconds: number, hz = 440): Float32Array {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

function chunked(input: Float32Array, size: number): Float32Array[] {
  const parts: Float32Array[] = [];
  for (let i = 0; i < input.length; i += size) parts.push(input.subarray(i, i + size));
  return parts;
}

describe("Float32 → PCM16LE", () => {
  it("maps full scale and clamps out-of-range values", () => {
    expect(Array.from(floatToPcm16(Float32Array.from([0, 1, -1, 2, -2, 0.5])))).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
  });

  it("writes little-endian bytes regardless of host", () => {
    const bytes = int16ToLeBytes(Int16Array.from([0x0102, -2]));
    expect(Array.from(bytes)).toEqual([0x02, 0x01, 0xfe, 0xff]);
    expect(Array.from(leBytesToInt16(bytes))).toEqual([0x0102, -2]);
  });

  it("round-trips within quantisation error", () => {
    const f = Float32Array.from([0.25, -0.75, 0.999]);
    const back = pcm16ToFloat(floatToPcm16(f));
    f.forEach((v, i) => expect(back[i]).toBeCloseTo(v, 3));
  });
});

describe("StreamingResampler", () => {
  it.each([48_000, 44_100, 96_000, 16_000, 22_050, 8_000])("produces exactly 16,000 samples per second from %i Hz", (rate) => {
    const r = new StreamingResampler(rate, 16_000);
    let total = 0;
    for (const part of chunked(sine(rate, 1), 128)) total += r.process(part).length;
    expect(total).toBe(16_000);
  });

  it("is deterministic across arbitrary chunkings", () => {
    const input = sine(48_000, 0.5);
    const one = new StreamingResampler(48_000).process(input);
    const r = new StreamingResampler(48_000);
    const parts = [...chunked(input.subarray(0, 1000), 7), ...chunked(input.subarray(1000), 333)].map((p) => r.process(p));
    const joined = Float32Array.from(parts.flatMap((p) => Array.from(p)));
    expect(joined.length).toBe(one.length);
    joined.forEach((v, i) => expect(v).toBeCloseTo(one[i] ?? NaN, 6));
  });

  it("preserves a low-frequency tone", () => {
    const out = new StreamingResampler(48_000).process(sine(48_000, 0.1, 200));
    const expected = sine(16_000, 0.1, 200);
    // Output is delayed by ~1 output sample (interpolation delay + box-filter group delay).
    let err = 0;
    for (let i = 10; i < out.length - 10; i++) err = Math.max(err, Math.abs((out[i + 1] ?? 0) - (expected[i] ?? 0)));
    expect(err).toBeLessThan(0.05);
  });

  it("rejects invalid rates", () => {
    expect(() => new StreamingResampler(0)).toThrow(RangeError);
  });
});

describe("200 ms framing", () => {
  it("emits exact 3,200-sample frames and keeps the remainder", () => {
    const f = new PcmFramer();
    expect(f.push(new Int16Array(3_000))).toHaveLength(0);
    const frames = f.push(new Int16Array(3_500));
    expect(frames).toHaveLength(2);
    frames.forEach((fr) => expect(fr.length).toBe(FRAME_SAMPLES));
    expect(f.pending).toBe(100);
    expect(f.flush()?.length).toBe(FRAME_SAMPLES);
    expect(f.flush()).toBeNull();
  });

  it("MicEncoder turns 1 s of 48 kHz audio into five 6,400-byte frames", () => {
    const enc = new MicEncoder(48_000);
    const frames = chunked(sine(48_000, 1), 128).flatMap((p) => enc.push(p));
    expect(frames).toHaveLength(5);
    frames.forEach((fr) => expect(fr.byteLength).toBe(FRAME_BYTES));
  });
});

describe("base64", () => {
  it("round-trips all byte lengths", () => {
    for (let n = 0; n < 10; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
      const b64 = bytesToBase64(bytes);
      expect(b64).toBe(Buffer.from(bytes).toString("base64"));
      expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(bytes));
    }
  });

  it("throws on invalid input", () => {
    expect(() => base64ToBytes("ab$c")).toThrow();
  });
});
