/**
 * A pushable async iterable.
 *
 * The Agent SDK's `query()` accepts an `AsyncIterable<SDKUserMessage>` as its prompt to
 * enable interactive, multi-turn input. This helper lets the runner push user messages into
 * that iterable at any time (when the browser sends one) and close it on shutdown.
 */

/**
 * Create a pushable async iterable.
 *
 * @returns {{ push: (item:any)=>void, end: ()=>void, [Symbol.asyncIterator]: ()=>AsyncIterator<any> }}
 *
 * @example
 *   const q = createPushableAsyncIterable();
 *   q.push({ type: "user", message: { role: "user", content: "hello" } });
 *   for await (const item of q) { console.log(item); }  // yields the pushed item
 */
export function createPushableAsyncIterable() {
  /** @type {any[]} */
  const buffer = [];
  /** @type {((result:{value:any,done:boolean})=>void)|null} */
  let pendingResolve = null;
  let ended = false;

  return {
    push(item) {
      if (ended) {
        return;
      }
      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve({ value: item, done: false });
      } else {
        buffer.push(item);
      }
    },
    end() {
      ended = true;
      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (buffer.length > 0) {
            return Promise.resolve({ value: buffer.shift(), done: false });
          }
          if (ended) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            pendingResolve = resolve;
          });
        },
        return() {
          ended = true;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}
