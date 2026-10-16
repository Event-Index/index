// What the index relay accepts. It is the home of what Event Index signs and
// the inbox for answers to it: the index key's and the calendar keys' own
// events, RSVPs and comments about those events, and deletions of a
// writer's own events stored here. Everything else is refused. When its
// operator has it host claimants, it also takes the calendars, events and
// deletions of organizers the index publishes as.

export interface Allowlist {
  // The Event Index key.
  index: string | null;
  // Calendar keys the index signs with.
  live: Set<string>;
  // Keys of removed or claimed calendars: their last events may still go out.
  removed: Set<string>;
  // Organizers the index publishes as, when the relay hosts them.
  hosted: Set<string>;
}

export interface PolicyEvent {
  id: string;
  pubkey: string;
  kind: number;
  tags: string[][];
  content: string;
  created_at: number;
  sig: string;
}

export type Decision = { action: 'accept' } | { action: 'reject'; msg: string };

// A deletion's target: an event by id, or an addressable event by kind and d.
export type Target = { type: 'id'; id: string } | { type: 'addr'; kind: number; d: string };

// Whether the author has the target stored on this relay.
export type Lookup = (target: Target, author: string) => Promise<boolean>;

const INDEX_KINDS = new Set([0, 3, 5, 10002, 31922, 31923, 31924, 39998, 39999]);
const CALENDAR_KINDS = new Set([0, 5, 10002, 31922, 31923, 31924]);
const REMOVED_KINDS = new Set([0, 5]);
const HOSTED_KINDS = new Set([5, 31922, 31923, 31924]);
const EVENT_KINDS = new Set([31922, 31923]);
// Operator tools: `strfry import`, `sync` and `stream` are not filtered.
const CLIENT_SOURCES = new Set(['IP4', 'IP6']);
const HEX64 = /^[0-9a-f]{64}$/;

const ACCEPT: Decision = { action: 'accept' };
const reject = (msg: string): Decision => ({ action: 'reject', msg: `blocked: ${msg}` });

function coordinate(value: string | undefined): { kind: number; pubkey: string; d: string } | null {
  const match = /^(\d+):([0-9a-f]{64}):(.*)$/.exec(value ?? '');
  return match ? { kind: Number(match[1]), pubkey: match[2]!, d: match[3]! } : null;
}

function isOurs(allow: Allowlist, pubkey: string): boolean {
  return pubkey === allow.index || allow.live.has(pubkey) || allow.removed.has(pubkey) || allow.hosted.has(pubkey);
}

// An `a`-style tag value naming a 31922 or 31923 event of one of our keys.
function namesOurEvent(allow: Allowlist, value: string | undefined): boolean {
  const c = coordinate(value);
  return !!c && EVENT_KINDS.has(c.kind) && isOurs(allow, c.pubkey);
}

async function ownDeletion(event: PolicyEvent, lookup: Lookup): Promise<boolean> {
  const targets: Target[] = [];
  for (const [name, value] of event.tags) {
    if (name === 'e') {
      if (!HEX64.test(value ?? '')) return false;
      targets.push({ type: 'id', id: value! });
    } else if (name === 'a') {
      const c = coordinate(value);
      if (!c || c.pubkey !== event.pubkey) return false;
      targets.push({ type: 'addr', kind: c.kind, d: c.d });
    }
  }
  if (targets.length === 0) return false;
  for (const target of targets) if (!(await lookup(target, event.pubkey))) return false;
  return true;
}

export async function decide(event: PolicyEvent, sourceType: string, allow: Allowlist, lookup: Lookup): Promise<Decision> {
  if (!CLIENT_SOURCES.has(sourceType)) return ACCEPT;
  const { pubkey, kind } = event;
  if (pubkey === allow.index && INDEX_KINDS.has(kind)) return ACCEPT;
  if (allow.live.has(pubkey) && CALENDAR_KINDS.has(kind)) return ACCEPT;
  if (allow.removed.has(pubkey) && REMOVED_KINDS.has(kind)) return ACCEPT;
  if (allow.hosted.has(pubkey) && HOSTED_KINDS.has(kind)) return ACCEPT;

  if (kind === 31925) {
    return event.tags.some(([name, value]) => name === 'a' && namesOurEvent(allow, value))
      ? ACCEPT
      : reject('an RSVP here must name an event of an Event Index calendar');
  }
  if (kind === 1111) {
    const roots = event.tags.filter(([name]) => name === 'A');
    const named = (roots.length ? roots : event.tags.filter(([name]) => name === 'a')).some(([, value]) => namesOurEvent(allow, value));
    return named ? ACCEPT : reject('a comment here must be rooted in an event of an Event Index calendar');
  }
  if (kind === 5) {
    return (await ownDeletion(event, lookup)) ? ACCEPT : reject('a deletion here can only remove your own events stored on this relay');
  }
  return reject(`this relay keeps Event Index's calendars and the RSVPs, comments and deletions that answer them; kind ${kind} from this key is not accepted`);
}
