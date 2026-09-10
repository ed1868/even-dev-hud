import {
  OsEventTypeList,
  type AudioEvent,
  type EvenAppBridge,
  type EvenHubEvent,
  type IMU_Report_Data,
  type List_ItemEvent,
  type MenuItemClickEvent,
  type Sys_ItemEvent,
  type Text_ItemEvent,
} from '@evenrealities/even_hub_sdk';
import { DisposeBag, type Unsubscribe } from './disposable.js';

/**
 * `onEvenHubEvent` is a single firehose: list, text, sys, audio, and contextual
 * menu payloads all arrive on it, and the interesting sys events (IMU samples,
 * long press) are nested one level deeper. Every app ends up rewriting the same
 * `if (event.listEvent)` ladder, so the router does it once.
 */
export type EvenEventMap = {
  list: List_ItemEvent;
  text: Text_ItemEvent;
  sys: Sys_ItemEvent;
  audio: AudioEvent;
  menu: MenuItemClickEvent;
  imu: IMU_Report_Data;
  /** `true` on press, `false` on release. */
  longPress: { pressed: boolean; source: Sys_ItemEvent['eventSource'] };
  /** The host is tearing the page down: FOREGROUND_EXIT, ABNORMAL_EXIT, SYSTEM_EXIT. */
  exit: Sys_ItemEvent;
  /** Anything the router did not recognise, for debugging. */
  raw: EvenHubEvent;
};

export type EvenEventName = keyof EvenEventMap;
type Handler<K extends EvenEventName> = (payload: EvenEventMap[K]) => void;

const EXIT_EVENTS = new Set<OsEventTypeList>([
  OsEventTypeList.FOREGROUND_EXIT_EVENT,
  OsEventTypeList.ABNORMAL_EXIT_EVENT,
  OsEventTypeList.SYSTEM_EXIT_EVENT,
]);

export class EvenEventRouter {
  private handlers = new Map<EvenEventName, Set<(p: never) => void>>();
  private bag = new DisposeBag();

  constructor(bridge: EvenAppBridge) {
    this.bag.add(bridge.onEvenHubEvent((event) => this.dispatch(event)));
  }

  on<K extends EvenEventName>(name: K, handler: Handler<K>): Unsubscribe {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(handler as (p: never) => void);
    return () => {
      set!.delete(handler as (p: never) => void);
    };
  }

  /** Resolve on the next matching event. Useful for `await router.once('menu')`. */
  once<K extends EvenEventName>(name: K): Promise<EvenEventMap[K]> {
    return new Promise((resolve) => {
      const off = this.on(name, (payload) => {
        off();
        resolve(payload);
      });
    });
  }

  private emit<K extends EvenEventName>(name: K, payload: EvenEventMap[K]): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        (handler as Handler<K>)(payload);
      } catch (err) {
        console.error(`[even/core] "${name}" handler threw:`, err);
      }
    }
  }

  private dispatch(event: EvenHubEvent): void {
    this.emit('raw', event);

    if (event.listEvent) this.emit('list', event.listEvent);
    if (event.textEvent) this.emit('text', event.textEvent);
    if (event.audioEvent) this.emit('audio', event.audioEvent);
    if (event.menuItemClickEvent) this.emit('menu', event.menuItemClickEvent);

    const sys = event.sysEvent;
    if (!sys) return;
    this.emit('sys', sys);

    switch (sys.eventType) {
      case OsEventTypeList.IMU_DATA_REPORT:
        if (sys.imuData) this.emit('imu', sys.imuData);
        break;
      case OsEventTypeList.LONG_PRESS_EVENT:
        this.emit('longPress', { pressed: true, source: sys.eventSource });
        break;
      case OsEventTypeList.LONG_PRESS_RELEASE_EVENT:
        this.emit('longPress', { pressed: false, source: sys.eventSource });
        break;
      default:
        break;
    }

    if (sys.eventType !== undefined && EXIT_EVENTS.has(sys.eventType)) {
      this.emit('exit', sys);
    }
  }

  dispose(): void {
    this.bag.dispose();
    this.handlers.clear();
  }
}
