import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';

/**
 * Refuse to start on a port someone else already owns, and say *who* owns it.
 *
 * This has bitten twice in this project — once with `even-terminal`, once with
 * the shim. The shape is always the same: an old instance holds the port, the
 * new one fails to bind, and you spend twenty minutes debugging a `401` from a
 * process running yesterday's token. Node's default `EADDRINUSE` stack trace
 * does not mention that a *different process* is the problem, which is the one
 * fact you need.
 */

export type PortHolder = { pid: number; command: string; startedAt: string };

/** Who is listening on this port, if anyone. macOS `lsof`; returns null elsewhere. */
export function portHolder(port: number): PortHolder | null {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const pid = Number(out.split('\n')[0]);
    if (!Number.isInteger(pid) || pid <= 0) return null;

    const ps = execFileSync('ps', ['-p', String(pid), '-o', 'lstart=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    // `lstart` is a fixed 24-char field; the rest is the command line.
    const startedAt = ps.slice(0, 24).trim();
    const command = ps.slice(24).trim();
    return { pid, command, startedAt };
  } catch {
    return null;
  }
}

export function portIsFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

/**
 * Called before the real server binds. Exits with an actionable message rather
 * than a stack trace, because the fix is always "kill the other process" and the
 * message should just say so.
 */
export async function assertPortAvailable(port: number, host: string): Promise<void> {
  if (await portIsFree(port, host)) return;

  const holder = portHolder(port);
  const lines = [
    '',
    `  Port ${port} is already in use — refusing to start a second instance.`,
    '',
  ];

  if (holder) {
    lines.push(
      `  Held by PID ${holder.pid}, started ${holder.startedAt}`,
      `    ${holder.command.slice(0, 100)}`,
      '',
      `  If that is older than your last edit, it is a stale process serving old`,
      `  config — most likely an old token, which shows up as a mysterious 401.`,
      '',
      `    kill ${holder.pid}          # then start again`,
    );
  } else {
    lines.push(`  Could not identify the owner. Try:  lsof -nP -iTCP:${port} -sTCP:LISTEN`);
  }

  lines.push(`    HUD_PORT=7778 npm start   # or just use a different port`, '');
  console.error(lines.join('\n'));
  process.exit(1);
}
