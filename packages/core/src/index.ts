export { connect, resetConnection, isEvenAppWebView, BridgeUnavailableError } from './bridge.js';
export { DisposeBag, type Unsubscribe } from './disposable.js';
export {
  EvenEventRouter,
  type EvenEventMap,
  type EvenEventName,
} from './events.js';
export { Store } from './storage.js';
export {
  EvenApp,
  type EvenAppContext,
  type EvenAppOptions,
  type EvenPlugin,
} from './app.js';

// Re-export the SDK surface so apps import from one place and the SDK version
// is pinned in exactly one package.json.
export * from '@evenrealities/even_hub_sdk';
