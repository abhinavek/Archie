import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import ort from 'onnxruntime-node';

const require = createRequire(import.meta.url);
const { WaveFile } = require('wavefile') as {
  WaveFile: new (buffer?: Buffer) => {
    toSampleRate: (rate: number) => void;
    toBitDepth: (bitDepth: string) => void;
    getSamples: (interleaved: boolean, type: unknown) => unknown;
  };
};


function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}
function melToHz(mel: number): number {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

@Injectable()
export class VoiceService implements OnModuleInit {
  private readonly logger = new Logger(VoiceService.name);
  private session: ort.InferenceSession | null = null;
  private readonly modelPath = join(
    process.cwd(),
    'models',
    'camp_plus.onnx',
  );

  async onModuleInit(): Promise<void> {
    try {
      this.session = await ort.InferenceSession.create(this.modelPath);
      this.logger.log('CAM++ Speaker Recognition ONNX session initialised (192-dim output padded to 512-dim).');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Could not load CAM++ ONNX model from ${this.modelPath}: ${msg}`);
    }
  }

  /**
   * Extracts a 512-dimensional voice embedding using the CAM++ neural network.
   * Accepts either raw base64 audio, WAV file buffer, or PCM samples.
   */
  async extractEmbeddingFromAudio(base64Audio: string): Promise<number[]> {
    if (!base64Audio?.trim()) {
      return Array.from({ length: 512 }, () => 0.001);
    }

    try {
      const buffer = Buffer.from(base64Audio, 'base64');
      const wav = new WaveFile(buffer);
      wav.toSampleRate(16000);
      wav.toBitDepth('32f');
      const samples = wav.getSamples(false, Float32Array) as unknown as Float32Array;

      return await this.computeEmbedding(samples);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`WaveFile decode failed, using raw PCM buffer conversion: ${msg}`);
      const raw = Buffer.from(base64Audio, 'base64');
      const samples = new Float32Array(Math.floor(raw.length / 2));
      for (let i = 0; i < samples.length; i++) {
        samples[i] = raw.readInt16LE(i * 2) / 32768.0;
      }
      return await this.computeEmbedding(samples);
    }
  }

  /**
   * Runs the 80-channel FBank feature extraction and CAM++ ONNX model inference.
   */
  private async computeEmbedding(samples: Float32Array): Promise<number[]> {
    if (!this.session) {
      this.session = await ort.InferenceSession.create(this.modelPath);
    }

    // Must have at least 0.4 seconds of audio (6400 samples)
    if (samples.length < 6400) {
      const padded = new Float32Array(6400);
      padded.set(samples);
      samples = padded;
    }

    const { fbank, nFrames, nFilt } = this.computeFbank(samples, 16000, 80);
    const tensor = new ort.Tensor('float32', fbank, [1, nFrames, nFilt]);

    const results = await this.session.run({ x: tensor });
    const rawOutput = Array.from(results.embedding.data as Float32Array);

    // CAM++ natively outputs 192 dimensions. To match Qdrant's 512-dim `voices` collection,
    // pad with deterministic cyclic features and L2-normalize.
    const vector512 = Array.from({ length: 512 }, () => 0);
    for (let i = 0; i < 512; i++) {
      vector512[i] = rawOutput[i % rawOutput.length];
    }

    const norm = Math.sqrt(vector512.reduce((acc, v) => acc + v * v, 0)) || 1;
    return vector512.map((v) => v / norm);
  }

  /**
   * Computes 80-channel Mel Filterbank features required by CAM++.
   */
  private computeFbank(
    samples: Float32Array,
    sampleRate = 16000,
    nFilt = 80,
    winLenMs = 25,
    winStepMs = 10,
  ): { fbank: Float32Array; nFrames: number; nFilt: number } {
    const frameLen = Math.floor(sampleRate * (winLenMs / 1000));
    const frameStep = Math.floor(sampleRate * (winStepMs / 1000));
    const nFrames = Math.max(
      1,
      Math.floor((samples.length - frameLen) / frameStep) + 1,
    );
    const nFft = 512;

    const window = new Float32Array(frameLen);
    for (let i = 0; i < frameLen; i++) {
      window[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (frameLen - 1));
    }

    const lowMel = hzToMel(20);
    const highMel = hzToMel(sampleRate / 2);
    const melPoints = new Float32Array(nFilt + 2);
    for (let i = 0; i < nFilt + 2; i++) {
      melPoints[i] = lowMel + (i * (highMel - lowMel)) / (nFilt + 1);
    }
    const bin = new Int32Array(nFilt + 2);
    for (let i = 0; i < nFilt + 2; i++) {
      bin[i] = Math.floor(
        ((nFft + 1) * melToHz(melPoints[i])) / sampleRate,
      );
    }

    const fbank = new Float32Array(nFrames * nFilt);
    for (let f = 0; f < nFrames; f++) {
      const start = f * frameStep;
      const real = new Float32Array(nFft);
      for (let i = 0; i < frameLen; i++) {
        real[i] = (samples[start + i] || 0) * window[i];
      }
      const halfFft = nFft / 2 + 1;
      const power = new Float32Array(halfFft);
      for (let k = 0; k < halfFft; k++) {
        let r = 0;
        let im = 0;
        for (let n = 0; n < frameLen; n++) {
          const angle = (2 * Math.PI * k * n) / nFft;
          r += real[n] * Math.cos(angle);
          im -= real[n] * Math.sin(angle);
        }
        power[k] = (r * r + im * im) / nFft;
      }
      for (let m = 0; m < nFilt; m++) {
        let sum = 0;
        for (let k = bin[m]; k < bin[m + 1]; k++) {
          sum += ((k - bin[m]) / (bin[m + 1] - bin[m] || 1)) * power[k];
        }
        for (let k = bin[m + 1]; k < bin[m + 2]; k++) {
          sum +=
            ((bin[m + 2] - k) / (bin[m + 2] - bin[m + 1] || 1)) * power[k];
        }
        fbank[f * nFilt + m] = Math.log(Math.max(sum, 1e-5));
      }
    }
    return { fbank, nFrames, nFilt };
  }
}
