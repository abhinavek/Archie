import { setDefaultResultOrder } from 'node:dns';
import { setDefaultAutoSelectFamily } from 'node:net';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

setDefaultResultOrder('ipv4first');
setDefaultAutoSelectFamily(false);

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    cors: {
      origin: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: true,
    },
  });
  await app.listen(process.env.PORT ?? 3001);
}
await bootstrap();
