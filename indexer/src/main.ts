// The poll service: one long-running process per data directory.
//
//   node indexer/src/main.ts          run until SIGTERM
//   node indexer/src/main.ts --once   run one tick and exit
//
// Settings come from the environment (deploy/templates/eventindex.env).

import { mkdirSync, readFileSync } from 'node:fs';
import { useSafeWebSockets } from './service/websocket.ts';
import { decode, npubEncode } from 'nostr-tools/nip19';
import { getPublicKey } from 'nostr-tools/pure';
import { loadSettings } from './config.ts';
import { acquireLock } from './service/lock.ts';
import { createIndexer } from './service/indexer.ts';
import { relayPublisher, relayPauses } from './service/publisher.ts';
import { fetchFeed } from './poller/fetch.ts';
import { hostPacer } from './enrich/pace.ts';
import { openIndexDb } from './store/index-db.ts';
import { openVault } from './store/vault-db.ts';
import { directoryStore } from './store/directory.ts';
import { queueStore } from './store/queues.ts';
import { eventStore } from './store/events.ts';
import { poolReader } from './native/read.ts';
import { nip46Signers } from './claim/signer.ts';
import { SimplePool } from 'nostr-tools/pool';

const TICK_SECONDS = 30;
// Requests to meetup.com, feeds and event pages alike, start 5 s apart.
const MEETUP = hostPacer({ hosts: ['meetup.com'], intervalMs: 5000 });
const PAGE_ACCEPT = 'text/html, application/xhtml+xml;q=0.9, */*;q=0.1';

function log(line: string): void {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
}

function readIndexKey(path: string): Uint8Array {
  const decoded = decode(readFileSync(path, 'utf8').trim());
  if (decoded.type !== 'nsec') throw new Error(`${path} does not hold an nsec`);
  return decoded.data;
}

function readSecret(path: string): Uint8Array {
  const hex = readFileSync(path, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`${path} must hold 64 hex digits`);
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

async function main(): Promise<void> {
  useSafeWebSockets();
  const once = process.argv.includes('--once');
  const settings = loadSettings(process.env);
  mkdirSync(settings.dataDir, { recursive: true });
  const lock = acquireLock(settings.lockFile);
  const db = openIndexDb(settings.indexDb);
  const vault = openVault(settings.vaultDb, readSecret(settings.signerSecretFile));
  const indexKey = readIndexKey(settings.indexKeyFile);
  const dir = directoryStore(db);
  const publisher = relayPublisher(settings, log, { pauses: relayPauses(dir) });
  // Organizers' own events are read on a pool of their own.
  const readPool = new SimplePool();
  const controller = new AbortController();
  const stop = (signal: string) => {
    if (controller.signal.aborted) return;
    log(`${signal}: stopping after the current poll`);
    controller.abort();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  const indexer = createIndexer({
    db,
    dir,
    queues: queueStore(db),
    events: eventStore(db),
    vault,
    indexKey,
    settings,
    now: () => Math.floor(Date.now() / 1000),
    fetch: MEETUP.wrap((url, validators) => fetchFeed(url, validators)),
    fetchPage: MEETUP.wrap((url, validators) => fetchFeed(url, validators, { accept: PAGE_ACCEPT })),
    publisher,
    reader: poolReader(readPool),
    signers: nip46Signers(readPool),
    // Between pages read from one relay.
    pause: () => new Promise((resolve) => setTimeout(resolve, 300)),
    log,
    signal: controller.signal,
    listedPages: (JSON.parse(readFileSync(new URL('../../seeds/luma-pages.json', import.meta.url), 'utf8')) as { pages: Array<{ slug: string; url: string }> }).pages,
  });
  log(`indexer started as ${npubEncode(getPublicKey(indexKey))}; general relays ${settings.publishToGeneralRelays ? 'on' : 'off'}; claimants ${settings.hostClaimants ? 'hosted' : 'not hosted'} on the relay; NIP-52 ingestion ${settings.ingestNip52 ? 'on' : 'off'}; Meetup pages ${settings.meetupPages ? 'read' : 'not read'}`);

  try {
    while (!controller.signal.aborted) {
      try {
        const report = await indexer.tick();
        if (report.polled.length || report.removed.length) {
          log(`tick: polled ${report.polled.length}, failed ${report.failed.length}, removed ${report.removed.length}, published ${report.published}`);
        }
      } catch (error) {
        log(`tick failed: ${(error as Error).stack ?? error}`);
      }
      if (once) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, TICK_SECONDS * 1000);
        controller.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
  } finally {
    publisher.close();
    readPool.destroy();
    vault.close();
    db.close();
    lock.release();
    log('stopped');
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    log(`fatal: ${(error as Error).message}`);
    process.exit(1);
  },
);
