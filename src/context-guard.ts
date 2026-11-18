/**
 * Context revocation guards.
 *
 * Extracted from runner.ts: the proxy machinery that makes every object the
 * test context hands out throw `TestContextRevokedError` once the test
 * reaches a terminal state. The contract it implements is documented in
 * docs/api.md ("実行中の時間制限と中断"); the safety invariants — no new
 * dispatch after revocation, method references captured earlier included —
 * are unchanged by the move.
 */
import type { AfterEffects } from "@ido-bata/ae-a8n";

import { TestContextRevokedError } from "./fixture.js";

/**
 * Shared state for one guarded object graph: the revocation check plus an
 * identity cache, so the same underlying object always yields the same
 * proxy and cyclic graphs cannot recurse forever.
 */
type GuardState = {
  readonly isRevoked: () => boolean;
  readonly seen: WeakMap<object, unknown>;
};

/**
 * The session — and everything reachable from it — as the test body may see
 * it.
 *
 * `AfterEffects` and the objects its methods return (`Project`, `Comp`,
 * `Layer`, `Effect`, `Parameter`, …) keep their state in private fields, so
 * they cannot be subclassed or re-wrapped method by method. Instead every
 * object the context hands out is proxied: while the test is live the proxy
 * is transparent (methods are applied to the real target so private fields
 * keep working, and promise results are guarded in turn, which is what
 * covers derived handles a body held on to); once `isRevoked` reports the
 * test's terminal state, any further use throws `TestContextRevokedError`
 * before a call can be dispatched.
 *
 * Symbol-keyed access other than `Symbol.asyncDispose` still reaches the
 * target: it is introspection (inspection, runtime internals), not host
 * work. `Symbol.asyncDispose` performs a real close, so it is revoked too.
 *
 * The check runs twice for a method: once when the property is read and
 * again when the retrieved function is invoked. A body that held
 * `const set = parameter.set` before the terminal state would otherwise
 * keep a live dispatch path past revocation — reading a property is not
 * the same event as calling it.
 *
 * Introspection traps (`getOwnPropertyDescriptor`, `getPrototypeOf`, …)
 * are deliberately not guarded: they can surface raw members, but those
 * members need the target's private fields as `this`, which only the
 * proxy's traps can supply — a raw reference cannot dispatch.
 */
export function guardSession(
  session: AfterEffects,
  isRevoked: () => boolean,
): AfterEffects {
  return guardValue(session, { isRevoked, seen: new WeakMap() });
}

/** Guards any context-owned value the same way `guardSession` guards `ae`. */
export function guardContext<T>(value: T, isRevoked: () => boolean): T {
  return guardValue(value, { isRevoked, seen: new WeakMap() });
}

function guardValue<T>(value: T, state: GuardState): T {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return value;
  }
  const cached = state.seen.get(value);
  if (cached !== undefined) {
    return cached as T;
  }
  const proxy = new Proxy(value, {
    get(target, property) {
      assertContextActive(property, state);
      const member: unknown = Reflect.get(target, property);
      if (typeof member === "function") {
        const callable = member as (this: unknown, ...args: unknown[]) => unknown;
        return (...args: unknown[]) => {
          assertContextInvocable(state);
          return guardCallResult(callable.apply(target, args), state);
        };
      }
      return guardValue(member, state);
    },
    set(target, property, member) {
      assertContextActive(property, state);
      return Reflect.set(target, property, member);
    },
    defineProperty(target, property, descriptor) {
      assertContextActive(property, state);
      return Reflect.defineProperty(target, property, descriptor);
    },
    deleteProperty(target, property) {
      assertContextActive(property, state);
      return Reflect.deleteProperty(target, property);
    },
    setPrototypeOf(target, prototype) {
      assertContextInvocable(state);
      return Reflect.setPrototypeOf(target, prototype);
    },
    preventExtensions(target) {
      assertContextInvocable(state);
      return Reflect.preventExtensions(target);
    },
    apply(target, thisArg, args) {
      assertContextInvocable(state);
      return guardCallResult(
        Reflect.apply(
          target as unknown as (this: unknown, ...inner: unknown[]) => unknown,
          thisArg,
          args,
        ),
        state,
      );
    },
    construct(target, args, newTarget) {
      assertContextInvocable(state);
      return guardCallResult(
        Reflect.construct(
          target as unknown as new (...inner: unknown[]) => object,
          args,
          newTarget,
        ),
        state,
      ) as object;
    },
  });
  state.seen.set(value, proxy);
  return proxy;
}

/**
 * Guards what a call produced: a promise's resolved value is guarded too,
 * which is how `openProject().then(project => …)` stays inside the contract.
 */
function guardCallResult(result: unknown, state: GuardState): unknown {
  if (isThenable(result)) {
    return Promise.resolve(result).then((resolved) => guardValue(resolved, state));
  }
  return guardValue(result, state);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function assertContextActive(property: string | symbol, state: GuardState): void {
  if (!state.isRevoked()) {
    return;
  }
  if (typeof property === "string" || property === Symbol.asyncDispose) {
    throw new TestContextRevokedError();
  }
}

/**
 * The call-time half of the contract. A function retrieved before
 * revocation — a method reference, a promise's `then`, a callable host
 * object — reaches the host only through here, so invocation is refused
 * outright once the context is dead. Unlike property reads, calling is
 * never introspection, so no symbol carve-out applies.
 */
function assertContextInvocable(state: GuardState): void {
  if (state.isRevoked()) {
    throw new TestContextRevokedError();
  }
}

