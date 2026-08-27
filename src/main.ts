import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';
import { AppModule } from './app.module';
import { adminPathRewrite } from './admin/admin-path';
import { config } from './config/config';
import { ScrubbingLogger, logLevels } from './privacy/logger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Registered explicitly below rather than accepting the defaults, so the
    // limits are visible. Uploads never come through here — multer streams
    // multipart straight to disk, which is what keeps a 90 MB upload from
    // living in the RAM of a Pi.
    bodyParser: false,
    // Redacts file IDs, tokens, IP addresses and imported URLs on the way to
    // the journal. See privacy/logger.ts — a log is a record of who fetched
    // what, and this app should not be keeping one.
    logger: config.privacy.scrubLogs
      ? new ScrubbingLogger('stego', { logLevels: logLevels() })
      : logLevels(),
  });

  // Both deliberately tiny: the only JSON body is an import request and the
  // only form post is an unlock passphrase.
  app.useBodyParser('json', { limit: '64kb' });
  app.useBodyParser('urlencoded', { extended: false, limit: '16kb' });

  /**
   * Off unless the operator says otherwise. With `trust proxy` on, Express
   * believes `X-Forwarded-For`, and on a directly-reachable origin any client
   * can put a fresh value in it on every request and walk straight through
   * every rate limit in the app.
   */
  app.set('trust proxy', config.trustProxy ? 1 : false);

  // Express advertises itself by default. There is no reason to tell a
  // scanner what is running here.
  app.getHttpAdapter().getInstance().disable('x-powered-by');

  // Ahead of everything else: maps the configured admin path onto the
  // controller's fixed internal prefix. See admin/admin-path.ts.
  app.use(adminPathRewrite);

  app.use((req: any, res: any, next: () => void) => {
    // Non-negotiable. Every Content-Type we send is a deliberate choice made
    // in common/mime.ts; nosniff stops the browser from overriding it and
    // executing an uploaded file as HTML on our own origin.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');

    /**
     * The pages this app serves load a stylesheet and two scripts, all from
     * this origin, and nothing else — no CDN, no analytics, no fonts. So the
     * policy can be as tight as a policy gets, and there is not a single
     * inline script anywhere to carve an exception for.
     *
     * `connect-src 'self'` matters specifically for the end-to-end reader:
     * even if a page here were compromised, it could not post the decryption
     * key it holds to anywhere else.
     */
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "object-src 'self'",
        "frame-src 'self'",
        "connect-src 'self'",
        "form-action 'self'",
        "base-uri 'none'",
        "frame-ancestors 'self'",
      ].join('; '),
    );

    // Nothing here needs a camera, a microphone, a location or a payment
    // handler. Saying so explicitly costs one header.
    res.setHeader(
      'Permissions-Policy',
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=(), interest-cohort=()',
    );

    // Cross-origin isolation. CORP in particular stops another site from
    // hotlinking a file here into its own document.
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

    if (config.privacy.noIndex) {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, noimageindex');
    }

    // A precise clock is a fingerprinting signal and a correlation aid for
    // anyone matching a request here against a capture elsewhere. Express
    // sends `Date` regardless; this at least stops us adding to it.
    res.removeHeader('Server');

    next();
  });

  if (config.corsOrigins.length > 0) {
    app.enableCors({
      origin: config.corsOrigins,
      methods: ['GET', 'HEAD', 'POST', 'DELETE'],
      maxAge: 600,
    });
  }

  // The upload UI. Served from disk so it stays plain HTML/CSS.
  app.useStaticAssets(join(__dirname, '..', 'public'), {
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'public, max-age=300');
    },
  });

  // 0.0.0.0 so the Pi is reachable from the LAN and from a tunnel daemon.
  await app.listen(config.port, '0.0.0.0');

  const logger = new Logger('Bootstrap');
  logger.log(`stego listening on :${config.port}`);
  logger.log(`data directory   ${config.dataDir}`);
  logger.log(
    `privacy: at-rest ${config.privacy.encryptAtRest ? 'on' : 'OFF'}, ` +
      `metadata strip ${config.privacy.stripMetadata ? 'on' : 'OFF'}, ` +
      `noindex ${config.privacy.noIndex ? 'on' : 'OFF'}, ` +
      `rate limit ${config.rateLimit.enabled ? 'on' : 'OFF'}`,
  );
}

void bootstrap();
