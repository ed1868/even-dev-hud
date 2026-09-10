import { createApp } from './server.ts';

const PORT = Number(process.env.PORT) || 3000;

const required = ['DATABASE_URL', 'JWT_SECRET', 'VAULT_KEY'] as const;
for (const name of required) {
  if (!process.env[name]) {
    console.error(`[api] ${name} is required`);
    process.exit(1);
  }
}

const app = createApp();

const server = app.listen(PORT, () => {
  console.log(`[api] listening on port ${PORT}`);
});

function shutdown(signal: string): void {
  console.log(`[api] ${signal} — shutting down`);
  server.close(() => process.exit(0));
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
