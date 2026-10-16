// The two things anyone can ask of the index: to add a feed, and to remove a
// calendar. A removal always waits for a maintainer. A feed that is safe to
// index (autoApprovable) is filed at once and polled at the poll service's
// next tick; any other waits for review. Nothing is published here.

import { autoApprovable, checkFeedUrl, validateFeed } from '../../indexer/src/directory/validate.ts';
import { identify, FeedUrlError } from '../../indexer/src/directory/id.ts';
import { normalizeFeed } from '../../indexer/src/normalize/normalize.ts';
import type { FetchResult, Validators } from '../../indexer/src/poller/fetch.ts';
import type { DirectoryStore, StoredEntry } from '../../indexer/src/store/directory.ts';
import type { QueueStore } from '../../indexer/src/store/queues.ts';
import { PLATFORMS } from '../../indexer/src/project/profile.ts';
import { resolveLink } from '../../indexer/src/directory/resolve.ts';
import { nativeD } from '../../indexer/src/directory/id.ts';
import { outsideRelay, readAuthor, type RelayReader } from '../../indexer/src/native/read.ts';
import { startOf } from '../../indexer/src/native/ingest.ts';
import { loadAggregators, shortNpub } from '../../indexer/src/native/publishers.ts';
import { ownershipClash } from '../../indexer/src/store/directory.ts';
import type { Settings } from '../../indexer/src/config.ts';
import type { Limits } from './limits.ts';

export interface WriteDeps {
  dir: DirectoryStore;
  queues: QueueStore;
  fetch: (url: string, validators: Validators) => Promise<FetchResult>;
  limits: Limits;
  // The site's address, for the page of a calendar filed at once.
  domain: string;
  log: (line: string) => void;
  // For a nostr publisher pasted as a link: reading its relays.
  reader?: RelayReader;
  settings?: Settings;
  relayAllowed?: (url: string) => Promise<boolean>;
}

const DAY = 86400;

export interface Outcome {
  status: number;
  body: Record<string, unknown>;
}

const fail = (status: number, error: string, message: string, extra: Record<string, unknown> = {}): Outcome =>
  ({ status, body: { error, message, ...extra } });

const REASONS: Record<string, string> = {
  'invalid-url': 'That is not a feed address.',
  'unsupported-feed': 'Feeds from this provider cannot be indexed: their shared addresses carry a private token.',
  'private-feed-url': 'That address looks private: it carries a token or key. Only public feeds can be indexed.',
  'private-address': 'That address is on a private network.',
  'too-large': 'The feed is larger than 5 MB.',
  'not-icalendar': 'The address does not serve an iCalendar feed.',
  empty: 'The feed has no events and no calendar name.',
};

export { autoApprovable };

// A nostr publisher pasted as a link (an npub, an nprofile, a NIP-05
// address): kept at once when it has NIP-52 events, and listed when one of
// them is upcoming, as the index would on reading them.
async function listPublisher(deps: WriteDeps, pubkey: string, hints: string[], now: number): Promise<Outcome> {
  const d = nativeD(pubkey);
  if (deps.dir.doNotIndex(d)) return fail(409, 'not-indexed', 'This calendar is not indexed, at its organizer\'s request.');
  const known = deps.dir.get(d);
  if (known?.listed) return fail(409, 'already-listed', 'This calendar is already in the directory.', { d, local_name: known.localName });
  const clash = known ? null : ownershipClash(deps.dir.byOwner(pubkey), d, 'own');
  if (clash) return fail(409, 'already-listed', 'This key\'s calendar is already in the directory.', { d: clash.d, local_name: clash.localName });
  if (!deps.reader || !deps.settings) return fail(503, 'not-available', 'The index cannot read relays at the moment.');
  const allowed = deps.relayAllowed ?? ((relay: string) => outsideRelay(relay));
  const extra: string[] = [];
  for (const relay of hints) if (await allowed(relay)) extra.push(relay);
  const usual = [...new Set([deps.settings.relayUrl, ...deps.settings.generalRelays, ...deps.settings.profileRelays, ...extra])];
  const read = await readAuthor(deps.reader, pubkey, usual, deps.relayAllowed ? { relayAllowed: deps.relayAllowed } : {});
  if (!read.ok) return fail(422, 'no-relay-answered', 'No relay answered for this key. Try again later.');
  if (read.events.length === 0) return fail(422, 'no-events', 'No calendar events (NIP-52) were found from this key on its relays.');
  const name = read.profile?.name ?? read.calendars[0]?.tags.find((t) => t[0] === 'title')?.[1] ?? shortNpub(pubkey);
  const count = read.events.length;
  const upcoming = read.events.some((f) => (startOf(f.event) ?? 0) >= now);
  if (!known) {
    deps.dir.add({
      d, role: loadAggregators().has(pubkey) ? 'aggregator' : 'calendar', source: 'nostr', feedUrl: '', pageUrl: read.profile?.website ?? null, name,
      description: read.profile?.about ?? null, image: read.profile?.picture ?? null, location: null, g: null,
      foundVia: 'submission', addedAt: now, mode: 'own', owner: pubkey, listed: upcoming,
    });
  } else if (upcoming) {
    deps.dir.setListed(d);
  }
  deps.log(`${upcoming ? 'listed' : 'kept'} nostr publisher ${d}`);
  const events = `with ${count} event${count === 1 ? '' : 's'}`;
  const body = { d, local_name: deps.dir.get(d)!.localName, name, source: 'nostr', role: 'calendar', events: count };
  if (!upcoming) {
    return {
      status: 202,
      body: {
        status: 'kept', ...body,
        found: `Found the nostr calendar "${name}", ${events}, none upcoming.`,
        message: 'Kept. The index serves its events and lists it once it has an upcoming event. It signs nothing for it.',
      },
    };
  }
  return {
    status: 201,
    body: {
      status: 'listed', ...body,
      found: `Found the nostr calendar "${name}", ${events}.`,
      message: 'Listed. The index reads its events from its relays and signs nothing for it. Its organizer can manage it by signing in with its key.',
    },
  };
}

export async function submitFeed(deps: WriteDeps, url: unknown, now: number): Promise<Outcome> {
  if (typeof url !== 'string' || url.trim() === '') return fail(400, 'invalid-url', 'Paste a link to the calendar, group or event as "url".');
  const resolved = await resolveLink(url, deps.fetch);
  if (resolved.kind === 'refused') return fail(400, resolved.code, resolved.message);
  if (resolved.kind === 'nostr') return listPublisher(deps, resolved.pubkey, resolved.relays, now);
  url = resolved.url;
  const check = checkFeedUrl(url as string);
  if (!check.ok) return fail(400, check.reason, REASONS[check.reason] ?? 'That address cannot be indexed.');
  let identity;
  try {
    identity = identify(url as string);
  } catch (error) {
    if (error instanceof FeedUrlError) return fail(400, error.code, REASONS[error.code] ?? error.message);
    throw error;
  }
  if (deps.dir.doNotIndex(identity.d)) return fail(409, 'not-indexed', 'This calendar is not indexed, at its organizer\'s request.');
  const listed = deps.dir.get(identity.d);
  if (listed) return fail(409, 'already-listed', 'This calendar is already in the directory.', { d: listed.d, local_name: listed.localName });

  const fetched = await deps.fetch(identity.feedUrl, {});
  if (fetched.status !== 'ok') {
    const code = fetched.status === 'error' ? fetched.code : 'not-modified';
    return fail(422, code, REASONS[code] ?? `The feed could not be read (${code}).`);
  }
  const valid = validateFeed(fetched.text);
  if (!valid.ok) return fail(422, valid.reason, REASONS[valid.reason] ?? 'The feed could not be read.');
  const feed = normalizeFeed(fetched.text, identity);
  const queued = deps.queues.submit({
    d: identity.d, feedUrl: identity.feedUrl, source: identity.source, role: identity.role, name: feed.calendar.name,
    platformDefault: feed.calendar.platformDefault, at: now,
  }, deps.limits.queueCap);
  if (queued.status === 'queue-full') return fail(503, 'queue-full', 'The review queue is full. Please try again in a few days.');
  const found = feed.calendar.name ? `Found the ${resolved.what} "${feed.calendar.name}".` : `Found a ${resolved.what}.`;
  if (queued.status === 'queued' && autoApprovable(identity, feed) && deps.queues.autoApproved(now - DAY).length < deps.limits.autoApprovalsPerDay) {
    deps.dir.add({
      d: identity.d, role: identity.role, source: identity.source, feedUrl: identity.feedUrl, pageUrl: identity.pageUrl,
      name: feed.calendar.name, description: null, image: null, location: null, g: null, foundVia: 'submission', addedAt: now,
    });
    deps.queues.resolveSubmission(queued.id, 'approved', now, 'auto');
    deps.log(`auto-approved submission ${queued.id}: ${identity.d} ${identity.feedUrl}`);
    const localName = deps.dir.get(identity.d)!.localName;
    return {
      status: 201,
      body: {
        status: 'approved',
        submission: queued.id,
        d: identity.d,
        local_name: localName,
        name: feed.calendar.name,
        source: identity.source,
        role: identity.role,
        page: `https://${deps.domain}/calendar/${localName}`,
        found,
        message: 'Added to the index. Its first events appear within minutes.',
      },
    };
  }
  return {
    status: 202,
    body: {
      status: queued.status,
      submission: queued.id,
      d: identity.d,
      name: feed.calendar.name,
      source: identity.source,
      role: identity.role,
      found,
      message: 'A maintainer reviews each submission before the calendar is indexed.',
    },
  };
}

export function removalInstructions(entry: StoredEntry, token: string): string {
  const where = PLATFORMS[entry.source]?.styled ?? 'the calendar\'s own site';
  return `A maintainer reviews every request. To show that you run this calendar, put ${token} in its description, or in the description of one of its events, on ${where}. `
    + 'The index looks for it each time it reads the feed, usually within a few hours. You can take it out again once the calendar is removed.';
}

export function requestRemoval(deps: WriteDeps, entry: StoredEntry | null, message: unknown, now: number): Outcome {
  if (!entry) return fail(404, 'not-found', 'There is no such calendar in the directory.');
  if (entry.removed) return fail(410, 'removed', 'This calendar is no longer indexed.');
  if (message !== undefined && message !== null && typeof message !== 'string') return fail(400, 'invalid-message', 'The message must be text.');
  const text = typeof message === 'string' && message.trim() ? message.trim() : null;
  if (text && text.length > deps.limits.maxMessageLength) {
    return fail(400, 'too-long', `The message can be at most ${deps.limits.maxMessageLength} characters.`);
  }
  if (deps.queues.openRemovalsFor(entry.d).length >= deps.limits.removeRequestsPerCalendar) {
    return fail(429, 'too-many-requests', 'This calendar already has requests waiting for review.');
  }
  const request = deps.queues.requestRemoval({ d: entry.d, message: text, at: now });
  return {
    status: 202,
    body: { status: 'received', request: request.id, d: entry.d, token: request.token, instructions: removalInstructions(entry, request.token) },
  };
}
