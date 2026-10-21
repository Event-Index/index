// The maintainer's commands. They read and change index.db only; the poll
// service publishes the changes on its next tick.
//
//   node indexer/src/admin.ts status
//   node indexer/src/admin.ts import-seeds seeds/luma/new-york.json ... [--cities seeds/cities.json]
//     (a seed list, or seeds/communities.json)
//   node indexer/src/admin.ts import-aggregators [--cities seeds/cities.json] [--only <slug>,...]
//   node indexer/src/admin.ts discoveries [--hours <n>]
//   node indexer/src/admin.ts coverage [--pubkey <hex or npub>] [--relay <wss://…>] [--save]
//   node indexer/src/admin.ts submissions
//   node indexer/src/admin.ts approve-submission <id> [--city <slug>]
//   node indexer/src/admin.ts reject-submission <id>
//   node indexer/src/admin.ts approvals
//   node indexer/src/admin.ts undo-approval <id>
//   node indexer/src/admin.ts removals
//   node indexer/src/admin.ts approve-removal <id>
//   node indexer/src/admin.ts reject-removal <id>
//   node indexer/src/admin.ts remove <local name or d> [--message <text>]
//   node indexer/src/admin.ts claims
//   node indexer/src/admin.ts approve-claim <id>
//   node indexer/src/admin.ts reject-claim <id>
//   node indexer/src/admin.ts aggregator <npub or hex>
//   node indexer/src/admin.ts relays
//   node indexer/src/admin.ts pause-relay <wss://…> [--hours <n>]
//   node indexer/src/admin.ts resume-relay <wss://…>
//
// Settings come from the environment, as for the services.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SimplePool } from 'nostr-tools/pool';
import { decode, npubEncode } from 'nostr-tools/nip19';
import { loadSettings, type Settings } from './config.ts';
import { openIndexDb } from './store/index-db.ts';
import { directoryStore } from './store/directory.ts';
import { queueStore } from './store/queues.ts';
import { eventStore } from './store/events.ts';
import { importSeeds, importCommunities, importAggregators, importGancio, approveSubmission, rejectSubmission, approveRemoval, rejectRemoval, removeCalendar, approveClaim, rejectClaim, markAggregator, status, undoApproval, type AdminStores, type Cities, type Communities, type GancioList } from './service/admin.ts';
import type { Seed } from './directory/seed.ts';
import { relayPauses, PAUSE_SECONDS } from './service/publisher.ts';
import { discoveredStore, type Found } from './store/discovered.ts';
import { coverage, formatCoverage, upcomingReferences } from './service/coverage.ts';
import { decodeGeohash } from './project/geohash.ts';
import { useSafeWebSockets } from './service/websocket.ts';
import { nativeD } from './directory/id.ts';
import { eventPagesStore } from './store/event-pages.ts';

const USAGE = `usage: admin.ts <command>
  status
  import-seeds <seed.json>... [--cities <cities.json>]
  import-aggregators [--cities <cities.json>] [--only <slug>,...]
  import-gancio <gancio.json>
  discoveries [--hours <n>]
  coverage [--pubkey <hex or npub>] [--relay <wss://…>] [--save]
  submissions
  approve-submission <id> [--city <slug>]
  reject-submission <id>
  approvals
  undo-approval <id>
  removals
  approve-removal <id>
  reject-removal <id>
  remove <local name or d> [--message <text>]
  claims
  approve-claim <id>
  reject-claim <id>
  aggregator <npub or hex>
  relays
  pause-relay <wss://…> [--hours <n>]
  resume-relay <wss://…>
  meetup-pages [resume]`;

class UsageError extends Error {}

const out = (line: string) => process.stdout.write(`${line}\n`);
const time = (t: number | null) => (t === null ? '-' : new Date(t * 1000).toISOString().replace('.000', ''));

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined) throw new UsageError(`${name} needs a value`);
  args.splice(at, 2);
  return value;
}

function id(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) throw new UsageError('an id is a number');
  return Number(value);
}

function readCities(path: string | undefined): Cities {
  const file = path ?? join(dirname(fileURLToPath(import.meta.url)), '../../seeds/cities.json');
  return JSON.parse(readFileSync(file, 'utf8')) as Cities;
}

function run(s: AdminStores, command: string | undefined, args: string[], now: number): void {
  switch (command) {
    case 'status': {
      const r = status(s, now);
      out(`index key       ${r.indexPubkey ?? '(the poll service has not run)'}`);
      out(`calendars       ${r.calendars} (${r.neverPolled} not yet polled)`);
      out(`aggregators     ${r.aggregators}`);
      out(`removed         ${r.removed}`);
      out(`kept unlisted   ${r.unlisted} (nostr publishers with no upcoming event)`);
      out(`stale           ${r.stale.length}${r.stale.length ? `: ${r.stale.join(', ')}` : ''}`);
      out(`upcoming events ${r.upcomingEvents}`);
      out(`submissions     ${r.pendingSubmissions} pending`);
      out(`remove requests ${r.pendingRemovals} pending`);
      out(`claims          ${r.pendingClaims} pending`);
      out(`last dump       ${time(r.lastDump)}`);
      return;
    }
    case 'import-seeds': {
      const cities = readCities(option(args, '--cities'));
      if (args.length === 0) throw new UsageError('import-seeds needs at least one seed list');
      const files = args.map((path) => JSON.parse(readFileSync(path, 'utf8')) as Seed | Communities);
      const r = { filed: [] as string[], existing: [] as string[], blocked: [] as string[], native: [] as string[] };
      const seeds = files.filter((f): f is Seed => !('communities' in f));
      const add = (x: Partial<typeof r>) => { for (const k of Object.keys(r) as Array<keyof typeof r>) r[k].push(...(x[k] ?? [])); };
      add(importSeeds(s, seeds, cities, now));
      for (const list of files.filter((f): f is Communities => 'communities' in f)) add(importCommunities(s, list, cities, now));
      for (const d of r.blocked) out(`not filed (do-not-index): ${d}`);
      for (const name of r.native) out(`native publisher, not filed: ${name}`);
      out(`filed ${r.filed.length}, already listed ${r.existing.length}, on the do-not-index list ${r.blocked.length}`);
      return;
    }
    case 'import-gancio': {
      if (!args[0]) throw new UsageError('import-gancio needs the Gancio list (seeds/gancio.json)');
      const r = importGancio(s, JSON.parse(readFileSync(args[0], 'utf8')) as GancioList, now);
      for (const d of r.blocked) out(`not filed (do-not-index): ${d}`);
      out(`filed ${r.filed.length} Gancio instances, already listed ${r.existing.length}, on the do-not-index list ${r.blocked.length}`);
      return;
    }
    case 'import-aggregators': {
      const cities = readCities(option(args, '--cities'));
      const only = option(args, '--only')?.split(',').map((x) => x.trim()).filter(Boolean);
      const r = importAggregators(s, cities, now, only);
      for (const d of r.blocked) out(`not filed (do-not-index): ${d}`);
      out(`filed ${r.filed.length} aggregator${r.filed.length === 1 ? '' : 's'}, already listed ${r.existing.length}, on the do-not-index list ${r.blocked.length}`);
      return;
    }
    case 'discoveries': {
      // What discovery found in the last hours: what it filed, skipped,
      // refused and still has to check, by page. A skip shows what the page
      // showed of the calendar, for review.
      const hours = Number(option(args, '--hours') ?? 24);
      if (!(hours > 0)) throw new UsageError('--hours needs a positive number');
      const found = discoveredStore(s.db).since(now - Math.round(hours * 3600));
      const label: Record<Found['status'], string> = { filed: 'filed', skipped: 'skipped', refused: 'refused', candidate: 'waiting' };
      const counts = (list: Found[]) => {
        const n = (status: Found['status']) => list.filter((f) => f.status === status).length;
        return `filed ${n('filed')}, skipped ${n('skipped')}, refused ${n('refused')}, waiting ${n('candidate')}`;
      };
      for (const place of [...new Set(found.map((f) => f.place))]) {
        const list = found.filter((f) => f.place === place);
        const entry = s.dir.get(place);
        out(`${entry?.location?.replace(/, [A-Z]{2}$/, '') ?? place} (${place}): ${counts(list)}`);
        for (const f of list) {
          const extra = f.status === 'filed' || f.status === 'candidate' ? [] : [f.reason ?? '-'];
          if (f.status === 'skipped' && f.detail) {
            if (f.detail.event) extra.push(f.detail.event);
            if (f.detail.hosts?.length) extra.push(`hosts: ${f.detail.hosts.join(', ')}`);
            if (f.detail.url) extra.push(f.detail.url);
          }
          out(`  ${label[f.status].padEnd(8)} ${[f.d, f.name ?? '-', ...extra].join('  ')}`);
        }
      }
      const skipped = found.filter((f) => f.status === 'skipped');
      out(`in all: ${counts(found).replace(/skipped (\d+)/, `skipped $1 (${skipped.filter((f) => f.reason === 'platform-default-calendar').length} platform default, ${skipped.filter((f) => f.reason === 'not-public').length} not public)`)}`);
      return;
    }
    case 'submissions':
      for (const sub of s.queues.submissions('pending')) {
        const where = sub.source === 'nostr' ? `${npubEncode(sub.d.slice('nostr:'.length))} (filed by its key)` : sub.feedUrl;
        out(`${sub.id}\t${time(sub.submittedAt)}\t${sub.source}\t${sub.role}\t${sub.name ?? '-'}${sub.platformDefault ? ' (platform default calendar: only its owner should submit it)' : ''}\t${sub.city ?? '-'}\t${where}`);
      }
      return;
    case 'approve-submission': {
      const city = option(args, '--city');
      const { d } = approveSubmission(s, id(args[0]), city ? { city } : {}, readCities(undefined), now);
      out(`filed ${d}; the poll service polls and publishes it at its next tick, within a minute`);
      return;
    }
    case 'approvals':
      // Submissions the index approved itself, newest first.
      for (const sub of s.queues.autoApproved()) out(`${sub.id}\t${time(sub.resolvedAt)}\t${sub.d}\t${sub.name ?? '-'}\t${sub.feedUrl}`);
      return;
    case 'undo-approval': {
      const r = undoApproval(s, id(args[0]), now);
      out(`remove request ${r.id} approved; the poll service removes the calendar on its next tick`);
      return;
    }
    case 'reject-submission':
      rejectSubmission(s, id(args[0]), now);
      out('rejected');
      return;
    case 'removals':
      for (const r of s.queues.removals('pending')) {
        const entry = s.dir.get(r.d);
        out(`${r.id}\t${time(r.requestedAt)}\t${r.verifiedAt ? 'token in feed' : 'token not seen'}\t${entry?.localName ?? r.d}\t${entry?.name ?? '-'}\t${entry?.feedUrl ?? '-'}`);
        if (r.message) out(`\tmessage: ${r.message.replace(/\s+/g, ' ')}`);
      }
      return;
    case 'approve-removal':
      approveRemoval(s, id(args[0]), now);
      out('approved; the poll service removes the calendar on its next tick');
      return;
    case 'reject-removal':
      rejectRemoval(s, id(args[0]), now);
      out('rejected');
      return;
    case 'remove': {
      const message = option(args, '--message') ?? null;
      if (!args[0]) throw new UsageError('remove needs a local name or d');
      const r = removeCalendar(s, args[0], message, now);
      out(`remove request ${r.id} approved; the poll service removes the calendar on its next tick`);
      return;
    }
    case 'claims':
      for (const c of s.queues.claims('pending')) {
        const entry = s.dir.get(c.d);
        const proof = c.verifiedBy === 'nip05' ? `NIP-05 ${c.nip05}` : c.verifiedBy === 'token' ? 'token in feed' : 'not shown yet';
        const mode = c.mode === 'own' ? 'publishes itself' : 'publish as them';
        out(`${c.id}\t${time(c.requestedAt)}\t${proof}\t${mode}\t${entry?.localName ?? c.d}\t${entry?.name ?? '-'}\t${npubEncode(c.pubkey)}`);
      }
      return;
    case 'approve-claim':
      approveClaim(s, id(args[0]), now);
      out('approved; the poll service hands the calendar to its organizer on its next tick');
      return;
    case 'reject-claim':
      rejectClaim(s, id(args[0]), now);
      out('rejected');
      return;
    case 'aggregator': {
      const arg = args[0] ?? '';
      const pubkey = arg.startsWith('npub1') ? (decode(arg as `npub1${string}`).data as string) : arg;
      if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new UsageError('aggregator needs an npub or a hex key');
      markAggregator(s, pubkey);
      out(`nostr:${pubkey} is listed as an aggregator; copies of organizers' own events are marked at the next tick`);
      return;
    }
    case 'relays': {
      const paused = relayPauses(s.dir).all();
      if (paused.length === 0) out('no relay is paused');
      for (const { relay, state } of paused) {
        out(`${relay}\t${state.until === null ? 'left off' : `paused until ${time(state.until)}`}\t${state.strikes} strike${state.strikes === 1 ? '' : 's'}`);
      }
      return;
    }
    case 'pause-relay': {
      const hours = Number(option(args, '--hours') ?? PAUSE_SECONDS / 3600);
      if (!args[0] || !/^wss?:\/\//.test(args[0]) || !(hours > 0)) throw new UsageError('pause-relay needs a relay URL and a positive number of hours');
      const until = now + Math.round(hours * 3600);
      relayPauses(s.dir).set(args[0], { until, strikes: 1 });
      out(`${args[0]} paused until ${time(until)}; a refusal after that leaves it off`);
      return;
    }
    case 'resume-relay':
      if (!args[0]) throw new UsageError('resume-relay needs a relay URL');
      relayPauses(s.dir).set(args[0], null);
      out(`${args[0]} resumed; it gets new events from the next publish`);
      return;
    case 'meetup-pages': {
      // The Meetup event pages read for their venue (enrich/meetup-pages.ts).
      const pages = eventPagesStore(s.db);
      if (args[0] === 'resume') {
        pages.resume();
        out('Meetup pages: reading again from the next tick');
        return;
      }
      if (args.length) throw new UsageError('meetup-pages takes only resume');
      const state = pages.state();
      out(`state           ${state.stoppedAt !== null ? `stopped since ${time(state.stoppedAt)}, after ${state.strikes} refusals` : state.pausedUntil !== null && state.pausedUntil > now ? `paused until ${time(state.pausedUntil)}` : 'reading'}`);
      out(`robots.txt      ${state.robotsAt === null ? 'not read yet' : `read ${time(state.robotsAt)}`}`);
      const counts = new Map(pages.counts().map((c) => [c.outcome ?? 'unread', c.n]));
      for (const [label, key] of [['read', 'read'], ['not yet read', 'unread'], ['disallowed', 'disallowed'], ['gone', 'gone'], ['failed', 'failed']] as const) {
        out(`${label.padEnd(15)} ${counts.get(key) ?? 0}`);
      }
      return;
    }
    default:
      throw new UsageError(command ? `unknown command ${command}` : 'no command');
  }
}

function hexKey(value: string): string {
  if (/^[0-9a-f]{64}$/.test(value)) return value;
  try {
    const decoded = decode(value);
    if (decoded.type === 'npub') return decoded.data;
  } catch {
    // reported below
  }
  throw new UsageError(`not a public key: ${value}`);
}

// Compares a publisher's upcoming events with the index's (service/coverage.ts),
// read-only. With --save the report is also kept under the data directory.
async function runCoverage(s: AdminStores, settings: Settings, args: string[], now: number): Promise<void> {
  const save = args.includes('--save');
  if (save) args.splice(args.indexOf('--save'), 1);
  const given = option(args, '--pubkey');
  const pubkey = given ? hexKey(given) : settings.coveragePubkey;
  const relay = option(args, '--relay') ?? settings.coverageRelay ?? settings.searchRelays[0];
  if (!pubkey) throw new UsageError('coverage needs a publisher: --pubkey, or EVENTINDEX_COVERAGE_PUBKEY');
  if (!relay) throw new UsageError('coverage needs a relay: --relay, or EVENTINDEX_COVERAGE_RELAY or EVENTINDEX_SEARCH_RELAYS');
  const pool = new SimplePool();
  // A search relay leaves out what it counts as spam unless asked (NIP-50).
  const extra = settings.searchRelays.includes(relay) ? { search: 'include:spam' } : {};
  try {
    const refs = await upcomingReferences((filter) => pool.querySync([relay], { ...filter, ...extra }, { maxWait: 20_000 }), pubkey, now);
    // The index also reads the publisher's own events: they are not its own copies.
    const own = nativeD(pubkey);
    const report = coverage(refs, readCities(undefined).cities, (from, to) => s.events.startingBetween(from, to), (d) => {
      const g = s.dir.get(d)?.g;
      return g ? decodeGeohash(g) : null;
    }, { ignore: (row) => row.calendarD === own });
    const lines = formatCoverage(report, { source: npubEncode(pubkey), relay, now });
    for (const line of lines) out(line);
    if (save) {
      const dir = join(settings.dataDir, 'coverage');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${new Date(now * 1000).toISOString().slice(0, 10)}.txt`);
      writeFileSync(file, `${lines.join('\n')}\n`);
      out(`saved to ${file}`);
    }
  } finally {
    pool.close([relay]);
  }
}

async function main(): Promise<number> {
  useSafeWebSockets();
  const [command, ...args] = process.argv.slice(2);
  const settings = loadSettings(process.env);
  mkdirSync(settings.dataDir, { recursive: true });
  const db = openIndexDb(settings.indexDb);
  try {
    const stores = { db, dir: directoryStore(db), queues: queueStore(db), events: eventStore(db) };
    const now = Math.floor(Date.now() / 1000);
    if (command === 'coverage') await runCoverage(stores, settings, args, now);
    else run(stores, command, args, now);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n${USAGE}\n`);
      return 2;
    }
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  } finally {
    db.close();
  }
}

main().then((code) => {
  process.exitCode = code;
});
