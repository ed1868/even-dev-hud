const el = () => document.getElementById('log')!;

export function log(line: string): void {
  const node = el();
  const stamp = new Date().toLocaleTimeString();
  node.textContent = `${stamp}  ${line}\n${node.textContent}`.slice(0, 8000);
  console.log(`[hello-hud] ${line}`);
}

export function fail(err: unknown): void {
  const node = el();
  node.classList.add('err');
  node.textContent = String(err instanceof Error ? err.stack ?? err.message : err);
  console.error(err);
}
