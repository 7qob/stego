import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';
import { AppModule } from './app.module';
import { config } from './config/config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Uploads can be large and slow over a home connection; let Express
    // stream them rather than buffering a parsed body.
    bodyParser: true,
  });

  app.use((_req: unknown, res: any, next: () => void) => {
    // Non-negotiable. Every Content-Type we send is a deliberate choice made
    // in common/mime.ts; nosniff stops the browser from overriding it and
    // executing an uploaded file as HTML on our own origin.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // The upload UI. Served from disk so it stays plain HTML/CSS.
  app.useStaticAssets(join(__dirname, '..', 'public'));

  // 0.0.0.0 so the Pi is reachable from the LAN and from a tunnel daemon.
  await app.listen(config.port, '0.0.0.0');

  const logger = new Logger('Bootstrap');
  logger.log(`stego listening on :${config.port}`);
  logger.log(`public base URL ${config.baseUrl}`);
  logger.log(`data directory   ${config.dataDir}`);
}

void bootstrap();
