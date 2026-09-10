import { EvenApp, isEvenAppWebView } from '@even/core';
import { PageBuilder, Screen } from '@even/ui';
import { fail, log } from './log.js';
import { batteryPlugin } from './plugins/battery.js';
import { headTiltPlugin } from './plugins/head-tilt.js';

const MENU_TOGGLE_TILT = 1;
const MENU_QUIT = 2;

async function main(): Promise<void> {
  if (!isEvenAppWebView()) {
    log('Not inside the Even App WebView — nothing to talk to.');
    log('Run `npm run qr -w @even/hello-hud` and scan it from the Even app.');
    return;
  }

  const app = await EvenApp.start();
  log(`bridge ready · user=${app.user.name ?? 'unknown'} · launch=${app.launchSource ?? 'pending'}`);

  // Lay the glasses page out first: every other glasses call, including the
  // microphone, requires a startup page to exist.
  const page = new PageBuilder()
    .text({ name: 'title', x: 20, y: 20, width: 380, height: 40, content: 'Hello HUD', brightness: 4 })
    .text({ name: 'status', x: 20, y: 70, width: 380, height: 40, content: 'starting…' })
    .text({ name: 'tilt', x: 20, y: 120, width: 380, height: 40, content: '' })
    // Exactly one container takes focus, or the page receives no input at all.
    .list({ name: 'menu', x: 20, y: 170, width: 380, height: 80, items: ['Reset', 'About'], focus: true })
    .menuItem('Toggle tilt', MENU_TOGGLE_TILT)
    .menuItem('Quit', MENU_QUIT);

  const screen = await Screen.mount(app.bridge, page);
  log('glasses page mounted');

  await app.use(batteryPlugin(screen, 'status'));

  let tilt = headTiltPlugin(screen, 'tilt');
  await app.use(tilt);

  app.events.on('list', (event) => {
    log(`list: ${event.currentSelectItemName ?? '?'} (#${event.currentSelectItemIndex ?? -1})`);
  });

  app.events.on('menu', async (event) => {
    log(`menu item ${event.itemID}`);
    if (event.itemID === MENU_TOGGLE_TILT) {
      await tilt.teardown?.();
      tilt = headTiltPlugin(screen, 'tilt');
      await app.use(tilt);
    } else if (event.itemID === MENU_QUIT) {
      await app.dispose();
      await screen.close(0);
    }
  });

  app.events.on('longPress', ({ pressed, source }) => {
    log(`long press ${pressed ? 'down' : 'up'} from ${String(source)}`);
  });

  app.events.on('exit', (sys) => log(`host exit event: ${String(sys.eventType)}`));
}

main().catch(fail);
