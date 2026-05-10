/**
 * GET /api/gui-url
 *
 * Tells the plugin's redirect HTML where to send the user's browser.
 *
 * The container has no native way to know its own publicly-reachable URL —
 * the plugin discovers it via signalk-container's `resolveContainerAddress()`
 * after `ensureRunning()` and plumbs it in via the `GUI_PUBLIC_URL` env var.
 *
 * If the env var is unset (e.g. running the container directly during dev),
 * the container falls back to constructing a URL from the request's Host
 * header, which works for browser-direct access too.
 */

import { Router } from 'express';
import { config } from '../config/index.js';

export const guiRouter: Router = Router();

guiRouter.get('/', (req, res) => {
  if (config.guiPublicUrl) {
    res.json({ url: config.guiPublicUrl });
    return;
  }

  const host = req.get('host') ?? `localhost:${config.port}`;
  const proto = req.protocol;
  res.json({ url: `${proto}://${host}/` });
});
