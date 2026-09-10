import {
  waitForEvenAppBridge,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk';

/**
 * The SDK only works inside the Even App WebView, where the host injects
 * `window.flutter_inappwebview.callHandler`. In a plain desktop browser
 * `waitForEvenAppBridge()` never resolves, which reads as a hang rather than a
 * clear error — so we detect the host up front.
 */
export function isEvenAppWebView(): boolean {
  const w = globalThis as unknown as {
    flutter_inappwebview?: { callHandler?: unknown };
  };
  return typeof w.flutter_inappwebview?.callHandler === 'function';
}

export class BridgeUnavailableError extends Error {
  constructor() {
    super(
      'Not running inside the Even App WebView. Open this page from the Even app ' +
        '(`evenhub qr`) or run it against the simulator.',
    );
    this.name = 'BridgeUnavailableError';
  }
}

let pending: Promise<EvenAppBridge> | null = null;

/**
 * Resolve the singleton bridge. Rejects fast when the host is absent instead of
 * hanging, and caches the in-flight promise so concurrent callers share one wait.
 */
export function connect(options: { timeoutMs?: number } = {}): Promise<EvenAppBridge> {
  const { timeoutMs = 10_000 } = options;

  if (!isEvenAppWebView()) {
    return Promise.reject(new BridgeUnavailableError());
  }
  if (pending) return pending;

  pending = new Promise<EvenAppBridge>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending = null;
      reject(new Error(`Bridge did not become ready within ${timeoutMs}ms.`));
    }, timeoutMs);

    waitForEvenAppBridge().then(
      (bridge) => {
        clearTimeout(timer);
        resolve(bridge);
      },
      (err) => {
        clearTimeout(timer);
        pending = null;
        reject(err);
      },
    );
  });

  return pending;
}

/** Test seam: drop the cached bridge promise. */
export function resetConnection(): void {
  pending = null;
}
