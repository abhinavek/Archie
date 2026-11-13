import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/memory.module.js';
import { BrainController } from './brain.controller.js';
import { BrainService } from './brain.service.js';
import { VoiceService } from './voice.service.js';

@Module({
  imports: [MemoryModule, HttpModule],
  controllers: [BrainController],
  providers: [BrainService, VoiceService],
  exports: [BrainService, VoiceService],
})
export class BrainModule {}

