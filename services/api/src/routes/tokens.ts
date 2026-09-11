import { Router, type Request, type Response } from 'express';
import { storeToken, listTokens, deleteToken } from '../vault.ts';

export const tokensRouter = Router();

type AuthedRequest = Request & { userId: string };

tokensRouter.get('/', async (req: Request, res: Response) => {
  const { userId } = req as AuthedRequest;
  const tokens = await listTokens(userId);
  res.json({ tokens });
});

tokensRouter.post('/', async (req: Request, res: Response) => {
  const { userId } = req as AuthedRequest;
  const { provider, name, token, config } = req.body as {
    provider?: string;
    name?: string;
    token?: string;
    config?: Record<string, unknown>;
  };

  if (!provider || !name || !token) {
    res.status(400).json({ error: 'provider, name, and token are required' });
    return;
  }

  await storeToken(userId, provider, name, token, config ?? {});
  res.status(201).json({ ok: true });
});

tokensRouter.delete('/:provider/:name', async (req: Request, res: Response) => {
  const { userId } = req as AuthedRequest;
  const provider = String(req.params.provider ?? '');
  const name = String(req.params.name ?? '');

  if (!provider || !name) {
    res.status(400).json({ error: 'provider and name are required' });
    return;
  }

  const deleted = await deleteToken(userId, provider, name);
  if (!deleted) {
    res.status(404).json({ error: 'token not found' });
    return;
  }
  res.json({ ok: true });
});
