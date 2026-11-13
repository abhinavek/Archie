import { Module } from '@nestjs/common';
import { BrainModule } from '../brain/brain.module.js';
import { SensorsGateway } from './sensors.gateway.js';

@Module({
  imports: [BrainModule],
  providers: [SensorsGateway],
  exports: [SensorsGateway],
})
export class GatewayModule {}

