// What organizers do with their own nostr key, each request signed for itself
// (NIP-98, checked by the server before these run): file a calendar they
// publish on nostr, claim a calendar the index mirrors, prove control of it
// by NIP-05, and, once it is theirs, connect or disconnect the signer the
// index publishes through. Claims and filings wait for a maintainer's review;
// an owner's own requests do not. Nothing here signs or publishes.

import type { Settings } from '../../indexer/src/config.ts';
import { nativeD } from '../../indexer/src/directory/id.ts';
import { readAuthor, type RelayReader } from '../../indexer/src/native/read.ts';
import { calendarDomains, checkNip05, parseBunkerUrl } from '../../indexer/src/claim/proof.ts';
import { sealFor } from '../../indexer/src/claim/seal.ts';
import { PLATFORMS } from '../../indexer/src/project/profile.ts';
import { area, type Cities } from '../../indexer/src/service/admin.ts';
import { loadAggregators } from '../../indexer/src/native/publishers.ts';
import { ownershipClash, type StoredEntry } from '../../indexer/src/store/directory.ts';
import type { ClaimMode } from '../../indexer/src/store/queues.ts';
import type { Outcome, WriteDeps } from './writes.ts';

export interface ClaimDeps extends WriteDeps {
  settings: Settings;
  cities: Cities;
  reader?: RelayReader;
  // Whether a relay an organizer names may be used.
  relayAllowed?: (url: string) => Promise<boolean>;
}

const fail = (status: number, error: string, message: string, extra: Record<string, unknown> = {}): Outcome =>
  ({ status, body: { error, message, ...extra } });

const MODES = new Set<ClaimMode>(['own', 'delegated', 'link']);
const OPEN_CLAIMS_PER_CALENDAR = 10;

function usualRelays(settings: Settings): string[] {
  return [...new Set([settings.relayUrl, ...settings.generalRelays, ...settings.profileRelays])];
}

// A calendar its organizer publishes on nostr, listed at once by their key
// (no review: a publisher is listed anyway once the index reads its events),
// or, when it is listed already, its organizer's settings: its city.
export async function fileNative(deps: ClaimDeps, pubkey: string, body: Record<string, unknown>, now: number): Promise<Outcome> {
  const slug = body['city'];
  const city = typeof slug === 'string' && slug ? deps.cities.cities.find((c) => c.slug === slug) : null;
  if (slug !== undefined && slug !== null && slug !== '' && !city) return fail(400, 'invalid-parameter', 'city must be a city of the directory, by its slug.');
  const place = city ? area(city) : null;
  const d = nativeD(pubkey);
  if (deps.dir.doNotIndex(d)) return fail(409, 'not-indexed', 'This calendar is not indexed, at its organizer\'s request.');
  const listed = deps.dir.get(d);
  if (listed && !listed.removed) {
    if (place) deps.dir.setPlace(d, place.location, place.g);
    // Proven by its key: read from its own relays too from now on, and
    // listed, as its organizer asks.
    deps.dir.setFoundVia(d, 'owner');
    deps.dir.setListed(d);
    return { status: 200, body: { status: 'updated', d, local_name: listed.localName, location: place?.location ?? listed.location } };
  }
  const clash = ownershipClash(deps.dir.byOwner(pubkey), d, 'own');
  if (clash) return fail(409, 'already-owner', 'This key already publishes a calendar listed here.', { d: clash.d, local_name: clash.localName });
  if (!deps.reader) return fail(503, 'not-available', 'The index cannot read relays at the moment.');
  const read = await readAuthor(deps.reader, pubkey, usualRelays(deps.settings), deps.relayAllowed ? { relayAllowed: deps.relayAllowed } : {});
  if (!read.ok) return fail(422, 'no-relay-answered', 'No relay answered for this key. Try again later.');
  if (read.events.length === 0) return fail(422, 'no-events', 'No calendar events (NIP-52) were found from this key on its relays.');
  const name = read.profile?.name ?? read.calendars[0]?.tags.find((t) => t[0] === 'title')?.[1] ?? null;
  deps.dir.add({
    d, role: loadAggregators().has(pubkey) ? 'aggregator' : 'calendar', source: 'nostr', feedUrl: '', pageUrl: read.profile?.website ?? null, name,
    description: read.profile?.about ?? null, image: read.profile?.picture ?? null, location: place?.location ?? null, g: place?.g ?? null,
    foundVia: 'owner', addedAt: now, mode: 'own', owner: pubkey,
  });
  return {
    status: 201,
    body: {
      status: 'listed', d, local_name: deps.dir.get(d)!.localName, name, events: read.events.length,
      message: 'Listed. The index reads your events from your relays and signs nothing for this calendar.',
    },
  };
}

// A removal the calendar's organizer asks for with its own key: approved at
// once, and carried out at the poll service's next tick.
export function removeNow(deps: ClaimDeps, entry: StoredEntry | null, pubkey: string, now: number): Outcome {
  if (!entry) return fail(404, 'not-found', 'There is no such calendar in the directory.');
  if (entry.removed) return fail(410, 'removed', 'This calendar is no longer indexed.');
  if (entry.mode === 'mirrored' || entry.owner !== pubkey) return fail(403, 'not-owner', 'Only the key this calendar is published with can remove it at once. Anyone can ask a maintainer, without signing.');
  const request = deps.queues.requestRemoval({ d: entry.d, message: 'by its organizer\'s key', at: now });
  deps.queues.resolveRemoval(request.id, 'approved', now);
  return { status: 202, body: { status: 'approved', request: request.id, d: entry.d, message: 'Removed at the index\'s next tick: its events leave the index, and it is not listed again.' } };
}

export function claimInstructions(entry: StoredEntry, token: string, domains: string[]): string {
  const where = PLATFORMS[entry.source]?.styled ?? 'the calendar\'s own site';
  const nip05 = domains.length ? ` Or name your key in NIP-05 at ${domains.join(' or ')}, and check it here.` : '';
  return `To show that you run this calendar, put ${token} in its description, or in the description of one of its events, on ${where}. `
    + `The index looks for it each time it reads the feed, usually within a few hours.${nip05} A maintainer then reviews the claim.`;
}

function guard(entry: StoredEntry | null): Outcome | null {
  if (!entry) return fail(404, 'not-found', 'There is no such calendar in the directory.');
  if (entry.removed) return fail(410, 'removed', 'This calendar is no longer indexed.');
  if (entry.role !== 'calendar') return fail(409, 'not-a-calendar', 'Only a calendar can be claimed.');
  return null;
}

function sealSigner(deps: ClaimDeps, bunker: unknown): { sealed: string } | Outcome {
  const pointer = parseBunkerUrl(bunker);
  if (!pointer) return fail(400, 'invalid-signer', 'Give your signer\'s connection as a bunker:// address with at least one relay.');
  const intake = deps.dir.fact('intake_pubkey');
  if (!intake) return fail(503, 'not-ready', 'The index is not ready to take a signer yet. Try again later.');
  return { sealed: sealFor(intake, String(bunker).trim()) };
}

export function requestClaim(deps: ClaimDeps, entry: StoredEntry | null, pubkey: string, body: Record<string, unknown>, now: number): Outcome {
  const refused = guard(entry);
  if (refused) return refused;
  const calendar = entry!;
  if (calendar.mode !== 'mirrored') return fail(409, 'already-claimed', 'This calendar is already published by its organizer.');
  const mode = body['mode'] as ClaimMode;
  if (!MODES.has(mode)) return fail(400, 'invalid-mode', 'mode is "own" (you publish yourself), "delegated" (the index publishes as you) or "link" (the index names your key as the organizer\'s).');
  // Naming a key publishes nothing as it, so it clashes with nothing.
  const clash = mode === 'link' ? null : ownershipClash(deps.dir.byOwner(pubkey), calendar.d, mode);
  if (clash) {
    return fail(409, 'already-owner', 'This key already publishes a calendar listed here; the index reads all of its events as that calendar\'s.', { d: clash.d, local_name: clash.localName });
  }
  let signer: string | null = null;
  if (mode === 'delegated') {
    const sealed = sealSigner(deps, body['bunker']);
    if ('status' in sealed) return sealed;
    signer = sealed.sealed;
  }
  if (deps.queues.openClaimsFor(calendar.d).length >= OPEN_CLAIMS_PER_CALENDAR) {
    return fail(429, 'too-many-requests', 'This calendar already has claims waiting for review.');
  }
  const { id, token } = deps.queues.requestClaim({ d: calendar.d, pubkey, mode, signer, at: now });
  const domains = calendarDomains(calendar, (deps.dir.calendarMeta(calendar.d) as { url?: string | null } | null)?.url ?? null);
  return {
    status: 202,
    body: { status: 'received', claim: id, d: calendar.d, mode, token, nip05_domains: domains, instructions: claimInstructions(calendar, token, domains) },
  };
}

export async function verifyClaimNip05(deps: ClaimDeps, entry: StoredEntry | null, claimId: number, pubkey: string, body: Record<string, unknown>, now: number): Promise<Outcome> {
  const refused = guard(entry);
  if (refused) return refused;
  const claim = deps.queues.claim(claimId);
  if (!claim || claim.d !== entry!.d || claim.kind !== 'claim') return fail(404, 'not-found', 'There is no such claim for this calendar.');
  if (claim.pubkey !== pubkey) return fail(403, 'not-yours', 'Only the key that made the claim can prove it.');
  if (claim.status !== 'pending') return fail(409, 'not-pending', 'This claim is no longer waiting.');
  const identifier = typeof body['nip05'] === 'string' ? body['nip05'] : '';
  const domains = calendarDomains(entry!, (deps.dir.calendarMeta(entry!.d) as { url?: string | null } | null)?.url ?? null);
  const checked = await checkNip05(deps.fetch, identifier, pubkey, domains);
  if (!checked.ok) {
    const messages = {
      'nip05-invalid': 'Give a NIP-05 address such as events@example.org.',
      'nip05-domain': 'The NIP-05 address must be at the calendar\'s own domain.',
      'nip05-unreachable': 'The domain\'s nostr.json could not be read.',
      'nip05-mismatch': 'The domain\'s nostr.json does not name your key.',
    };
    return fail(422, checked.reason, messages[checked.reason], { nip05_domains: domains });
  }
  deps.queues.markClaimVerified(claim.id, 'nip05', identifier.trim().toLowerCase(), now);
  return { status: 200, body: { status: 'verified', claim: claim.id, by: 'nip05' } };
}

export function ownerAction(deps: ClaimDeps, entry: StoredEntry | null, pubkey: string, body: Record<string, unknown>, now: number): Outcome {
  const refused = guard(entry);
  if (refused) return refused;
  const calendar = entry!;
  if (calendar.mode === 'mirrored' || calendar.owner !== pubkey) return fail(403, 'not-owner', 'Only the calendar\'s organizer can change how it is published.');
  if (body['action'] === 'disconnect') {
    if (calendar.mode !== 'delegated') return fail(409, 'not-delegated', 'The index does not publish this calendar for you.');
    const request = deps.queues.ownerRequest({ d: calendar.d, pubkey, kind: 'disconnect', signer: null, at: now });
    return { status: 202, body: { status: 'received', request, message: 'The index forgets your signer at its next tick and reads your own events from then on.' } };
  }
  if (body['action'] === 'connect') {
    if (calendar.source === 'nostr' || !calendar.feedUrl) return fail(409, 'no-feed', 'This calendar has no feed for the index to publish from.');
    const clash = ownershipClash(deps.dir.byOwner(pubkey), calendar.d, 'delegated');
    if (clash) return fail(409, 'already-owner', 'This key publishes another calendar listed here itself.', { d: clash.d, local_name: clash.localName });
    const sealed = sealSigner(deps, body['bunker']);
    if ('status' in sealed) return sealed;
    const request = deps.queues.ownerRequest({ d: calendar.d, pubkey, kind: 'connect', signer: sealed.sealed, at: now });
    return { status: 202, body: { status: 'received', request, message: 'The index connects to your signer at its next tick and publishes your calendar\'s events as you.' } };
  }
  return fail(400, 'invalid-action', 'action is "connect" (with bunker) or "disconnect".');
}
