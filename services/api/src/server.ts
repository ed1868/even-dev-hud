import express from 'express';
import { authRouter, requireAuth } from './auth.ts';
import { healthRouter } from './routes/health.ts';
import { tokensRouter } from './routes/tokens.ts';
import { settingsRouter } from './routes/settings.ts';
import { dataRouter } from './routes/data.ts';

export function createApp(): express.Express {
  const app = express();

  app.use(express.json({ limit: '1mb' }));

  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('access-control-max-age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use('/v1', healthRouter);
  app.use('/auth', authRouter);
  app.use('/v1/tokens', requireAuth, tokensRouter);
  app.use('/v1/settings', requireAuth, settingsRouter);
  app.use('/v1', requireAuth, dataRouter);

  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error('[api]', err);
      res.status(500).json({ error: err.message });
    },
  );

  return app;
}
