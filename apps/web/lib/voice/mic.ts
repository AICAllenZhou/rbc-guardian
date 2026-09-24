/**
 * Microphone capture: getUserMedia → AudioWorklet (raw float blocks) → MicEncoder
 * (deterministic resample to exactly 16 kHz, PCM16LE, 200 ms frames).
 *
 * We do not rely on `new AudioContext({ sampleRate: 16000 })`: some browsers
 * ignore or reject it. The context runs at the device rate and we resample.
 */
import { MicEncoder, rmsLevel } from "@guardian/alebex-protocol";

const WORKLET_SOURCE = `
class GuardianCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice()); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("guardian-capture", GuardianCapture);
`;

export class MicError extends Error {
  constructor(
    readonly code: "denied" | "no_device" | "unsupported" | "failed",
    message: string,
  ) {
    super(message);
  }
}

export interface MicHandle {
  inputSampleRate: number;
  setMuted(muted: boolean): void;
  stop(): Promise<void>;
}

export async function startMic(onFrame: (frame: Uint8Array) => void, onLevel: (level: number) => void): Promise<MicHandle> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new MicError("unsupported", "This browser cannot capture microphone audio. Try a current Chrome, Edge, Firefox or Safari.");
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (err) {
    const name = (err as DOMException)?.name;
    if (name === "NotAllowedError" || name === "SecurityError") throw new MicError("denied", "Microphone access was blocked. Allow the microphone for this site in the address bar, then call again.");
    if (name === "NotFoundError" || name === "OverconstrainedError") throw new MicError("no_device", "No microphone was found. Connect one, or use a headset, and call again.");
    throw new MicError("failed", "The microphone could not be started.");
  }

  const ctx = new AudioContext({ latencyHint: "interactive" });
  try {
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close();
    throw new MicError("unsupported", "This browser does not support AudioWorklet, which Guardian needs for low-latency audio.");
  }

  const encoder = new MicEncoder(ctx.sampleRate);
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "guardian-capture");
  // The graph is pulled from the destination; route through a silent gain so process() runs without echoing the mic.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  let muted = false;
  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    const block = muted ? new Float32Array(e.data.length) : e.data;
    onLevel(muted ? 0 : rmsLevel(block));
    // Muted mic still streams silence so the engine's turn-taking and idle timers behave.
    for (const frame of encoder.push(block)) onFrame(frame);
  };
  source.connect(node);
  node.connect(sink).connect(ctx.destination);
  if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);

  return {
    inputSampleRate: ctx.sampleRate,
    setMuted(m) {
      muted = m;
      stream.getAudioTracks().forEach((t) => (t.enabled = !m));
    },
    async stop() {
      node.port.onmessage = null;
      try {
        source.disconnect();
        node.disconnect();
      } catch {}
      stream.getTracks().forEach((t) => t.stop());
      if (ctx.state !== "closed") await ctx.close().catch(() => undefined);
    },
  };
}
