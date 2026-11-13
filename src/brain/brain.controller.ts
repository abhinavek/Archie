import {
  BadRequestException,
  Body,
  Controller,
  Logger,
  Post,
} from '@nestjs/common';
import {
  FaceRecognitionResult,
  MemoryService,
  VoiceRecognitionResult,
} from '../memory/memory.service.js';
import type { ChatMessage, ClientLocation } from './brain.service.js';
import { BrainService } from './brain.service.js';
import { VoiceService } from './voice.service.js';

@Controller('brain')
export class BrainController {
  private readonly logger = new Logger(BrainController.name);

  constructor(
    private readonly brain: BrainService,
    private readonly memory: MemoryService,
    private readonly voice: VoiceService,
  ) {}

  @Post('memorize')
  async memorize(
    @Body('sceneText') sceneText?: string,
  ): Promise<{ status: string }> {
    if (!sceneText?.trim()) {
      throw new BadRequestException('sceneText is required.');
    }
    await this.memory.memorizeScene(sceneText);
    return { status: 'memorized' };
  }

  @Post('ask')
  async ask(
    @Body('prompt') prompt?: string,
    @Body('personName') personName?: string,
    @Body('voiceDescriptor') voiceDescriptor?: number[],
    @Body('audioBase64') audioBase64?: string,
    @Body('location') location?: ClientLocation,
    @Body('history') history?: ChatMessage[],
  ): Promise<{ answer: string; identifiedSpeaker?: string }> {
    if (!prompt?.trim()) {
      throw new BadRequestException('prompt is required.');
    }

    let effectiveSpeaker = personName?.trim();

    // If face recognition hasn't identified the person yet, validate their voice
    let finalVoiceDescriptor = voiceDescriptor;
    if (
      !effectiveSpeaker &&
      (!finalVoiceDescriptor || finalVoiceDescriptor.length !== 512) &&
      audioBase64?.trim()
    ) {
      try {
        finalVoiceDescriptor = await this.voice.extractEmbeddingFromAudio(audioBase64);
      } catch {
        // Fallback
      }
    }

    if (!effectiveSpeaker && Array.isArray(finalVoiceDescriptor) && finalVoiceDescriptor.length === 512) {
      try {
        const voiceResult = await this.memory.recognizeVoice(finalVoiceDescriptor);
        if (voiceResult.matched && voiceResult.name) {
          effectiveSpeaker = voiceResult.name;
          this.logger.log(`[ask] Identified speaker by voice: "${effectiveSpeaker}" (score: ${voiceResult.score})`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`[ask] Voice recognition check failed: ${msg}`);
      }
    }

    const answer = await this.brain.ask(prompt, effectiveSpeaker, history, location);
    return { answer, identifiedSpeaker: effectiveSpeaker };
  }

  @Post('engage')
  async engage(
    @Body('personName') personName?: string,
  ): Promise<{ answer: string }> {
    const answer = await this.brain.engage(personName);
    return { answer };
  }

  @Post('frame')
  async receiveLatestFrame(
    @Body('frameBase64') frameBase64?: string,
  ): Promise<{ status: string }> {
    if (frameBase64) {
      this.brain.updateLatestFrame(frameBase64);
    }
    return { status: 'ok' };
  }

  @Post('continuous-scene')
  async continuousScene(
    @Body('sceneDescription') sceneDescription?: string,
    @Body('frameBase64') frameBase64?: string,
    @Body('personName') personName?: string,
  ): Promise<{ proactiveSpeech: string | null }> {
    if (frameBase64) {
      this.brain.updateLatestFrame(frameBase64);
    }

    let description = sceneDescription?.trim();
    if (!description && frameBase64) {
      description = await this.brain.describeScene(frameBase64);
    }

    if (!description) {
      return { proactiveSpeech: null };
    }

    const proactiveSpeech = await this.brain.processContinuousScene(description, personName);
    return { proactiveSpeech };
  }

  @Post('faces/recognize')
  async recognizeFace(
    @Body('descriptor') descriptor?: number[],
  ): Promise<FaceRecognitionResult> {
    if (!Array.isArray(descriptor) || descriptor.length !== 128) {
      throw new BadRequestException(
        'descriptor must be a 128-dimensional number array.',
      );
    }
    return this.memory.recognizeFace(descriptor);
  }

  @Post('faces/register')
  async registerFace(
    @Body('name') name?: string,
    @Body('descriptor') descriptor?: number[],
    @Body('details') details?: Record<string, unknown>,
    @Body('voiceDescriptor') voiceDescriptor?: number[],
    @Body('audioBase64') audioBase64?: string,
  ): Promise<{
    status: string;
    name: string;
    personId: string;
    voiceSaved: boolean;
  }> {
    const start = Date.now();
    this.logger.log(`[faces/register] Received request for "${name ?? 'unknown'}"`);

    if (!name?.trim()) {
      throw new BadRequestException('name is required.');
    }
    if (!Array.isArray(descriptor) || descriptor.length !== 128) {
      throw new BadRequestException(
        'descriptor must be a 128-dimensional number array.',
      );
    }

    let finalVoiceDescriptor = voiceDescriptor;
    if (
      (!finalVoiceDescriptor || finalVoiceDescriptor.length !== 512) &&
      audioBase64?.trim()
    ) {
      try {
        finalVoiceDescriptor = await this.voice.extractEmbeddingFromAudio(audioBase64);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Could not compute voice descriptor from audio: ${msg}`);
      }
    }

    const cleanName = name.trim();
    this.logger.log(`[faces/register] Step 1: Upserting face${finalVoiceDescriptor ? ' + voice' : ''} vector to Qdrant...`);
    const t1 = Date.now();
    const { personId, voiceSaved } = await this.memory.registerFace(
      cleanName,
      descriptor,
      details,
      finalVoiceDescriptor,
    );
    this.logger.log(`[faces/register] Step 1 finished in ${Date.now() - t1}ms (personId: ${personId})`);

    // Run memorizeScene in the background so the user's register API responds immediately
    this.logger.log(`[faces/register] Step 2: Queueing interaction memory in background...`);
    void this.memory
      .memorizeScene(
        `I met ${cleanName} in front of my camera.`,
        { speaker: cleanName, category: 'interaction' },
      )
      .then(() => {
        this.logger.log(`[faces/register] Interaction memory saved for "${cleanName}".`);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`[faces/register] Interaction memory failed: ${msg}`);
      });

    this.logger.log(`[faces/register] Total HTTP response time: ${Date.now() - start}ms`);
    return { status: 'registered', name: cleanName, personId, voiceSaved };
  }

  @Post('voices/recognize')
  async recognizeVoice(
    @Body('descriptor') descriptor?: number[],
  ): Promise<VoiceRecognitionResult> {
    if (!Array.isArray(descriptor) || descriptor.length !== 512) {
      throw new BadRequestException(
        'descriptor must be a 512-dimensional number array.',
      );
    }
    return this.memory.recognizeVoice(descriptor);
  }

  @Post('vision/describe')
  async describeScene(
    @Body('imageBase64') imageBase64?: string,
  ): Promise<{ description: string }> {
    if (!imageBase64?.trim()) {
      throw new BadRequestException('imageBase64 is required.');
    }
    const description = await this.brain.describeScene(imageBase64);
    return { description };
  }
}

