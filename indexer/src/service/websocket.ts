// Node's WebSocket fires `error` again when it is closed while its connection
// is failing, and nostr-tools closes it from its error handler: the two call
// each other until the stack overflows and the process exits. Every relay
// pool uses a WebSocket that closes once and ignores the calls after.

import { useWebSocketImplementation } from 'nostr-tools/pool';

type Closable = new (...args: any[]) => { close(code?: number, reason?: string): void };

export function closingOnce<T extends Closable>(Base: T): T {
  return class extends Base {
    #closed = false;
    override close(code?: number, reason?: string): void {
      if (this.#closed) return;
      this.#closed = true;
      super.close(code, reason);
    }
  };
}

export const SafeWebSocket = closingOnce(globalThis.WebSocket);

// For every pool made from here on.
export function useSafeWebSockets(): void {
  useWebSocketImplementation(SafeWebSocket);
}
