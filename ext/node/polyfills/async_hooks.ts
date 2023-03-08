// Copyright 2018-2023 the Deno authors. All rights reserved. MIT license.
// Copyright Joyent and Node contributors. All rights reserved. MIT license.

// This implementation is inspired by "workerd" AsyncLocalStorage implementation:
// https://github.com/cloudflare/workerd/blob/77fd0ed6ddba184414f0216508fc62b06e716cab/src/workerd/api/node/async-hooks.c++#L9

import { validateFunction } from "ext:deno_node/internal/validators.mjs";
import { core } from "ext:deno_node/_core.ts";

function assert(cond: boolean) {
  if (!cond) throw new Error("Assertion failed");
}
const asyncContextStack: AsyncContextFrame[] = [];

function pushAsyncFrame(frame: AsyncContextFrame) {
  asyncContextStack.push(frame);
}

function popAsyncFrame() {
  assert(asyncContextStack.length > 0);
  asyncContextStack.pop();
}

let rootAsyncFrame: AsyncContextFrame | undefined = undefined;
let promiseHooksSet = false;

const asyncContext = Symbol("asyncContext");
function isRejected(promise: Promise<unknown>) {
  const [state] = core.getPromiseDetails(promise);
  return state == 2;
}

function setPromiseHooks() {
  if (promiseHooksSet) {
    return;
  }
  promiseHooksSet = true;

  const init = (promise: Promise<unknown>) => {
    const currentFrame = AsyncContextFrame.current();
    if (!currentFrame.isRoot()) {
      assert(AsyncContextFrame.tryGetContext(promise) == null);
      AsyncContextFrame.attachContext(promise);
    }
  };
  const before = (promise: Promise<unknown>) => {
    const maybeFrame = AsyncContextFrame.tryGetContext(promise);
    if (maybeFrame) {
      pushAsyncFrame(maybeFrame);
    } else {
      pushAsyncFrame(AsyncContextFrame.getRootAsyncContext());
    }
  };
  const after = (promise: Promise<unknown>) => {
    popAsyncFrame();
    if (!isRejected(promise)) {
      // @ts-ignore promise async context
      delete promise[asyncContext];
    }
  };
  const resolve = (promise: Promise<unknown>) => {
    const currentFrame = AsyncContextFrame.current();
    if (
      !currentFrame.isRoot() && isRejected(promise) &&
      AsyncContextFrame.tryGetContext(promise) == null
    ) {
      AsyncContextFrame.attachContext(promise);
    }
  };

  core.setPromiseHooks(init, before, after, resolve);
}

class AsyncContextFrame {
  storage: StorageEntry[];
  constructor(
    maybeParent?: AsyncContextFrame | null,
    maybeStorageEntry?: StorageEntry | null,
    isRoot = false,
  ) {
    this.storage = [];

    setPromiseHooks();

    const propagate = (parent: AsyncContextFrame) => {
      parent.storage = parent.storage.filter((entry) => !entry.key.isDead());
      parent.storage.forEach((entry) => this.storage.push(entry));

      if (maybeStorageEntry) {
        const existingEntry = this.storage.find((entry) =>
          entry.key === maybeStorageEntry.key
        );
        if (existingEntry) {
          existingEntry.value = maybeStorageEntry.value;
        } else {
          this.storage.push(maybeStorageEntry);
        }
      }
    };

    if (!isRoot) {
      if (maybeParent) {
        propagate(maybeParent);
      } else {
        propagate(AsyncContextFrame.current());
      }
    }
  }

  static tryGetContext(promise: Promise<unknown>) {
    // @ts-ignore promise async context
    return promise[asyncContext];
  }

  static attachContext(promise: Promise<unknown>) {
    assert(!(asyncContext in promise));
    // @ts-ignore promise async context
    promise[asyncContext] = AsyncContextFrame.current();
  }

  static getRootAsyncContext() {
    if (typeof rootAsyncFrame !== "undefined") {
      return rootAsyncFrame;
    }

    rootAsyncFrame = new AsyncContextFrame(null, null, true);
    return rootAsyncFrame;
  }

  static current() {
    if (asyncContextStack.length === 0) {
      return AsyncContextFrame.getRootAsyncContext();
    }

    return asyncContextStack[asyncContextStack.length - 1];
  }

  static create(
    maybeParent?: AsyncContextFrame | null,
    maybeStorageEntry?: StorageEntry | null,
  ) {
    return new AsyncContextFrame(maybeParent, maybeStorageEntry);
  }

  static wrap(
    fn: () => unknown,
    maybeFrame: AsyncContextFrame | undefined,
    // deno-lint-ignore no-explicit-any
    thisArg: any,
  ) {
    // deno-lint-ignore no-explicit-any
    return (...args: any) => {
      const frame = maybeFrame || AsyncContextFrame.current();
      Scope.enter(frame);
      try {
        return fn.apply(thisArg, args);
      } finally {
        Scope.exit();
      }
    };
  }

  get(key: StorageKey) {
    assert(!key.isDead());
    this.storage = this.storage.filter((entry) => !entry.key.isDead());
    const entry = this.storage.find((entry) => entry.key === key);
    if (entry) {
      return entry.value;
    }
    return undefined;
  }

  isRoot() {
    return AsyncContextFrame.getRootAsyncContext() == this;
  }
}

export class AsyncResource {
  frame: AsyncContextFrame;
  type: string;
  constructor(type: string) {
    this.type = type;
    this.frame = AsyncContextFrame.current();
  }

  runInAsyncScope(
    fn: (...args: unknown[]) => unknown,
    thisArg: unknown,
    ...args: unknown[]
  ) {
    Scope.enter(this.frame);

    try {
      return fn.apply(thisArg, args);
    } finally {
      Scope.exit();
    }
  }

  bind(fn: (...args: unknown[]) => unknown, thisArg = this) {
    validateFunction(fn, "fn");
    const frame = AsyncContextFrame.current();
    const bound = AsyncContextFrame.wrap(fn, frame, thisArg);

    Object.defineProperties(bound, {
      "length": {
        configurable: true,
        enumerable: false,
        value: fn.length,
        writable: false,
      },
      "asyncResource": {
        configurable: true,
        enumerable: true,
        value: this,
        writable: true,
      },
    });
    return bound;
  }

  static bind(
    fn: (...args: unknown[]) => unknown,
    type?: string,
    thisArg?: AsyncResource,
  ) {
    type = type || fn.name;
    return (new AsyncResource(type || "AsyncResource")).bind(fn, thisArg);
  }
}

class Scope {
  static enter(maybeFrame?: AsyncContextFrame) {
    if (maybeFrame) {
      pushAsyncFrame(maybeFrame);
    } else {
      pushAsyncFrame(AsyncContextFrame.getRootAsyncContext());
    }
  }

  static exit() {
    popAsyncFrame();
  }
}

class StorageEntry {
  key: StorageKey;
  value: unknown;
  constructor(key: StorageKey, value: unknown) {
    this.key = key;
    this.value = value;
  }
}

class StorageKey {
  #dead = false;

  reset() {
    this.#dead = true;
  }

  isDead() {
    return this.#dead;
  }
}

const fnReg = new FinalizationRegistry((key: StorageKey) => {
  key.reset();
});

export class AsyncLocalStorage {
  #key;

  constructor() {
    this.#key = new StorageKey();
    fnReg.register(this, this.#key);
  }

  // deno-lint-ignore no-explicit-any
  run(store: any, callback: any, ...args: any[]): any {
    const frame = AsyncContextFrame.create(
      null,
      new StorageEntry(this.#key, store),
    );
    Scope.enter(frame);
    let res;
    try {
      res = callback(...args);
    } finally {
      Scope.exit();
    }
    return res;
  }

  // deno-lint-ignore no-explicit-any
  exit(callback: (...args: unknown[]) => any, ...args: any[]): any {
    return this.run(undefined, callback, args);
  }

  // deno-lint-ignore no-explicit-any
  getStore(): any {
    const currentFrame = AsyncContextFrame.current();
    return currentFrame.get(this.#key);
  }
}

export function executionAsyncId() {
  return 1;
}

class AsyncHook {
  enable() {
  }

  disable() {
  }
}

export function createHook() {
  return new AsyncHook();
}

// Placing all exports down here because the exported classes won't export
// otherwise.
export default {
  // Embedder API
  AsyncResource,
  executionAsyncId,
  createHook,
  AsyncLocalStorage,
};
