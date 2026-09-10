import { Router, type Request, type Response } from 'express';
import { pool } from '../db/pool.ts';
import { listTokens } from '../vault.ts';

export const settingsRouter = Router();

type AuthedRequest = Request & { userId: string; userEmail: string };

settingsRouter.get('/', async (req: Request, res: Response) => {
  const { userId, userEmail } = req as AuthedRequest;
  const tokens = await listTokens(userId);

  const activeSources = tokens.reduce<Record<string, string[]>>((acc, t) => {
    if (!acc[t.provider]) acc[t.provider] = [];
    acc[t.provider]!.push(t.name);
    return acc;
  }, {});

  res.json({
    userId,
    email: userEmail,
    activeSources,
  });
});

settingsRouter.put('/', async (req: Request, res: Response) => {
  const { userId } = req as AuthedRequest;
  const { config } = req.body as { config?: Record<string, unknown> };

  if (!config) {
    res.status(400).json({ error: 'config object is required' });
    return;
  }

  // user_tokens.config is per-token; a user-wide settings row would go in a
  // dedicated table. For now, update the config on each referenced token.
  for (const [provider, cfg] of Object.entries(config)) {
    if (typeof cfg !== 'object' || cfg === null) continue;
    const providerConfig = cfg as Record<string, unknown>;
    const name = (providerConfig.name as string) ?? 'default';
    await pool.query(
      `UPDATE user_tokens SET config = $1, updated_at = now()
       WHERE user_id = $2 AND provider = $3 AND name = $4`,
      [JSON.stringify(providerConfig), userId, provider, name],
    );
  }

  res.json({ ok: true });
});
