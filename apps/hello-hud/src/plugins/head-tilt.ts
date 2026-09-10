import { ImuReportPace, type EvenAppBridge, type EvenPlugin } from '@even/core';
import type { Screen } from '@even/ui';
import { log } from '../log.js';

/**
 * Streams IMU samples and shows head tilt. The IMU reports far faster than the
 * glasses display should be redrawn, so samples are throttled to one text update
 * per `updateMs`.
 */
export function headTiltPlugin(
  screen: Screen,
  containerName: string,
  options: { pace?: ImuReportPace; updateMs?: number } = {},
): EvenPlugin {
  const { pace = ImuReportPace.P500, updateMs = 500 } = options;
  let timer: ReturnType<typeof setInterval> | undefined;
  let latest: { x: number; y: number; z: number } | null = null;
  let bridge: EvenAppBridge | null = null;

  return {
    name: 'head-tilt',
    async setup(ctx) {
      const enabled = await ctx.bridge.imuControl(true, pace);
      if (!enabled) {
        log('head-tilt: imuControl returned false; is the glasses page up?');
        return;
      }
      // Only hold the bridge once the IMU is actually on, so teardown knows
      // whether it has anything to switch off.
      bridge = ctx.bridge;

      ctx.onDispose(
        ctx.events.on('imu', (data) => {
          latest = { x: data.x ?? 0, y: data.y ?? 0, z: data.z ?? 0 };
        }),
      );

      timer = setInterval(() => {
        if (!latest) return;
        const { x, y, z } = latest;
        void screen
          .setText(containerName, `tilt  x ${x.toFixed(1)}  y ${y.toFixed(1)}  z ${z.toFixed(1)}`)
          .catch((err) => log(`head-tilt: ${err}`));
      }, updateMs);
      ctx.onDispose(() => clearInterval(timer));
    },
    async teardown() {
      clearInterval(timer);
      if (bridge) {
        await bridge.imuControl(false);
        bridge = null;
      }
    },
  };
}
