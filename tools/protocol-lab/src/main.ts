import { Lens, hex } from './g2.js';

const logEl = document.getElementById('log')!;
const lenses: Lens[] = [];

function log(line: string): void {
  const stamp = new Date().toLocaleTimeString();
  logEl.textContent = `${stamp}  ${line}\n${logEl.textContent}`.slice(0, 20000);
}

function parseHex(input: string): Uint8Array {
  const tokens = input.trim().split(/[\s,]+/).filter(Boolean);
  const bytes = tokens.map((t) => {
    const n = Number.parseInt(t, 16);
    if (Number.isNaN(n) || n < 0 || n > 0xff) throw new Error(`"${t}" is not a hex byte.`);
    return n;
  });
  return new Uint8Array(bytes);
}

document.getElementById('connect')!.addEventListener('click', async () => {
  try {
    const lens = await Lens.request((name, data) => log(`<- ${name}  ${hex(data)}`));
    lenses.push(lens);
    log(`connected: ${lens.name}  (${lenses.length} lens${lenses.length === 1 ? '' : 'es'})`);
    log('Pair the other temple too — left and right are separate peripherals.');
  } catch (err) {
    log(`connect failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

document.getElementById('disconnect')!.addEventListener('click', async () => {
  await Promise.all(lenses.map((l) => l.disconnect()));
  log(`disconnected ${lenses.length}`);
  lenses.length = 0;
});

document.getElementById('send')!.addEventListener('click', async () => {
  const raw = (document.getElementById('payload') as HTMLInputElement).value;
  if (!lenses.length) return log('no lens connected');
  try {
    const payload = parseHex(raw);
    for (const lens of lenses) {
      const frame = await lens.send(payload);
      log(`-> ${lens.name}  ${hex(frame)}`);
    }
  } catch (err) {
    log(`send failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

log('ready. Chrome + localhost required for Web Bluetooth.');
