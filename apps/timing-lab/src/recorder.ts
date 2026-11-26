/** Records raw mono audio from an input device (no echo cancellation / AGC / noise suppression). */

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('tap', Tap);
`;

export interface Recording {
  samples: Float32Array;
  sampleRate: number;
}

export interface Recorder {
  stop(): Promise<Recording>;
}

export async function listAudioInputs(): Promise<MediaDeviceInfo[]> {
  // Labels are only visible after permission has been granted once.
  const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
  probe.getTracks().forEach((t) => t.stop());
  return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
}

export async function startRecording(deviceId: string): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: deviceId },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  });
  const ctx = new AudioContext();
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const src = ctx.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(ctx, 'tap');
  const chunks: Float32Array[] = [];
  tap.port.onmessage = (e: MessageEvent<Float32Array>) => chunks.push(e.data);
  src.connect(tap);

  return {
    async stop() {
      src.disconnect();
      tap.port.onmessage = null;
      stream.getTracks().forEach((t) => t.stop());
      const sampleRate = ctx.sampleRate;
      await ctx.close();
      const total = chunks.reduce((s, c) => s + c.length, 0);
      const samples = new Float32Array(total);
      let o = 0;
      for (const c of chunks) {
        samples.set(c, o);
        o += c.length;
      }
      return { samples, sampleRate };
    },
  };
}
