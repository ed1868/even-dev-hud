const el = () => document.getElementById('log');

/** Phone-side panel. You cannot read logs off the glasses, so transitions land here. */
export function log(line: string): void {
  const node = el();
  const stamp = new Date().toLocaleTimeString();
  if (node) node.textContent = `${stamp}  ${line}\n${node.textContent ?? ''}`.slice(0, 8000);
  console.log(`[dev-hud] ${line}`);
}

export function fail(err: unknown): void {
  const node = el();
  if (node) {
    node.classList.add('err');
    node.textContent = String(err instanceof Error ? (err.stack ?? err.message) : err);
  }
  console.error(err);
}
