import { DeviceConnectType, type EvenPlugin } from '@even/core';
import type { Screen } from '@even/ui';
import { log } from '../log.js';

/**
 * Mirrors glasses connection state and battery level into a text container.
 * Written as a plugin rather than inline so the next app can reuse it by adding
 * one line to its plugin list.
 */
export function batteryPlugin(screen: Screen, containerName: string): EvenPlugin {
  return {
    name: 'battery',
    setup(ctx) {
      const render = (connected: boolean, level?: number) => {
        const text = connected ? `G2 connected · ${level ?? '--'}%` : 'G2 disconnected';
        void screen.setText(containerName, text).catch((err) => log(`battery: ${err}`));
      };

      // Paint whatever we already know before the first push arrives.
      render(Boolean(ctx.device), undefined);

      ctx.onDispose(
        ctx.bridge.onDeviceStatusChanged((status) => {
          render(status.connectType === DeviceConnectType.Connected, status.batteryLevel);
          log(`device status: ${String(status.connectType)} battery=${String(status.batteryLevel)}`);
        }),
      );
    },
  };
}
