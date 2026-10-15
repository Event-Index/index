// The pages of eventindex.space: plain HTML and one stylesheet, no scripts,
// no images, nothing loaded from elsewhere, nothing that tracks a reader.

import type { Settings } from '../../indexer/src/config.ts';
import { PLATFORMS } from '../../indexer/src/project/profile.ts';
import type { StoredEntry } from '../../indexer/src/store/directory.ts';
import type { EventRow } from '../../indexer/src/store/events.ts';
import type { calendarView, statsView } from './views.ts';

export const CSP = "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (text: unknown): string => String(text ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]!);

// Only http(s) links are written as links.
const href = (url: string | null | undefined): string | null => (url && /^https?:\/\//i.test(url) ? esc(url) : null);
const link = (url: string | null | undefined, text: string): string => {
  const h = href(url);
  return h ? `<a href="${h}">${esc(text)}</a>` : esc(text);
};

const REPO = 'https://github.com/Event-Index/index';

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<main>
${body}
</main>
<footer><p><a href="/">Event Index</a> · <a href="${REPO}">Code and specification</a> · Directory data CC0 1.0</p></footer>
</body>
</html>
`;
}

export const STYLE = `:root { color-scheme: light dark; --fg: #1d1d1f; --bg: #fcfcfa; --muted: #5f5f66; --line: #deded8; --link: #1f5fbf; --box: #f2f2ee; }
@media (prefers-color-scheme: dark) { :root { --fg: #ececee; --bg: #151517; --muted: #a2a2aa; --line: #34343a; --link: #8ab4ff; --box: #202024; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main, footer { max-width: 42rem; margin: 0 auto; padding: 0 1rem; }
main { padding-top: 3rem; }
footer { padding-bottom: 3rem; color: var(--muted); font-size: .9rem; border-top: 1px solid var(--line); margin-top: 3rem; }
h1 { font-size: 2rem; margin: 0 0 .5rem; overflow-wrap: anywhere; }
h2 { font-size: 1.25rem; margin: 2.5rem 0 .75rem; }
h3 { font-size: 1.05rem; margin: 0 0 .25rem; }
p, ul, table { margin: 0 0 1rem; }
a { color: var(--link); overflow-wrap: anywhere; }
code { font: .9em ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
.lede, .muted { color: var(--muted); }
.lede { font-size: 1.1rem; }
form { display: flex; flex-wrap: wrap; gap: .5rem; margin: 0 0 1rem; }
input, textarea, button { font: inherit; padding: .5rem .75rem; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); }
input { flex: 1 1 16rem; min-width: 0; }
textarea { flex: 1 1 100%; min-height: 6rem; }
button { background: var(--box); cursor: pointer; }
ul.plain { list-style: none; padding: 0; }
li.event, li.calendar { padding: .75rem 0; border-bottom: 1px solid var(--line); }
li.event p, li.calendar p { margin: 0; }
.numbers strong { font-size: 1.3rem; }
.box { background: var(--box); border-radius: 8px; padding: 1rem; margin: 0 0 1rem; }
table { border-collapse: collapse; width: 100%; font-size: .95rem; }
td { border-top: 1px solid var(--line); padding: .4rem .5rem .4rem 0; vertical-align: top; }
`;

function mirroredFrom(entry: StoredEntry): string {
  const platform = PLATFORMS[entry.source];
  return platform
    ? `Mirrored from ${esc(platform.styled)} by Event Index, which is not affiliated with ${esc(platform.owner)}.`
    : 'Mirrored from its calendar feed by Event Index.';
}

function when(row: EventRow): string {
  if (row.kind === 31922) {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(row.start * 1000));
  }
  const options: Intl.DateTimeFormatOptions = {
    timeZone: row.tzid ?? 'UTC', weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  };
  try {
    return new Intl.DateTimeFormat('en-US', options).format(new Date(row.start * 1000));
  } catch {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(new Date(row.start * 1000));
  }
}

function eventItem(row: EventRow, settings: Settings): string {
  const title = `${row.cancelled ? 'Cancelled: ' : ''}${row.title}`;
  const lines = [`<h3>${link(row.url, title)}</h3>`, `<p class="when">${esc(when(row))}</p>`];
  if (row.location) lines.push(`<p class="where">${/^https?:\/\//i.test(row.location) ? 'Online' : esc(row.location)}</p>`);
  if (row.summary) lines.push(`<p class="summary">${esc(row.summary)}</p>`);
  const links = [href(row.url) ? `<a href="${href(row.url)}">Event page</a>` : null, `<a href="${esc(`${settings.apiBase}/events/byid/${row.id}.ics`)}">.ics</a>`];
  lines.push(`<p class="muted">${links.filter(Boolean).join(' · ')}</p>`);
  return `<li class="event">\n${lines.join('\n')}\n</li>`;
}

export function homePage(stats: ReturnType<typeof statsView>, settings: Settings, indexNpub: string | null): string {
  const api = esc(settings.apiBase);
  const endpoints: Array<[string, string]> = [
    ['/calendars/byfeedurl?url=', 'a calendar by its feed address'],
    ['/calendars/byslug/<local name>', 'a calendar by its local name'],
    ['/calendars/byguid/<npub>', 'a calendar by its nostr key'],
    ['/search/calendars/byterm?q=&near=&tag=', 'calendars by name, area (geohash) or topic'],
    ['/events/bycalendar/<local name>?from=&to=', 'a calendar\'s events'],
    ['/events/byid/<id>[.ics|.json]', 'one event'],
    ['/search/events/byterm?q=&from=&to=&near=&radius=&tag=', 'events by text, time, area or topic'],
    ['/ics/calendar/<local name>.ics', 'a calendar as an iCalendar feed'],
    ['/ics/city/<city>.ics', 'a city\'s calendars as one feed'],
    ['/stats', 'the numbers below'],
    ['/dump/index.db', 'the directory as a SQLite file'],
  ];
  return layout('Event Index', `<h1>Event Index</h1>
<p class="lede">An open directory of public event calendars.</p>
<p>Event Index keeps a directory of public calendar feeds from Luma, Meetup®, Mobilizon, Google Calendar and any site that publishes iCalendar. It reads each feed every few hours and serves every event as iCalendar, jCal and schema.org JSON-LD, and on nostr as a NIP-52 calendar event signed by a key of the calendar's own, so any app can show it and its organizer stays its host.</p>
<p class="muted">Event Index is not affiliated with any platform it reads. Event details belong to their organizers; see each event's own page.</p>

<h2>Find a calendar</h2>
<form action="/search" method="get" role="search">
<input type="search" name="q" placeholder="Name, topic or city" aria-label="Search the directory" required>
<button type="submit">Search</button>
</form>

<h2>Add a calendar</h2>
<p>Paste the address of a public calendar feed (it often ends in <code>.ics</code>, or starts with <code>webcal://</code>). A maintainer reviews each one before it is indexed. Addresses that carry a private token, and personal calendar links, are refused.</p>
<form action="/submit" method="post">
<input type="url" name="url" placeholder="https://…" aria-label="Feed address" required>
<button type="submit">Submit for review</button>
</form>

<h2>In numbers</h2>
<p class="numbers"><strong>${stats.calendars}</strong> calendars · <strong>${stats.events.upcoming}</strong> upcoming events · <strong>${stats.polls.ok_last_24h}</strong> feeds read in the last day</p>
<p>The whole directory, nightly: <a href="${api}/dump/index.db">index.db</a> (SQLite: directory entries, calendar metadata and poll statistics, no event content), dedicated to the public domain under CC0 1.0.</p>

<h2>API</h2>
<p>Base address <code>${api}</code>. No key, open to any origin. Events come as jCal by default, <code>.ics</code> for iCalendar, <code>.json</code> for schema.org JSON-LD.</p>
<table>
${endpoints.map(([path, what]) => `<tr><td><code>${esc(path)}</code></td><td>${esc(what)}</td></tr>`).join('\n')}
</table>
<p>Adding a feed is <code>POST ${api}/feeds/add</code> with <code>{"url": "…"}</code>; a maintainer reviews it. The full reference and the data terms are in <a href="${REPO}/blob/main/spec/api.md">spec/api.md</a>. Keep each event's link to its own page and credit its organizer and platform when you show it.</p>

<h2>On nostr</h2>
<p>Relay <code>${esc(settings.publicRelay)}</code>. The directory is a list (kind 39999 entries) signed by the index key${indexNpub ? ` <code>${esc(indexNpub)}</code>` : ''}, <code>_@${esc(settings.domain)}</code>. Each calendar's key has a name at <code>/.well-known/nostr.json</code>: <code>&lt;local name&gt;@${esc(settings.domain)}</code>.</p>

<h2>Organizers</h2>
<p>If your calendar is here and you would rather it were not, find it above and use the form on its page. Once a request is approved, the index stops reading the feed, deletes the calendar's upcoming events from relays that honor deletions, and never indexes it again.</p>`);
}

export function searchPage(q: string, results: StoredEntry[]): string {
  const items = results.map((e) => `<li class="calendar">
<h3><a href="/calendar/${esc(e.localName)}">${esc(e.name ?? e.d)}</a></h3>
<p class="muted">${esc([PLATFORMS[e.source]?.styled ?? 'iCalendar feed', e.location].filter(Boolean).join(' · '))}</p>
</li>`);
  return layout(`${q} · Event Index`, `<h1>Calendars</h1>
<form action="/search" method="get" role="search">
<input type="search" name="q" value="${esc(q)}" aria-label="Search the directory" required>
<button type="submit">Search</button>
</form>
${items.length ? `<ul class="plain">\n${items.join('\n')}\n</ul>` : `<p>No calendars match <strong>${esc(q)}</strong>.</p>`}`);
}

export function calendarPage(entry: StoredEntry, view: ReturnType<typeof calendarView>, upcoming: EventRow[], settings: Settings): string {
  const name = entry.name ?? entry.d;
  if (entry.removed) {
    return layout(`${name} · Event Index`, `<h1>${esc(name)}</h1>
<p class="lede">No longer mirrored by Event Index at its organizer's request.</p>`);
  }
  const facts = [
    entry.pageUrl ? `<li>${link(entry.pageUrl, 'The calendar\'s own page')}</li>` : '',
    `<li>${link(entry.feedUrl, 'Its feed')}</li>`,
    `<li><a href="${esc(view.eventindex.ics)}">This calendar as .ics</a> · <a href="${esc(`${settings.apiBase}/calendars/byslug/${entry.localName}`)}">as JSON</a></li>`,
    view.eventindex.nostr ? `<li>On nostr: <code>${esc(view.eventindex.nostr.npub)}</code> (<code>${esc(view.eventindex.nostr.nip05)}</code>)</li>` : '',
  ].filter(Boolean);
  const where = [PLATFORMS[entry.source]?.styled ?? 'An iCalendar feed', entry.location].filter(Boolean).join(' · ');
  return layout(`${name} · Event Index`, `<h1>${esc(name)}</h1>
<p class="lede">${esc(where)}</p>
<p class="muted">${mirroredFrom(entry)}</p>
<ul>
${facts.join('\n')}
</ul>

<h2>Upcoming events</h2>
${upcoming.length ? `<ul class="plain">\n${upcoming.map((row) => eventItem(row, settings)).join('\n')}\n</ul>` : '<p>None at the moment.</p>'}

<h2>Organizer of this calendar?</h2>
<div class="box">
<p>You can have it removed from Event Index. A maintainer reviews each request. Once it is approved, the index stops reading the feed, deletes the calendar's upcoming events from relays that honor deletions, and never indexes it again.</p>
<form action="/calendar/${esc(entry.localName)}/remove" method="post">
<textarea name="message" maxlength="1000" placeholder="Anything a maintainer should know (optional). Please leave out personal details." aria-label="Message"></textarea>
<button type="submit">Ask for removal</button>
</form>
</div>`);
}

export function removeResultPage(entry: StoredEntry | null, outcome: { status: number; body: Record<string, unknown> }): string {
  const name = entry?.name ?? entry?.d ?? 'Calendar';
  if (outcome.status !== 202) {
    return layout('Request not received · Event Index', `<h1>Request not received</h1>
<p>${esc(outcome.body['message'])}</p>
${entry ? `<p><a href="/calendar/${esc(entry.localName)}">Back to ${esc(name)}</a></p>` : ''}`);
  }
  return layout('Request received · Event Index', `<h1>Request received</h1>
<p>Your request to remove <strong>${esc(name)}</strong> is waiting for a maintainer.</p>
<div class="box"><p><code>${esc(outcome.body['token'])}</code></p></div>
<p>${esc(outcome.body['instructions'])}</p>
<p><a href="/calendar/${esc(entry!.localName)}">Back to ${esc(name)}</a></p>`);
}

export function submitResultPage(outcome: { status: number; body: Record<string, unknown> }): string {
  if (outcome.status === 202) {
    const name = outcome.body['name'] ?? outcome.body['d'];
    const again = outcome.body['status'] === 'already-queued';
    return layout('Submitted · Event Index', `<h1>${again ? 'Already waiting for review' : 'Submitted'}</h1>
<p><strong>${esc(name)}</strong> ${again ? 'was submitted before and' : ''} is waiting for review. A maintainer reviews each submission before the calendar is indexed.</p>
<p><a href="/">Back to Event Index</a></p>`);
  }
  if (outcome.body['error'] === 'already-listed') {
    return layout('Already listed · Event Index', `<h1>Already listed</h1>
<p>This calendar is already in the directory: <a href="/calendar/${esc(outcome.body['local_name'])}">see its page</a>.</p>`);
  }
  return layout('Not submitted · Event Index', `<h1>Not submitted</h1>
<p>${outcome.status === 422 ? 'The feed could not be read. ' : ''}${esc(outcome.body['message'])}</p>
<p><a href="/">Back to Event Index</a></p>`);
}

export function messagePage(title: string, message: string): string {
  return layout(`${title} · Event Index`, `<h1>${esc(title)}</h1>\n<p>${esc(message)}</p>\n<p><a href="/">Back to Event Index</a></p>`);
}
