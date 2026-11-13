import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { BrainModule } from './brain/brain.module.js';
import { MemoryModule } from './memory/memory.module.js';

function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  for (const key of ['QDRANT_URL', 'OLLAMA_URL']) {
    const val = config[key];
    if (typeof val !== 'string' || val.trim().length === 0) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }
  return config;
}

@Module({
  imports: [
    // Makes ConfigService available across the entire application.
    // Reads from .env at the project root; throws on missing required keys.
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),

    MemoryModule,
    BrainModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
