/**
 * Every SDK `on*` subscription returns an unsubscribe function. Apps that
 * forget to call them leak listeners across page rebuilds, so all of `@even/core`
 * funnels teardown through this one type.
 */
export type Unsubscribe = () => void;

/** Collects teardown functions so a whole feature can be torn down in one call. */
export class DisposeBag {
  private fns: Unsubscribe[] = [];
  private disposed = false;

  add(fn: Unsubscribe): Unsubscribe {
    if (this.disposed) {
      fn();
      return () => {};
    }
    this.fns.push(fn);
    return () => {
      const i = this.fns.indexOf(fn);
      if (i >= 0) {
        this.fns.splice(i, 1);
        fn();
      }
    };
  }

  get size(): number {
    return this.fns.length;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Tear down in reverse order so later subscriptions that depend on earlier
    // ones are removed first.
    for (const fn of this.fns.reverse()) {
      try {
        fn();
      } catch (err) {
        console.error('[even/core] dispose handler threw:', err);
      }
    }
    this.fns = [];
  }
}
