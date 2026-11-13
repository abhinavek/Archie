import fs from 'node:fs';
import path from 'node:path';
import { setDefaultResultOrder } from 'node:dns';
import { setDefaultAutoSelectFamily } from 'node:net';
import { NestFactory } from '@nestjs/core';
import dotenv from 'dotenv';
import { AppModule } from './app.module.js';

// Load .env before bootstrapping so process.env is populated for HTTPS options
dotenv.config();

setDefaultResultOrder('ipv4first');
setDefaultAutoSelectFamily(false);

async function bootstrap() {
  const isHttps = process.env.ENABLE_HTTPS === 'true';
  const keyPath = path.resolve(process.cwd(), 'ayinu-frontend/key.pem');
  const certPath = path.resolve(process.cwd(), 'ayinu-frontend/cert.pem');

  let httpsOptions: { key: Buffer; cert: Buffer } | undefined;
  if (isHttps) {
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      httpsOptions = {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
      };
      console.log('🔒 HTTPS enabled on backend using ayinu-frontend SSL certificates');
    } else {
      console.warn('⚠️ ENABLE_HTTPS=true but certificates not found at:', keyPath);
    }
  } else {
    console.log('🌐 HTTP mode enabled on backend (ENABLE_HTTPS is false or unset)');
  }

  const app = await NestFactory.create(AppModule, {
    httpsOptions,
    cors: {
      origin: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: true,
    },
  });
  const port = process.env.PORT ?? 3001;
  await app.listen(port, '0.0.0.0');
}
await bootstrap();
