import { Router, type Request, type Response } from 'express';
import { pool } from '../db/pool.ts';

export const healthRouter = Router();

healthRouter.get('/health', async (_req: Request, res: Response) => {
  let dbOk = false;
  try {
    await pool.query('SELECT 1');
    dbOk = true;
  } catch { /* db down */ }

  res.json({
    ok: dbOk,
    db: dbOk ? 'up' : 'down',
    now: Date.now(),
  });
});
