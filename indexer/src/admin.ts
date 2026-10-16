// The maintainer's commands. They read and change index.db only; the poll
// service publishes the changes on its next tick.
//
//   node indexer/src/admin.ts status
//   node indexer/src/admin.ts import-seeds seeds/luma/new-york.json ... [--cities seeds/cities.json]
//   node indexer/src/admin.ts submissions
//   node indexer/src/admin.ts approve-submission <id> [--city <slug>]
//   node indexer/src/admin.ts reject-submission <id>
//   node indexer/src/admin.ts removals
//   node indexer/src/admin.ts approve-removal <id>
//   node indexer/src/admin.ts reject-removal <id>
//   node indexer/src/admin.ts remove <local name or d> [--message <text>]
//   node indexer/src/admin.ts relays
//   node indexer/src/admin.ts pause-relay <wss://…> [--hours <n>]
//   node indexer/src/admin.ts resume-relay <wss://…>
//
// Settings come from the environment, as for the services.

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSettings } from './config.ts';
import { openIndexDb } from './store/index-db.ts';
import { directoryStore } from './store/directory.ts';
import { queueStore } from './store/queues.ts';
import { eventStore } from './store/events.ts';
import { importSeeds, approveSubmission, rejectSubmission, approveRemoval, rejectRemoval, removeCalendar, status, type AdminStores, type Cities } from './service/admin.ts';
import type { Seed } from './directory/seed.ts';
import { relayPauses, PAUSE_SECONDS } from './service/publisher.ts';

const USAGE = `usage: admin.ts <command>
  status
  import-seeds <seed.json>... [--cities <cities.json>]
  submissions
  approve-submission <id> [--city <slug>]
  reject-submission <id>
  removals
  approve-removal <id>
  reject-removal <id>
  remove <local name or d> [--message <text>]
  relays
  pause-relay <wss://…> [--hours <n>]
  resume-relay <wss://…>`;

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
      out(`calendars       ${r.calendars} (${r.withKey} with a key, ${r.neverPolled} not yet polled)`);
      out(`aggregators     ${r.aggregators}`);
      out(`removed         ${r.removed}`);
      out(`stale           ${r.stale.length}${r.stale.length ? `: ${r.stale.join(', ')}` : ''}`);
      out(`upcoming events ${r.upcomingEvents}`);
      out(`submissions     ${r.pendingSubmissions} pending`);
      out(`remove requests ${r.pendingRemovals} pending`);
      out(`last dump       ${time(r.lastDump)}`);
      return;
    }
    case 'import-seeds': {
      const cities = readCities(option(args, '--cities'));
      if (args.length === 0) throw new UsageError('import-seeds needs at least one seed list');
      const seeds = args.map((path) => JSON.parse(readFileSync(path, 'utf8')) as Seed);
      const r = importSeeds(s, seeds, cities, now);
      for (const d of r.blocked) out(`not filed (do-not-index): ${d}`);
      out(`filed ${r.filed.length}, already listed ${r.existing.length}, on the do-not-index list ${r.blocked.length}`);
      return;
    }
    case 'submissions':
      for (const sub of s.queues.submissions('pending')) {
        out(`${sub.id}\t${time(sub.submittedAt)}\t${sub.source}\t${sub.role}\t${sub.name ?? '-'}${sub.platformDefault ? ' (platform default calendar: only its owner should submit it)' : ''}\t${sub.feedUrl}`);
      }
      return;
    case 'approve-submission': {
      const city = option(args, '--city');
      const { d } = approveSubmission(s, id(args[0]), city ? { city } : {}, readCities(undefined), now);
      out(`filed ${d}; the poll service polls it on its next tick`);
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
    default:
      throw new UsageError(command ? `unknown command ${command}` : 'no command');
  }
}

function main(): number {
  const [command, ...args] = process.argv.slice(2);
  const settings = loadSettings(process.env);
  mkdirSync(settings.dataDir, { recursive: true });
  const db = openIndexDb(settings.indexDb);
  try {
    run({ db, dir: directoryStore(db), queues: queueStore(db), events: eventStore(db) }, command, args, Math.floor(Date.now() / 1000));
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

process.exitCode = main();
