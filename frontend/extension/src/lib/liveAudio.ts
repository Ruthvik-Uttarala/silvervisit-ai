const TARGET_SAMPLE_RATE = 16000;
const OUTPUT_MIME_TYPE = "audio/pcm;rate=16000";
const AUDIO_PROCESSOR_BUFFER_SIZE = 4096;

export interface MicChunkPayload {
  dataBase64: string;
  mimeType: string;
  byteLength: number;
}

export interface MicStartMetadata {
  inputSampleRate: number;
  outputSampleRate: number;
}

export interface MicCallbacks {
  onPermissionGranted?: () => void;
  onPermissionDenied?: (message: string) => void;
  onStart?: (meta: MicStartMetadata) => void;
  onChunk?: (payload: MicChunkPayload) => void;
  onError?: (message: string) => void;
  onStop?: () => void;
}

interface FloatResampleState {
  remainder: Float32Array;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function concatFloat32(a: Float32Array, b: Float32Array): Float32Array {
  if (a.length === 0) {
    return b.slice();
  }
  if (b.length === 0) {
    return a.slice();
  }
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function float32ToPcm16Bytes(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    const int = value < 0 ? value * 0x8000 : value * 0x7fff;
    view.setInt16(i * 2, Math.round(int), true);
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function resampleToTarget(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number,
  state: FloatResampleState,
): Float32Array {
  const combined = concatFloat32(state.remainder, input);
  if (combined.length < 2) {
    state.remainder = combined;
    return new Float32Array(0);
  }

  if (inputSampleRate === outputSampleRate) {
    state.remainder = new Float32Array(0);
    return combined;
  }

  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.floor((combined.length - 1) / ratio);
  if (outputLength <= 0) {
    state.remainder = combined;
    return new Float32Array(0);
  }

  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const position = i * ratio;
    const leftIndex = Math.floor(position);
    const rightIndex = Math.min(leftIndex + 1, combined.length - 1);
    const fraction = position - leftIndex;
    output[i] = combined[leftIndex] * (1 - fraction) + combined[rightIndex] * fraction;
  }

  const consumed = Math.floor(outputLength * ratio);
  state.remainder = combined.slice(Math.max(consumed, 0));
  return output;
}

export class LiveAudioRecorder {
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private mediaSource: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private muteGainNode: GainNode | null = null;
  private readonly resampleState: FloatResampleState = { remainder: new Float32Array(0) };
  private running = false;

  constructor(private readonly callbacks: MicCallbacks = {}) {}

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone capture is not supported in this browser context.");
    }

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      this.callbacks.onPermissionGranted?.();
    } catch (error) {
      const message = toErrorMessage(error);
      this.callbacks.onPermissionDenied?.(message);
      throw new Error(`Microphone permission failed: ${message}`);
    }

    try {
      this.audioContext = new AudioContext();
      this.mediaSource = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.processor = this.audioContext.createScriptProcessor(AUDIO_PROCESSOR_BUFFER_SIZE, 1, 1);
      this.muteGainNode = this.audioContext.createGain();
      this.muteGainNode.gain.value = 0;

      this.processor.onaudioprocess = (event: AudioProcessingEvent) => {
        if (!this.running) {
          return;
        }
        const raw = event.inputBuffer.getChannelData(0);
        const resampled = resampleToTarget(raw, this.audioContext!.sampleRate, TARGET_SAMPLE_RATE, this.resampleState);
        if (resampled.length === 0) {
          return;
        }
        const pcmBytes = float32ToPcm16Bytes(resampled);
        this.callbacks.onChunk?.({
          dataBase64: bytesToBase64(pcmBytes),
          mimeType: OUTPUT_MIME_TYPE,
          byteLength: pcmBytes.byteLength,
        });
      };

      this.mediaSource.connect(this.processor);
      this.processor.connect(this.muteGainNode);
      this.muteGainNode.connect(this.audioContext.destination);
      this.running = true;
      this.callbacks.onStart?.({
        inputSampleRate: this.audioContext.sampleRate,
        outputSampleRate: TARGET_SAMPLE_RATE,
      });
    } catch (error) {
      const message = toErrorMessage(error);
      this.callbacks.onError?.(message);
      await this.stop();
      throw new Error(`Microphone pipeline setup failed: ${message}`);
    }
  }

  async stop(): Promise<void> {
    const wasRunning = this.running;
    this.running = false;
    this.resampleState.remainder = new Float32Array(0);

    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
      this.processor = null;
    }

    if (this.mediaSource) {
      this.mediaSource.disconnect();
      this.mediaSource = null;
    }

    if (this.muteGainNode) {
      this.muteGainNode.disconnect();
      this.muteGainNode = null;
    }

    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }

    if (this.audioContext) {
      await this.audioContext.close().catch(() => undefined);
      this.audioContext = null;
    }

    if (wasRunning) {
      this.callbacks.onStop?.();
    }
  }
}

