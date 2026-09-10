import { config, assertRuntimeConfig } from './config.ts';
import { db, closeDb } from './db.ts';
import { startScheduler } from './collectors/registry.ts';
import { createShimServer } from './server.ts';
import { assertPortAvailable } from './preflight.ts';

/**
 * Entry point. Opens the store, starts the collector scheduler, then serves.
 * The scheduler runs every collector once immediately so a fresh start has data
 * before the first request rather than an empty screen.
 */
assertRuntimeConfig();
// Fail with a message that names the offending PID rather than an EADDRINUSE trace.
await assertPortAvailable(config.port, config.host);
db();

const stopScheduler = startScheduler();
const server = createShimServer();

server.listen(config.port, config.host, () => {
  console.log(`[shim] listening on http://${config.host}:${config.port}`);
  console.log(`[shim] store  ${config.db.path}`);
  const gh = config.github.accounts;
  console.log(
    `[shim] sources cron=on sessions=${config.openclaw.gatewayToken ? 'on' : 'unconfigured'} ` +
      `github=${gh.length ? gh.map((a) => `${a.name}(${a.repos.length})`).join(' ') : 'unconfigured'}`,
  );
  if (config.allowedOrigins.length === 0) {
    console.warn('[shim] HUD_ALLOWED_ORIGINS is empty — set it once you know what the device sends.');
  }
});

function shutdown(signal: string): void {
  console.log(`[shim] ${signal} — shutting down`);
  stopScheduler();
  server.close(() => {
    closeDb();
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
