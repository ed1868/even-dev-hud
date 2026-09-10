import type {
  DeviceInfo,
  DeviceStatus,
  EvenAppBridge,
  LaunchSource,
  UserInfo,
} from '@evenrealities/even_hub_sdk';
import { connect } from './bridge.js';
import { DisposeBag, type Unsubscribe } from './disposable.js';
import { EvenEventRouter } from './events.js';
import { Store } from './storage.js';

/**
 * What a plugin is handed. Everything on it is already connected, so a plugin
 * never has to know about bridge readiness or teardown ordering.
 */
export interface EvenAppContext {
  readonly bridge: EvenAppBridge;
  readonly events: EvenEventRouter;
  /** How the user opened this app: from the phone app menu or the glasses menu. */
  readonly launchSource: LaunchSource | null;
  readonly user: UserInfo;
  readonly device: DeviceInfo | null;
  /** Register teardown here; it runs when the app or the plugin is disposed. */
  readonly onDispose: (fn: Unsubscribe) => Unsubscribe;
  /** Namespaced, JSON-typed wrapper over the host's local storage. */
  store<T extends Record<string, unknown>>(namespace: string, defaults: T): Store<T>;
}

/**
 * A unit of app behaviour. Keeping features as plugins is what makes a second
 * and third app cheap: an app becomes a list of plugins plus a page layout,
 * and a feature that proves useful moves into `packages/` unchanged.
 */
export interface EvenPlugin {
  readonly name: string;
  setup(ctx: EvenAppContext): void | Promise<void>;
  teardown?(): void | Promise<void>;
}

export interface EvenAppOptions {
  plugins?: EvenPlugin[];
  /** How long to wait for the WebView bridge before failing. Default 10s. */
  timeoutMs?: number;
  /** Dispose the app automatically on FOREGROUND_EXIT / ABNORMAL_EXIT / SYSTEM_EXIT. Default true. */
  disposeOnExit?: boolean;
}

export class EvenApp implements EvenAppContext {
  readonly bridge: EvenAppBridge;
  readonly events: EvenEventRouter;
  readonly user: UserInfo;
  readonly device: DeviceInfo | null;

  private bag = new DisposeBag();
  private plugins: EvenPlugin[] = [];
  private _launchSource: LaunchSource | null = null;
  private _deviceStatus: DeviceStatus | null = null;

  private constructor(
    bridge: EvenAppBridge,
    user: UserInfo,
    device: DeviceInfo | null,
    launchSource: LaunchSource | null,
  ) {
    this.bridge = bridge;
    this.user = user;
    this.device = device;
    this._launchSource = launchSource;
    this.events = new EvenEventRouter(bridge);
    this.bag.add(() => this.events.dispose());
  }

  static async start(options: EvenAppOptions = {}): Promise<EvenApp> {
    const { plugins = [], timeoutMs, disposeOnExit = true } = options;
    const bridge = await connect(timeoutMs === undefined ? {} : { timeoutMs });

    // The host pushes launch source exactly once, shortly after load — subscribe
    // before any await that could let us miss it.
    let launchSource: LaunchSource | null = null;
    const seen: Array<(s: LaunchSource) => void> = [];
    const offLaunch = bridge.onLaunchSource((source) => {
      launchSource = source;
      for (const fn of seen) fn(source);
    });

    const [user, device] = await Promise.all([
      bridge.getUserInfo(),
      bridge.getDeviceInfo(),
    ]);

    const app = new EvenApp(bridge, user, device, launchSource);
    app.bag.add(offLaunch);
    app.bag.add(
      bridge.onLaunchSource((source) => {
        app._launchSource = source;
      }),
    );
    app.bag.add(
      bridge.onDeviceStatusChanged((status) => {
        app._deviceStatus = status;
      }),
    );

    if (disposeOnExit) {
      app.bag.add(app.events.on('exit', () => void app.dispose()));
    }

    for (const plugin of plugins) {
      await app.use(plugin);
    }
    return app;
  }

  get launchSource(): LaunchSource | null {
    return this._launchSource;
  }

  /** Latest pushed device status: connection state and battery level. */
  get deviceStatus(): DeviceStatus | null {
    return this._deviceStatus;
  }

  readonly onDispose = (fn: Unsubscribe): Unsubscribe => this.bag.add(fn);

  store<T extends Record<string, unknown>>(namespace: string, defaults: T): Store<T> {
    return new Store<T>(this.bridge, namespace, defaults);
  }

  /** Register a plugin after startup. */
  async use(plugin: EvenPlugin): Promise<void> {
    try {
      await plugin.setup(this);
      this.plugins.push(plugin);
    } catch (err) {
      // One bad plugin should not take down the app; surface it and continue.
      console.error(`[even/core] plugin "${plugin.name}" failed to set up:`, err);
    }
  }

  async dispose(): Promise<void> {
    for (const plugin of [...this.plugins].reverse()) {
      try {
        await plugin.teardown?.();
      } catch (err) {
        console.error(`[even/core] plugin "${plugin.name}" teardown threw:`, err);
      }
    }
    this.plugins = [];
    this.bag.dispose();
  }
}
