import type { Request, Response } from 'express';
import { config } from '../config/config';

/**
 * The panel's path is configurable (`STEGO_ADMIN_PATH`), but Nest route
 * decorators are evaluated once when the class is defined, long before any
 * config could reach them. So the controller is registered on a fixed
 * internal prefix and this rewrites the configured path onto it.
 *
 * It has to run before the Nest router, which is why it is installed with a
 * bare `app.use` in main.ts rather than through a module's `configure()` —
 * middleware bound there is matched against the route table, and a path that
 * is not in the route table never reaches it.
 *
 * Moving the panel to `/some-word-nobody-will-guess` is not a security
 * control on its own; the password is. What it does is take the instance out
 * of every scanner wordlist at once, and automated probing is most of what a
 * home server ever sees.
 */
export const INTERNAL_ADMIN_PREFIX = '/__admin';

export function adminPathRewrite(req: Request, res: Response, next: () => void): void {
  const path = req.url.split('?')[0];

  // The internal prefix is only ever produced by the rewrite below. A client
  // asking for it directly is probing, and gets the same 404 as any other
  // unrouted path.
  if (path === INTERNAL_ADMIN_PREFIX || path.startsWith(`${INTERNAL_ADMIN_PREFIX}/`)) {
    res.status(404).end();
    return;
  }

  if (path === config.admin.path) {
    req.url = INTERNAL_ADMIN_PREFIX + req.url.slice(config.admin.path.length);
  } else if (path.startsWith(`${config.admin.path}/`)) {
    req.url = INTERNAL_ADMIN_PREFIX + req.url.slice(config.admin.path.length);
  }

  next();
}
