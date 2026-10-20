// strfry's write policy plugin (relay.writePolicy.plugin in strfry.conf): one
// JSON request per line on stdin, one JSON answer per line on stdout, in
// order. The allowlist file the poll service keeps is read again whenever it
// changes; a deletion's targets are looked up on the relay itself.
//
//   EVENTINDEX_RELAY_ALLOWLIST  the allowlist (default /var/lib/eventindex/relay-allowlist.json)
//   EVENTINDEX_RELAY_URL        the relay, for lookups (default ws://127.0.0.1:7777)

import { readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { decide, type Allowlist, type Lookup, type PolicyEvent } from './policy.ts';

const ALLOWLIST = process.env['EVENTINDEX_RELAY_ALLOWLIST'] ?? '/var/lib/eventindex/relay-allowlist.json';
const RELAY = process.env['EVENTINDEX_RELAY_URL'] ?? 'ws://127.0.0.1:7777';
const LOOKUP_TIMEOUT_MS = 3000;
const EMPTY: Allowlist = { index: null, hosted: new Set() };

const log = (line: string) => process.stderr.write(`write policy: ${line}\n`);

let allow = EMPTY;
let stamp = '';

function allowlist(): Allowlist {
  let key: string;
  try {
    const s = statSync(ALLOWLIST);
    key = `${s.ino}:${s.mtimeMs}:${s.size}`;
  } catch {
    if (stamp !== 'missing') log(`${ALLOWLIST} is missing: the index's own keys are refused until it exists`);
    stamp = 'missing';
    allow = EMPTY;
    return allow;
  }
  if (key === stamp) return allow;
  try {
    const data = JSON.parse(readFileSync(ALLOWLIST, 'utf8')) as { index?: string | null; hosted?: string[] };
    allow = { index: data.index ?? null, hosted: new Set(data.hosted ?? []) };
    stamp = key;
    log(`allowlist read: ${allow.hosted.size} hosted`);
  } catch (error) {
    // A file caught mid-write keeps the last good list; the next event retries.
    log(`allowlist unreadable, keeping the last one: ${(error as Error).message}`);
  }
  return allow;
}

// Whether the relay holds the target, by the author.
const lookup: Lookup = (target, author) => new Promise((resolve) => {
  const filter = target.type === 'id'
    ? { ids: [target.id], authors: [author], limit: 1 }
    : { kinds: [target.kind], authors: [author], '#d': [target.d], limit: 1 };
  let found = false;
  let done = false;
  const ws = new WebSocket(RELAY);
  const finish = (result: boolean) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { ws.close(); } catch { /* already closed */ }
    resolve(result);
  };
  const timer = setTimeout(() => finish(false), LOOKUP_TIMEOUT_MS);
  ws.onopen = () => ws.send(JSON.stringify(['REQ', 'policy', filter]));
  ws.onmessage = (message) => {
    const [type] = JSON.parse(String(message.data)) as [string];
    if (type === 'EVENT') found = true;
    if (type === 'EOSE' || type === 'CLOSED') finish(found);
  };
  ws.onerror = () => finish(false);
});

async function answer(line: string): Promise<string> {
  let id: string | undefined;
  try {
    const request = JSON.parse(line) as { type?: string; event?: PolicyEvent; sourceType?: string };
    const event = request.event!;
    id = event.id;
    if (request.type !== 'new') return JSON.stringify({ id, action: 'reject', msg: 'blocked: unknown request' });
    return JSON.stringify({ id, ...(await decide(event, request.sourceType ?? '', allowlist(), lookup)) });
  } catch (error) {
    log(`bad request: ${(error as Error).message}`);
    return JSON.stringify({ id, action: 'reject', msg: 'blocked: unreadable request' });
  }
}

// One answer per request, in the order the requests came.
let queue = Promise.resolve();
createInterface({ input: process.stdin }).on('line', (line) => {
  queue = queue.then(async () => {
    process.stdout.write(`${await answer(line)}\n`);
  });
});
