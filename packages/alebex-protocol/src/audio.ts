/**
 * Audio helpers shared by the browser microphone pipeline, the playback queue,
 * the mock Alebex server and the protocol probe. Pure functions and small
 * stateful classes only — no Web Audio or Node APIs — so they are unit-testable.
 */

/** Alebex Voice Engine input: PCM16LE, mono, exactly 16 kHz. */
export const INPUT_SAMPLE_RATE = 16_000;
/** Alebex agent audio output rate per the integration description. */
export const OUTPUT_SAMPLE_RATE = 24_000;
/** ~200 ms frames: the size the engine is tuned for. */
export const FRAME_SAMPLES = 3_200;
export const FRAME_BYTES = FRAME_SAMPLES * 2;

/** Float32 [-1, 1] → signed 16-bit. Clamps and uses asymmetric scaling so -1 → -32768 and 1 → 32767. */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

export function pcm16ToFloat(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = input[i] ?? 0;
    out[i] = s < 0 ? s / 0x8000 : s / 0x7fff;
  }
  return out;
}

/** Little-endian bytes of an Int16Array, independent of host endianness. */
export function int16ToLeBytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i] ?? 0, true);
  return bytes;
}

/** Decode PCM16LE bytes. A trailing odd byte is ignored. */
export function leBytesToInt16(bytes: Uint8Array): Int16Array {
  const n = Math.floor(bytes.byteLength / 2);
  const out = new Int16Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

/**
 * Streaming resampler: a box-filter anti-alias stage followed by linear
 * interpolation with a one-sample delay. Positions are tracked with exact
 * integer arithmetic, so the output is identical however the input is chunked
 * and N input samples always yield floor(N * outRate / inRate) output samples
 * (one second of input → exactly `outRate` samples).
 */
export class StreamingResampler {
  private readonly taps: number;
  private history: number[] = [];
  private prev = 0;
  /** Output samples produced so far. */
  private k = 0;
  /** Input samples consumed so far. */
  private consumed = 0;

  constructor(
    readonly inRate: number,
    readonly outRate: number = INPUT_SAMPLE_RATE,
  ) {
    if (!(inRate > 0) || !(outRate > 0) || !Number.isInteger(inRate) || !Number.isInteger(outRate)) {
      throw new RangeError("sample rates must be positive integers");
    }
    const step = inRate / outRate;
    this.taps = step > 1 ? Math.max(1, Math.round(step)) : 1;
  }

  process(chunk: Float32Array): Float32Array {
    if (chunk.length === 0) return new Float32Array(0);
    const x = this.lowPass(chunk);
    const { inRate, outRate } = this;
    const end = this.consumed + x.length;
    const out: number[] = [];
    // Output k sits at global input position k*inRate/outRate - 1 (index -1 is the previous chunk's last sample).
    while (this.k * inRate < end * outRate) {
      const num = this.k * inRate - (this.consumed + 1) * outRate; // local position × outRate
      const i = Math.floor(num / outRate);
      const frac = (num - i * outRate) / outRate;
      const a = i < 0 ? this.prev : (x[i] ?? 0);
      const b = x[i + 1] ?? a;
      out.push(a + (b - a) * frac);
      this.k++;
    }
    this.consumed = end;
    this.prev = x[x.length - 1] ?? 0;
    return Float32Array.from(out);
  }

  private lowPass(chunk: Float32Array): Float32Array {
    if (this.taps === 1) return chunk;
    const out = new Float32Array(chunk.length);
    const h = this.history;
    for (let i = 0; i < chunk.length; i++) {
      h.push(chunk[i] ?? 0);
      if (h.length > this.taps) h.shift();
      let sum = 0;
      for (const v of h) sum += v;
      out[i] = sum / h.length;
    }
    return out;
  }
}

/** Accumulates samples and emits fixed-size frames (default 200 ms at 16 kHz). */
export class PcmFramer {
  private buf: Int16Array;
  private n = 0;

  constructor(readonly frameSamples: number = FRAME_SAMPLES) {
    this.buf = new Int16Array(frameSamples);
  }

  push(samples: Int16Array): Int16Array[] {
    const frames: Int16Array[] = [];
    let offset = 0;
    while (offset < samples.length) {
      const take = Math.min(this.frameSamples - this.n, samples.length - offset);
      this.buf.set(samples.subarray(offset, offset + take), this.n);
      this.n += take;
      offset += take;
      if (this.n === this.frameSamples) {
        frames.push(this.buf.slice());
        this.n = 0;
      }
    }
    return frames;
  }

  /** Remaining partial frame, zero-padded, or null when empty. */
  flush(): Int16Array | null {
    if (this.n === 0) return null;
    const frame = new Int16Array(this.frameSamples);
    frame.set(this.buf.subarray(0, this.n));
    this.n = 0;
    return frame;
  }

  get pending(): number {
    return this.n;
  }
}

/** Mic pipeline in one object: float input at any rate → 200 ms PCM16LE frames at 16 kHz. */
export class MicEncoder {
  private readonly resampler: StreamingResampler;
  private readonly framer = new PcmFramer();

  constructor(inputRate: number) {
    this.resampler = new StreamingResampler(Math.round(inputRate), INPUT_SAMPLE_RATE);
  }

  push(input: Float32Array): Uint8Array[] {
    const resampled = this.resampler.process(input);
    return this.framer.push(floatToPcm16(resampled)).map(int16ToLeBytes);
  }
}

/** RMS level in [0, 1] for activity meters. */
export function rmsLevel(samples: Float32Array | Int16Array): number {
  if (samples.length === 0) return 0;
  const scale = samples instanceof Int16Array ? 1 / 0x8000 : 1;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = (samples[i] ?? 0) * scale;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / samples.length));
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  t["-".charCodeAt(0)] = 62; // tolerate base64url
  t["_".charCodeAt(0)] = 63;
  return t;
})();

/** Isomorphic base64 decode (browser + Node) that throws on invalid characters. */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[\s=]+/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64_LOOKUP[clean.charCodeAt(i)] ?? -1;
    if (v < 0) throw new Error("invalid base64 input");
    value = (value << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (value >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    s += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16;
    s += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + "==";
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    s += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + "=";
  }
  return s;
}

/** Synthesize a short speech-like tone burst (used by the mock engine so playback is audible). */
export function synthTone(
  seconds: number,
  sampleRate: number = OUTPUT_SAMPLE_RATE,
  baseHz = 180,
  amplitude = 0.08,
): Int16Array {
  const n = Math.round(seconds * sampleRate);
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.min(1, t * 20, (seconds - t) * 20) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t));
    f[i] =
      amplitude *
      env *
      (Math.sin(2 * Math.PI * baseHz * t) + 0.5 * Math.sin(2 * Math.PI * baseHz * 2.01 * t));
  }
  return floatToPcm16(f);
}
