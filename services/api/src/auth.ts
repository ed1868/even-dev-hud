import { type Request, type Response, type NextFunction, Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from './db/pool.ts';

const SALT_ROUNDS = 12;

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required');
  return secret;
}

export type AuthPayload = { sub: string; email: string };

function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, jwtSecret(), { expiresIn: '7d' });
}

function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, jwtSecret()) as AuthPayload;
}

export const authRouter = Router();

authRouter.post('/register', async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: 'password must be at least 8 characters' });
    return;
  }

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    res.status(409).json({ error: 'email already registered' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
    [email, passwordHash],
  );

  const user = rows[0]!;
  const token = signToken({ sub: user.id, email });
  res.status(201).json({ token, userId: user.id });
});

authRouter.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }

  const { rows } = await pool.query<{ id: string; password_hash: string }>(
    'SELECT id, password_hash FROM users WHERE email = $1',
    [email],
  );
  if (!rows[0]) {
    res.status(401).json({ error: 'invalid credentials' });
    return;
  }

  const valid = await bcrypt.compare(password, rows[0].password_hash);
  if (!valid) {
    res.status(401).json({ error: 'invalid credentials' });
    return;
  }

  const token = signToken({ sub: rows[0].id, email });
  res.json({ token, userId: rows[0].id });
});

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing authorization header' });
    return;
  }

  try {
    const payload = verifyToken(header.slice(7).trim());
    (req as Request & { userId: string; userEmail: string }).userId = payload.sub;
    (req as Request & { userId: string; userEmail: string }).userEmail = payload.email;
    next();
  } catch {
    res.status(401).json({ error: 'invalid or expired token' });
  }
}
