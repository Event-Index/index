import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { SimplePool } from 'nostr-tools/pool';
import { closingOnce, useSafeWebSockets } from '../src/service/websocket.ts';

test('a WebSocket closed again from its own error handler closes once', () => {
  // As Node's WebSocket does while its connection fails: closing it fires
  // `error` again, at once.
  let closes = 0;
  class Failing {
    onerror: (() => void) | null = null;
    close(): void {
      closes += 1;
      if (closes > 100) throw new RangeError('Maximum call stack size exceeded');
      this.onerror?.();
    }
  }
  const Safe = closingOnce(Failing);
  const ws = new Safe();
  ws.onerror = () => ws.close();
  ws.onerror();
  assert.equal(closes, 1);
});

test('a relay that fails its handshake is answered as unreachable, and the process goes on', async () => {
  // It answers the upgrade with an HTTP error, as a broken relay does.
  const server = createServer((socket) => socket.once('data', () => socket.end('HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const relay = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  // As every service does when it starts.
  useSafeWebSockets();
  const pool = new SimplePool();
  try {
    const found = await pool.querySync([relay], { kinds: [31923], limit: 1 }, { maxWait: 2000 });
    assert.deepEqual(found, []);
  } finally {
    pool.close([relay]);
    server.close();
  }
});
