// The two things anyone can ask of the index: to add a feed, and to remove a
// calendar. A removal always waits for a maintainer. A feed that is safe to
// index (autoApprovable) is filed at once and polled at the poll service's
// next tick; any other waits for review. Nothing is published here.

import { checkFeedUrl, validateFeed } from '../../indexer/src/directory/validate.ts';
import { identify, FeedUrlError, type DirectoryIdentity } from '../../indexer/src/directory/id.ts';
import { normalizeFeed, type NormalizedFeed } from '../../indexer/src/normalize/normalize.ts';
import type { Source } from '../../indexer/src/types.ts';
import type { FetchResult, Validators } from '../../indexer/src/poller/fetch.ts';
import type { DirectoryStore, StoredEntry } from '../../indexer/src/store/directory.ts';
import type { QueueStore } from '../../indexer/src/store/queues.ts';
import { PLATFORMS } from '../../indexer/src/project/profile.ts';
import type { Limits } from './limits.ts';

export interface WriteDeps {
  dir: DirectoryStore;
  queues: QueueStore;
  fetch: (url: string, validators: Validators) => Promise<FetchResult>;
  limits: Limits;
  // The site's address, for the page of a calendar filed at once.
  domain: string;
  log: (line: string) => void;
}

// The platforms whose calendars the index files without review.
const KNOWN_PLATFORMS = new Set<Source>(['luma', 'meetup', 'google', 'mobilizon']);
const DAY = 86400;

// Safe to file without review: an organizer's own calendar on a known
// platform (a Luma calendar, a Meetup group, a public Google calendar, a
// Mobilizon group), named by its organizer rather than a platform default,
// with at least one event. The URL checks have already passed.
export function autoApprovable(identity: DirectoryIdentity, feed: NormalizedFeed): boolean {
  return KNOWN_PLATFORMS.has(identity.source) && identity.role === 'calendar' && !feed.calendar.platformDefault && feed.records.length > 0;
}

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

export async function submitFeed(deps: WriteDeps, url: unknown, now: number): Promise<Outcome> {
  if (typeof url !== 'string' || url.trim() === '') return fail(400, 'invalid-url', 'Give the feed address as "url".');
  const check = checkFeedUrl(url);
  if (!check.ok) return fail(400, check.reason, REASONS[check.reason] ?? 'That address cannot be indexed.');
  let identity;
  try {
    identity = identify(url);
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
