import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MemoryService } from './memory.service.js';

@Module({
  imports: [HttpModule],
  providers: [MemoryService],
  exports: [MemoryService], // exported so BrainModule can inject it later
})
export class MemoryModule {}
