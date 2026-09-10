import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { pool } from './db/pool.ts';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function vaultKey(): Buffer {
  const hex = process.env.VAULT_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('VAULT_KEY must be a 64-character hex string (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

export function encrypt(plaintext: string): string {
  const key = vaultKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${encrypted.toString('hex')}:${tag.toString('hex')}`;
}

export function decrypt(stored: string): string {
  const key = vaultKey();
  const [ivHex, ciphertextHex, tagHex] = stored.split(':');
  if (!ivHex || !ciphertextHex || !tagHex) {
    throw new Error('malformed encrypted value');
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

export async function storeToken(
  userId: string,
  provider: string,
  name: string,
  token: string,
  config: Record<string, unknown> = {},
): Promise<void> {
  const encryptedToken = encrypt(token);
  await pool.query(
    `INSERT INTO user_tokens (user_id, provider, name, encrypted_token, config)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, provider, name) DO UPDATE SET
       encrypted_token = EXCLUDED.encrypted_token,
       config = EXCLUDED.config,
       updated_at = now()`,
    [userId, provider, name, encryptedToken, JSON.stringify(config)],
  );
}

export async function getToken(
  userId: string,
  provider: string,
  name: string,
): Promise<{ token: string; config: Record<string, unknown> } | null> {
  const { rows } = await pool.query<{ encrypted_token: string; config: Record<string, unknown> }>(
    'SELECT encrypted_token, config FROM user_tokens WHERE user_id = $1 AND provider = $2 AND name = $3',
    [userId, provider, name],
  );
  if (!rows[0]) return null;
  return { token: decrypt(rows[0].encrypted_token), config: rows[0].config };
}

export type TokenInfo = {
  provider: string;
  name: string;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export async function listTokens(userId: string): Promise<TokenInfo[]> {
  const { rows } = await pool.query<TokenInfo>(
    `SELECT provider, name, config, created_at, updated_at
     FROM user_tokens WHERE user_id = $1 ORDER BY provider, name`,
    [userId],
  );
  return rows;
}

export async function deleteToken(userId: string, provider: string, name: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    'DELETE FROM user_tokens WHERE user_id = $1 AND provider = $2 AND name = $3',
    [userId, provider, name],
  );
  return (rowCount ?? 0) > 0;
}
