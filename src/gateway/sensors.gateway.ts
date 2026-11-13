import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { BrainService } from '../brain/brain.service.js';

@WebSocketGateway({
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
})
export class SensorsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(SensorsGateway.name);
  private isAiBusy = false;

  constructor(private readonly brainService: BrainService) {}

  handleConnection(client: Socket): void {
    this.logger.log(`[SensorsGateway] Client connected: ${client.id}`);
    client.emit('ai-status', this.isAiBusy ? 'thinking' : 'idle');
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`[SensorsGateway] Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('stream-frame')
  async handleStreamFrame(
    client: Socket,
    payload: Buffer | ArrayBuffer | string,
  ): Promise<void> {
    try {
      // Normalize raw binary payload (Buffer or ArrayBuffer) or Base64 string
      let base64Image: string;
      if (Buffer.isBuffer(payload)) {
        base64Image = payload.toString('base64');
      } else if (payload instanceof ArrayBuffer) {
        base64Image = Buffer.from(payload).toString('base64');
      } else if (typeof payload === 'string') {
        base64Image = payload.replace(/^data:image\/[a-z]+;base64,/, '').trim();
      } else {
        return;
      }

      if (!base64Image || base64Image.length < 50) return;

      // 1. Instantly update in-memory live frame for instant VQA ("What am I holding?")
      this.brainService.updateLatestFrame(base64Image);

      // 2. Concurrency Lock: Drop heavy frame if AI is already analyzing
      if (this.isAiBusy) {
        return;
      }

      // 3. Lock engaged: notify camera clients to pause sending AI frames
      this.isAiBusy = true;
      this.server.emit('ai-status', 'thinking');

      // 4. Asynchronously process single-pass vision in background
      this.processBackgroundVision(base64Image)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(`[SensorsGateway] Vision processing failed: ${msg}`);
        })
        .finally(() => {
          // 5. Release lock and notify clients to resume streaming
          this.isAiBusy = false;
          this.server.emit('ai-status', 'idle');
        });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[SensorsGateway] Error handling stream frame: ${msg}`);
    }
  }

  private async processBackgroundVision(base64Image: string): Promise<void> {
    const proactiveSpeech = await this.brainService.analyzeLiveScene(base64Image);
    if (proactiveSpeech && proactiveSpeech.trim().length > 0) {
      this.logger.log(`[SensorsGateway] Proactive Speech Triggered: "${proactiveSpeech}"`);
      // Broadcast to frontend and audio daemons
      this.server.emit('speak', proactiveSpeech);
    }
  }
}

