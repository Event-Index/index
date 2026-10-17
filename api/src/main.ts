// The API and the pages of eventindex.space, on 127.0.0.1 behind nginx.
//
//   node api/src/main.ts
//
// Settings come from the environment (deploy/templates/eventindex.env). The
// service reads index.db, writes only the review queues, and holds no key.

import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { loadSettings } from '../../indexer/src/config.ts';
import { fetchFeed } from '../../indexer/src/poller/fetch.ts';
import { openIndexDb } from '../../indexer/src/store/index-db.ts';
import { directoryStore } from '../../indexer/src/store/directory.ts';
import { queueStore } from '../../indexer/src/store/queues.ts';
import { eventStore } from '../../indexer/src/store/events.ts';
import type { Cities } from '../../indexer/src/service/admin.ts';
import { createApi } from './server.ts';
import { poolReader } from '../../indexer/src/native/read.ts';
import { SimplePool } from 'nostr-tools/pool';
import { useSafeWebSockets } from '../../indexer/src/service/websocket.ts';

function log(line: string): void {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
}

const settings = loadSettings(process.env);
mkdirSync(settings.dataDir, { recursive: true });
// Before any relay pool is made.
useSafeWebSockets();
const db = openIndexDb(settings.indexDb);
const cities = JSON.parse(readFileSync(new URL('../../seeds/cities.json', import.meta.url), 'utf8')) as Cities;
const server = createServer(createApi({
  db,
  dir: directoryStore(db),
  queues: queueStore(db),
  events: eventStore(db),
  settings,
  cities,
  now: () => Math.floor(Date.now() / 1000),
  fetch: (url, validators) => fetchFeed(url, validators),
  reader: poolReader(new SimplePool()),
  log,
}));
server.requestTimeout = 60_000;
server.headersTimeout = 15_000;

server.listen(settings.apiPort, '127.0.0.1', () => log(`api listening on 127.0.0.1:${settings.apiPort}`));
server.on('error', (error) => {
  log(`fatal: ${error.message}`);
  process.exit(1);
});

function stop(signal: string): void {
  log(`${signal}: stopping`);
  server.close(() => {
    db.close();
    log('stopped');
    process.exit(0);
  });
  server.closeIdleConnections();
  setTimeout(() => server.closeAllConnections(), 5000).unref();
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
