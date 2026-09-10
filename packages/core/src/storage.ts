import type { EvenAppBridge } from '@evenrealities/even_hub_sdk';

/**
 * `getLocalStorage` / `setLocalStorage` are string-only, and a missing key comes
 * back as an empty string rather than null. This wraps both in a typed,
 * JSON-encoded namespace so app state survives a page rebuild.
 */
export class Store<T extends Record<string, unknown>> {
  constructor(
    private bridge: EvenAppBridge,
    private namespace: string,
    private defaults: T,
  ) {}

  private key<K extends keyof T & string>(k: K): string {
    return `${this.namespace}:${k}`;
  }

  async get<K extends keyof T & string>(k: K): Promise<T[K]> {
    const raw = await this.bridge.getLocalStorage(this.key(k));
    if (!raw) return this.defaults[k];
    try {
      return JSON.parse(raw) as T[K];
    } catch {
      console.warn(`[even/core] store key "${k}" held invalid JSON; using default.`);
      return this.defaults[k];
    }
  }

  async set<K extends keyof T & string>(k: K, value: T[K]): Promise<boolean> {
    return this.bridge.setLocalStorage(this.key(k), JSON.stringify(value));
  }

  /** Read every declared key in one pass. */
  async all(): Promise<T> {
    const keys = Object.keys(this.defaults) as (keyof T & string)[];
    const values = await Promise.all(keys.map((k) => this.get(k)));
    const out = { ...this.defaults };
    keys.forEach((k, i) => {
      out[k] = values[i] as T[typeof k];
    });
    return out;
  }
}
