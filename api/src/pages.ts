// The pages of eventindex.space: server-rendered HTML, one stylesheet and the
// brand files, all from this origin. Nothing tracks a reader. Only the pages
// where organizers sign in with their nostr key run a script, the site's own
// (/claim.js).

import { createHash } from 'node:crypto';
import { npubEncode } from 'nostr-tools/nip19';
import type { Settings } from '../../indexer/src/config.ts';
import type { City } from '../../indexer/src/service/admin.ts';
import { DELEGATED_KINDS } from '../../indexer/src/claim/signer.ts';
import { PLATFORMS } from '../../indexer/src/project/profile.ts';
import type { StoredEntry } from '../../indexer/src/store/directory.ts';
import type { EventRow } from '../../indexer/src/store/events.ts';
import { ringFor, type CityCount, type GridDay, type Upcoming } from './home.ts';
import type { calendarView, statsView } from './views.ts';

export const CSP = "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
// The pages that sign in with a nostr key: the site's own script, talking
// only to the site.
export const SCRIPTED_CSP = `${CSP}; script-src 'self'; connect-src 'self'`;

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (text: unknown): string => String(text ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]!);

// Only http(s) links are written as links.
const href = (url: string | null | undefined): string | null => (url && /^https?:\/\//i.test(url) ? esc(url) : null);
const link = (url: string | null | undefined, text: string): string => {
  const h = href(url);
  return h ? `<a href="${h}">${esc(text)}</a>` : esc(text);
};

const REPO = 'https://github.com/Event-Index/index';
const platformName = (entry: StoredEntry) => (entry.source === 'nostr' ? 'nostr' : PLATFORMS[entry.source]?.styled ?? 'iCalendar feed');
const cityOf = (entry: StoredEntry) => entry.location?.split(',')[0]?.trim() || null;

function layout(title: string, body: string, description = 'An open directory of public event calendars.', script = false): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="stylesheet" href="/style.css?v=${STYLE_VERSION}">
<link rel="preload" href="/brand/fonts/public-sans-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#1f5fbf">
${script ? '<script src="/claim.js" defer></script>\n' : ''}</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header class="site">
<a href="/" aria-label="Event Index home">
  <picture>
    <source srcset="/brand/wordmark-dark.svg" media="(prefers-color-scheme: dark)">
    <img src="/brand/wordmark-light.svg" alt="Event Index" height="32">
  </picture>
</a>
<nav aria-label="Main">
<a href="/calendars">Calendars</a>
<a href="/#add">Add a calendar</a>
<a href="/#api">API</a>
<a href="/#relay">Relay</a>
</nav>
</header>
<main id="content">
${body}
</main>
<footer class="site"><div class="rule">
<p>Event Index is not affiliated with any platform it reads. Event details belong to their organizers; each event links to its own page.</p>
<p><a href="https://nosfabrica.com">NosFabrica</a> is a core maintainer of Event Index. <a href="https://brainstorm.world">Brainstorm</a> is one consumer of the index.</p>
<p>Code under the Apache License 2.0. Directory data and the logo dedicated to the public domain (CC0 1.0). <a href="${REPO}">Source on GitHub</a></p>
</div></footer>
</body>
</html>
`;
}

const font = (weight: number) => `@font-face { font-family: "Public Sans"; font-style: normal; font-weight: ${weight}; font-display: swap; src: url(/brand/fonts/public-sans-latin-${weight}-normal.woff2) format("woff2"); }`;

export const STYLE = `${[400, 600, 700].map(font).join('\n')}
:root {
  color-scheme: light dark;
  --ink: #1d1d1f; --paper: #fcfcfa; --link: #1f5fbf; --ring: #1f5fbf;
  --muted: #5f5f66; --line: #e3e3dd; --tile: #f1f1ec; --code: #1d1d1f; --code-ink: #ececee; --code-link: #8ab4ff;
}
@media (prefers-color-scheme: dark) {
  :root { --ink: #ececee; --paper: #151517; --link: #8ab4ff; --ring: #8ab4ff; --muted: #a2a2aa; --line: #2e2e33; --tile: #1f1f23; --code: #0d0d0f; }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 17px/1.55 "Public Sans", system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: var(--link); text-underline-offset: .15em; overflow-wrap: anywhere; }
:focus-visible { outline: 2px solid var(--link); outline-offset: 3px; border-radius: 4px; }
.skip { position: absolute; left: -999px; top: .5rem; background: var(--paper); padding: .5rem .75rem; }
.skip:focus { left: .5rem; }
code, .mono { font: .88em/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
h1, h2, h3 { line-height: 1.2; margin: 0; overflow-wrap: anywhere; }
h1 { font-size: clamp(2rem, 1.4rem + 2.6vw, 3.1rem); font-weight: 700; letter-spacing: -.02em; }
h2 { font-size: 1.35rem; font-weight: 700; letter-spacing: -.01em; }
h3 { font-size: 1.02rem; font-weight: 600; }
p { margin: 0 0 1rem; }
.muted { color: var(--muted); }
.site, main { max-width: 68rem; margin: 0 auto; padding-left: 1.25rem; padding-right: 1.25rem; }
header.site { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .75rem 2rem; padding-top: 1.25rem; padding-bottom: 1.25rem; }
header.site img { display: block; height: 32px; width: auto; }
header.site nav { display: flex; flex-wrap: wrap; gap: .25rem 1.4rem; }
header.site nav a { color: var(--ink); font-weight: 600; text-decoration: none; font-size: .97rem; }
header.site nav a:hover { text-decoration: underline; }
section { padding: 2.75rem 0; border-top: 1px solid var(--line); }
section:first-child { border-top: 0; }
.section-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: .5rem 1.5rem; margin-bottom: 1.25rem; }
.section-head p { margin: 0; }
.section-head form.row { flex-wrap: nowrap; margin: 0; }
.section-head input { flex: 0 1 16rem; }
.hero { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 2.5rem 3.5rem; align-items: center; padding-top: 2rem; }
.hero .lede { font-size: 1.15rem; color: var(--muted); max-width: 34rem; margin-top: 1rem; }
.hero .numbers { display: flex; flex-wrap: wrap; gap: .25rem 1.5rem; margin: 1.5rem 0 0; color: var(--muted); }
.hero .numbers strong { color: var(--ink); font-size: 1.25rem; font-weight: 700; }
figure { margin: 0; }
.grid-card { border: 1px solid var(--line); border-radius: 16px; padding: 1.25rem 1.25rem .75rem; }
.grid-card svg { display: block; width: 100%; height: auto; max-width: 26rem; margin: 0 auto; }
.grid-card p { font-size: .88rem; color: var(--muted); margin: .5rem 0 0; text-align: center; }
.g-dot { fill: var(--ink); }
.g-ring { fill: none; stroke: var(--ring); }
.g-past { opacity: .28; }
.g-num { fill: var(--muted); font: 9px "Public Sans", system-ui, sans-serif; text-anchor: middle; }
.g-day { fill: var(--muted); font: 600 9px "Public Sans", system-ui, sans-serif; text-anchor: middle; letter-spacing: .04em; }
.g-today .g-num { fill: var(--ink); font-weight: 700; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr)); gap: 1rem; list-style: none; margin: 0; padding: 0; }
.card { position: relative; display: grid; grid-template-columns: 3.4rem minmax(0, 1fr); gap: .9rem; padding: 1rem; border: 1px solid var(--line); border-radius: 14px; background: var(--paper); transition: border-color .15s; }
.card:hover { border-color: var(--muted); }
.card h3 a { color: var(--ink); text-decoration: none; }
.card h3 a::after { content: ""; position: absolute; inset: 0; border-radius: 14px; }
.card h3 a:hover { text-decoration: underline; }
.card p { margin: .3rem 0 0; font-size: .9rem; color: var(--muted); }
.tile { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 3.4rem; border-radius: 10px; background: var(--tile); line-height: 1; }
.tile .m { font-size: .68rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.tile .d { font-size: 1.45rem; font-weight: 700; margin-top: .2rem; }
.cities { display: grid; grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr)); gap: .5rem 1rem; list-style: none; margin: 0; padding: 0; }
.cities a { display: flex; justify-content: space-between; gap: 1rem; padding: .65rem .9rem; border: 1px solid var(--line); border-radius: 10px; color: var(--ink); text-decoration: none; font-weight: 600; }
.cities a:hover { border-color: var(--muted); }
.cities .n { color: var(--muted); font-weight: 400; }
.steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1.5rem 2rem; list-style: none; margin: 0; padding: 0; counter-reset: step; }
.steps li { counter-increment: step; }
.steps li::before { content: counter(step); display: inline-grid; place-items: center; width: 2rem; height: 2rem; border: 2px solid var(--ink); border-radius: 50%; font-weight: 700; margin-bottom: .75rem; }
.steps h3 { margin-bottom: .35rem; }
.steps p { color: var(--muted); margin: 0; }
.split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 2rem 3rem; }
.split h2 { margin-bottom: .75rem; }
.code { background: var(--code); color: var(--code-ink); border-radius: 14px; padding: 1.1rem 1.25rem; margin: 0 0 1rem; }
.code dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .45rem 1.25rem; margin: 0; }
.code dt { color: #a2a2aa; font: 600 .78rem/1.9 "Public Sans", system-ui, sans-serif; text-transform: uppercase; letter-spacing: .06em; }
.code dd { margin: 0; }
.code a { color: var(--code-link); }
form.row { display: flex; flex-wrap: wrap; gap: .5rem; margin: 0 0 1rem; }
input, textarea, button { font: inherit; font-size: 1rem; padding: .6rem .85rem; border: 1px solid var(--line); border-radius: 10px; background: var(--paper); color: var(--ink); }
input { flex: 1 1 14rem; min-width: 0; }
input::placeholder, textarea::placeholder { color: var(--muted); }
textarea { width: 100%; min-height: 6rem; margin-bottom: .5rem; }
button { background: var(--ink); color: var(--paper); border-color: var(--ink); font-weight: 600; cursor: pointer; }
button:hover { opacity: .88; }
.chips { display: flex; flex-wrap: wrap; gap: .4rem; list-style: none; margin: 0 0 1.5rem; padding: 0; }
.chips a { display: inline-block; padding: .3rem .75rem; border: 1px solid var(--line); border-radius: 999px; color: var(--ink); text-decoration: none; font-size: .9rem; }
.chips a[aria-current="page"] { border-color: var(--ink); font-weight: 600; }
.calendars { display: grid; grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr)); gap: .75rem 1rem; list-style: none; margin: 0; padding: 0; }
.calendars li { position: relative; padding: .9rem 1rem; border: 1px solid var(--line); border-radius: 12px; }
.calendars li:hover { border-color: var(--muted); }
.calendars a { color: var(--ink); text-decoration: none; font-weight: 600; }
.calendars a::after { content: ""; position: absolute; inset: 0; border-radius: 12px; }
.calendars p { margin: .2rem 0 0; font-size: .9rem; color: var(--muted); }
.page-head { padding: 2rem 0 1.5rem; }
.eyebrow { font-size: .85rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin-bottom: .6rem; }
.page-head .muted { margin-top: .75rem; }
.facts { display: flex; flex-wrap: wrap; gap: .4rem 1.25rem; list-style: none; margin: 1rem 0 0; padding: 0; font-size: .95rem; }
.rows { list-style: none; margin: 0; padding: 0; max-width: 48rem; }
.rows h3 a { color: var(--ink); text-decoration: none; }
.rows h3 a:hover { text-decoration: underline; }
.narrow { max-width: 48rem; }
.rows li { display: grid; grid-template-columns: 3.4rem minmax(0, 1fr); gap: 1rem; padding: 1rem 0; border-top: 1px solid var(--line); }
.rows li:first-child { border-top: 0; }
.rows p { margin: .25rem 0 0; font-size: .95rem; }
.rows .summary { color: var(--muted); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.gap { margin-top: .6rem; }
.box { border: 1px solid var(--line); border-radius: 14px; padding: 1.25rem; background: var(--tile); }
.token { font-size: 1.1rem; padding: .75rem 1rem; background: var(--paper); border: 1px solid var(--line); border-radius: 10px; display: inline-block; margin-bottom: 1rem; }
.button { display: inline-block; padding: .6rem .95rem; border-radius: 10px; background: var(--ink); color: var(--paper); font-weight: 600; text-decoration: none; }
.button:hover { opacity: .88; }
.box + .box, .box + form.box, form.box + .box { margin-top: 1rem; }
.box h2 + p, .box h3 + p { margin-top: .6rem; }
fieldset { border: 0; margin: 0 0 1rem; padding: 0; }
legend { font-weight: 600; margin-bottom: .5rem; }
.choice { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: .6rem; align-items: start; padding: .75rem 0; border-top: 1px solid var(--line); }
.choice:first-of-type { border-top: 0; }
.choice input { margin-top: .35rem; }
.field { display: grid; gap: .35rem; margin: .75rem 0; }
.field input, .field select { width: 100%; }
select { font: inherit; font-size: 1rem; padding: .6rem .85rem; border: 1px solid var(--line); border-radius: 10px; background: var(--paper); color: var(--ink); }
[data-status] { min-height: 1.5rem; margin-top: 1rem; font-weight: 600; }
[hidden] { display: none !important; }
footer.site { margin-top: 2rem; padding-bottom: 3rem; color: var(--muted); font-size: .88rem; }
footer.site .rule { border-top: 1px solid var(--line); padding-top: 2rem; }
footer.site p { max-width: 46rem; margin-bottom: .5rem; }
@media (max-width: 52rem) {
  .hero, .split { grid-template-columns: minmax(0, 1fr); }
  .steps { grid-template-columns: minmax(0, 1fr); }
  section { padding: 2rem 0; }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

// A new stylesheet gets a new address, so no browser keeps an old one.
const STYLE_VERSION = createHash('sha256').update(STYLE).digest('hex').slice(0, 10);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// The mark's idea with real days: four weeks of dots, a ring on each day
// with events, larger for more of them.
export function dotGrid(days: GridDay[]): string {
  const cell = 44;
  const rowHeight = 52;
  const top = 22;
  const radii = [0, 8, 10.5, 13, 15.5];
  const widths = [0, 1.5, 2, 2.5, 3];
  const max = Math.max(0, ...days.map((d) => d.count));
  const total = days.reduce((n, d) => n + (d.past ? 0 : d.count), 0);
  const busy = days.filter((d) => !d.past && d.count > 0).length;
  const parts = WEEKDAYS.map((w, i) => `<text class="g-day" x="${i * cell + cell / 2}" y="12">${w.slice(0, 1)}</text>`);
  days.forEach((day, i) => {
    const x = (i % 7) * cell + cell / 2;
    const y = top + Math.floor(i / 7) * rowHeight + 18;
    const [, m, d] = day.date.split('-').map(Number);
    const label = i === 0 || d === 1 ? `${MONTHS[m! - 1]} ${d}` : String(d);
    const ring = ringFor(day.count, max);
    const words = new Date(`${day.date}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
    const title = `${words}: ${day.count ? `${day.count} event${day.count === 1 ? '' : 's'}` : 'no events'}${day.today ? ' (today)' : ''}`;
    parts.push(`<g class="${['g-cell', day.past ? 'g-past' : '', day.today ? 'g-today' : ''].filter(Boolean).join(' ')}"><title>${esc(title)}</title>`
      + `<circle class="g-dot" cx="${x}" cy="${y}" r="${day.today ? 5.5 : 4.5}"/>`
      + (ring ? `<circle class="g-ring" cx="${x}" cy="${y}" r="${radii[ring]}" stroke-width="${widths[ring]}"/>` : '')
      + `<text class="g-num" x="${x}" y="${y + 30}">${label}</text></g>`);
  });
  const height = top + 4 * rowHeight;
  return `<svg viewBox="0 0 ${7 * cell} ${height}" role="img" aria-label="The next four weeks: ${total} events on ${busy} days">${parts.join('')}</svg>`;
}

function zoned(row: EventRow): { zone: string; allDay: boolean } {
  const allDay = row.kind === 31922;
  let zone = allDay ? 'UTC' : row.tzid ?? 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    zone = 'UTC';
  }
  return { zone, allDay };
}

function dateTile(row: EventRow): string {
  const { zone } = zoned(row);
  const date = new Date(row.start * 1000);
  const month = new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short' }).format(date);
  const day = new Intl.DateTimeFormat('en-US', { timeZone: zone, day: 'numeric' }).format(date);
  return `<div class="tile" aria-hidden="true"><span class="m">${esc(month)}</span><span class="d">${esc(day)}</span></div>`;
}

function when(row: EventRow, withDate = true): string {
  const { zone, allDay } = zoned(row);
  const date = new Date(row.start * 1000);
  if (allDay) return new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'long', month: 'long', day: 'numeric' }).format(date) + ', all day';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone, weekday: withDate ? 'long' : 'short', ...(withDate ? { month: 'long', day: 'numeric' } : {}), hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(date);
}

const placeOf = (row: EventRow) => (row.location ? (/^https?:\/\//i.test(row.location) ? 'Online' : row.location) : null);
const titleOf = (row: EventRow) => `${row.cancelled ? 'Cancelled: ' : ''}${row.title}`;

function eventCard(item: Upcoming, settings: Settings): string {
  const { row, calendar, city } = item;
  const target = href(row.url) ?? esc(`${settings.apiBase}/events/byid/${row.id}.ics`);
  return `<li class="card">${dateTile(row)}<div>
<h3><a href="${target}">${esc(titleOf(row))}</a></h3>
<p>${esc(calendar.name ?? calendar.d)}${city ? ` · ${esc(city)}` : ''}</p>
<p>${esc(when(row, false))}</p>
</div></li>`;
}

export interface HomeData {
  stats: ReturnType<typeof statsView>;
  days: GridDay[];
  upcoming: Upcoming[];
  cities: CityCount[];
  settings: Settings;
  indexNpub: string | null;
}

export function homePage(data: HomeData): string {
  const { stats, settings } = data;
  const api = esc(settings.apiBase);
  return layout('Event Index', `<section class="hero">
<div>
<h1>Public event calendars in one open directory.</h1>
<p class="lede">Event Index reads the calendars organizers already publish on Luma, Meetup®, Mobilizon, Google Calendar and their own sites. Any app can show their events, with each organizer as the host.</p>
<p class="numbers"><span><strong>${stats.events.upcoming}</strong> upcoming events</span><span><strong>${stats.calendars}</strong> calendars</span><span><strong>${data.cities.length}</strong> cities</span></p>
</div>
<figure class="grid-card">
${dotGrid(data.days)}
<figcaption><p>The next four weeks. A ring marks a day with events; the more events, the larger the ring.</p></figcaption>
</figure>
</section>

<section aria-labelledby="coming-up">
<div class="section-head"><h2 id="coming-up">Coming up</h2><p><a href="/calendars">All calendars</a></p></div>
${data.upcoming.length ? `<ul class="cards">\n${data.upcoming.map((u) => eventCard(u, settings)).join('\n')}\n</ul>` : '<p class="muted">No upcoming events yet.</p>'}
</section>

<section aria-labelledby="cities">
<div class="section-head"><h2 id="cities">Cities</h2>
<form class="row" action="/calendars" method="get" role="search"><input type="search" name="q" placeholder="Search calendars" aria-label="Search calendars"><button type="submit">Search</button></form>
</div>
<ul class="cities">
${data.cities.map((c) => `<li><a href="/calendars?city=${esc(c.slug)}">${esc(c.name)} <span class="n">${c.count}</span></a></li>`).join('\n')}
</ul>
</section>

<section aria-labelledby="how">
<div class="section-head"><h2 id="how">How it works</h2></div>
<ol class="steps">
<li><h3>Organizers publish</h3><p>Organizers already publish their calendars as iCalendar feeds on the platforms they use.</p></li>
<li><h3>Event Index reads and signs</h3><p>Every few hours it reads each feed and signs every event as a nostr event, with a key of that calendar's own.</p></li>
<li><h3>Apps show the events</h3><p>Apps read them through the API, the feeds or the relay, and show each organizer as the host. Details stay on each event's own page.</p></li>
</ol>
</section>

<section class="split">
<div id="add">
<h2>For organizers</h2>
<p><strong>Add a calendar.</strong> Paste a link to the calendar, group or event on Luma, Meetup®, Google Calendar or Mobilizon, its feed (<code>.ics</code> or <code>webcal://</code>), or a nostr address (an npub, or NIP-05). A maintainer reviews each feed before it is indexed; addresses with a private token are refused.</p>
<form class="row" action="/submit" method="post">
<input type="text" inputmode="url" name="url" placeholder="Paste a link to the calendar, group or event" aria-label="Link to the calendar, group or event" required>
<button type="submit">Submit for review</button>
</form>
<p><strong>Claim a calendar.</strong> Already on nostr? Find your calendar under <a href="/calendars">Calendars</a> and claim it, to publish its events from your own key: yourself, or by the index, as you.</p>
<p><strong>Publish on nostr already?</strong> If your calendar's events are NIP-52 events from your own key, the index lists them on its own. <a href="/add/nostr">Add it by its key</a> to list it now and set its city.</p>
<p><strong>Remove a calendar.</strong> Find it under <a href="/calendars">Calendars</a> and use the form on its page. Once a request is approved, its upcoming events are deleted and it is never indexed again.</p>
</div>
<div id="api">
<h2>For developers</h2>
<div class="code mono"><dl>
<dt>API</dt><dd>${api}</dd>
<dt id="relay">Relay</dt><dd>${esc(settings.publicRelay)}</dd>
<dt>NIP-05</dt><dd>_@${esc(settings.domain)}${data.indexNpub ? `<br>${esc(data.indexNpub)}` : ''}</dd>
<dt>Dump</dt><dd><a href="${api}/dump/index.db">${api}/dump/index.db</a></dd>
</dl></div>
<p>No key needed. Events come as jCal, iCalendar (<code>.ics</code>) and schema.org JSON-LD (<code>.json</code>), and on the relay as NIP-52 events. The directory data is in the public domain. Keep each event's link to its own page. <a href="${REPO}/blob/main/spec/api.md">API reference</a></p>
</div>
</section>`);
}

export interface CalendarListItem {
  entry: StoredEntry;
  upcoming: number;
}

export function calendarsPage(data: { q: string; city: CityCount | null; items: CalendarListItem[]; cities: CityCount[] }): string {
  const heading = data.city ? `Calendars in ${data.city.name}` : data.q ? `Calendars matching “${data.q}”` : 'Calendars';
  const chips = [`<li><a href="/calendars"${!data.city && !data.q ? ' aria-current="page"' : ''}>All</a></li>`,
    ...data.cities.map((c) => `<li><a href="/calendars?city=${esc(c.slug)}"${data.city?.slug === c.slug ? ' aria-current="page"' : ''}>${esc(c.name)} <span class="muted">${c.count}</span></a></li>`)];
  const items = data.items.map(({ entry, upcoming }) => `<li><a href="/calendar/${esc(entry.localName)}">${esc(entry.name ?? entry.d)}</a>
<p>${esc([platformName(entry), cityOf(entry)].filter(Boolean).join(' · '))}</p>
<p>${upcoming ? `${upcoming} upcoming event${upcoming === 1 ? '' : 's'}` : 'No upcoming events'}</p></li>`);
  return layout(`${heading} · Event Index`, `<div class="page-head">
<h1>${esc(heading)}</h1>
</div>
<form class="row" action="/calendars" method="get" role="search">
<input type="search" name="q" value="${esc(data.q)}" placeholder="Name, topic or city" aria-label="Search calendars">
<button type="submit">Search</button>
</form>
<ul class="chips">${chips.join('')}</ul>
${items.length ? `<ul class="calendars">\n${items.join('\n')}\n</ul>` : `<p>No calendars match <strong>${esc(data.q)}</strong>.</p>`}`);
}

function mirroredFrom(entry: StoredEntry): string {
  const platform = PLATFORMS[entry.source];
  return platform
    ? `Mirrored from ${esc(platform.styled)} by Event Index, which is not affiliated with ${esc(platform.owner)}.`
    : 'Mirrored from its calendar feed by Event Index.';
}

// Who publishes the calendar's events on nostr.
function publishedBy(entry: StoredEntry): string {
  if (entry.mode === 'mirrored') return mirroredFrom(entry);
  if (entry.mode === 'delegated') {
    const platform = PLATFORMS[entry.source];
    return `Published by Event Index as its organizer, through a signer they connected, from its calendar on ${esc(platform?.styled ?? 'its own site')}.`;
  }
  if (entry.source === 'nostr') return 'Published on nostr by its organizer. Event Index reads its events from their relays and signs nothing for it.';
  return 'Published by its organizer from their own nostr key. Event Index reads its events from their relays.';
}

const shortNpub = (pubkey: string) => {
  const npub = npubEncode(pubkey);
  return `${npub.slice(0, 12)}…${npub.slice(-6)}`;
};

function removeForm(entry: StoredEntry): string {
  return `<h3>Remove this calendar</h3>
<p class="gap">You can have it removed from Event Index. A maintainer reviews each request. Once it is approved, the index stops reading the calendar, ${entry.mode === 'mirrored' ? 'deletes its upcoming events from relays that honor deletions, ' : ''}and never indexes it again.</p>
<form action="/calendar/${esc(entry.localName)}/remove" method="post">
<textarea name="message" maxlength="1000" placeholder="Anything a maintainer should know (optional). Please leave out personal details." aria-label="Message"></textarea>
<button type="submit">Ask for removal</button>
</form>`;
}

// What an organizer can do on a calendar's page.
function organizerBox(entry: StoredEntry): string {
  const name = esc(entry.localName);
  if (entry.mode === 'mirrored') {
    return `<div class="box">
<h2 id="organizer">Organizer of this calendar?</h2>
<div class="split gap">
<div>
<h3>Claim this calendar</h3>
<p class="gap">Publish its events from your own nostr key: post them yourself, or have the index post them for you, as you. You sign in with your nostr browser extension and show that you run the calendar.</p>
<p><a class="button" href="/calendar/${name}/claim">Claim this calendar</a></p>
</div>
<div>
${removeForm(entry)}
</div>
</div>
</div>`;
  }
  const manage = entry.source === 'nostr'
    ? `<p class="gap"><a href="/calendar/${name}/claim">Manage this calendar</a></p>`
    : `<p class="gap"><a href="/calendar/${name}/claim">Manage how it is published</a></p>`;
  return `<div class="box">
<h2 id="organizer">Organizer of this calendar?</h2>
${manage}
${removeForm(entry)}
</div>`;
}

function eventRow(row: EventRow, settings: Settings): string {
  const place = placeOf(row);
  const links = [href(row.url) ? `<a href="${href(row.url)}">Event page</a>` : null, `<a href="${esc(`${settings.apiBase}/events/byid/${row.id}.ics`)}">.ics</a>`];
  return `<li class="event">${dateTile(row)}<div>
<h3>${link(row.url, titleOf(row))}</h3>
<p class="when">${esc(when(row))}</p>
${place ? `<p class="where">${esc(place)}</p>\n` : ''}${row.summary ? `<p class="summary">${esc(row.summary)}</p>\n` : ''}<p class="muted">${links.filter(Boolean).join(' · ')}</p>
</div></li>`;
}

export function calendarPage(entry: StoredEntry, view: ReturnType<typeof calendarView>, upcoming: EventRow[], settings: Settings): string {
  const name = entry.name ?? entry.d;
  const eyebrow = [platformName(entry), cityOf(entry)].filter(Boolean).join(' · ');
  if (entry.removed) {
    return layout(`${name} · Event Index`, `<div class="page-head">
<h1>${esc(name)}</h1>
<p class="muted">No longer mirrored by Event Index at its organizer's request.</p>
</div>`);
  }
  const npub = view.eventindex.nostr?.npub;
  const facts = [
    entry.pageUrl ? `<li>${link(entry.pageUrl, 'The calendar\'s own page')}</li>` : '',
    view.calendar.feed ? `<li>${link(view.calendar.feed, 'Feed')}</li>` : '',
    `<li><a href="${esc(view.eventindex.ics)}">.ics</a></li>`,
    `<li><a href="${esc(`${settings.apiBase}/calendars/byslug/${entry.localName}`)}">JSON</a></li>`,
    npub ? `<li title="${esc(npub)}">nostr <code>${esc(`${npub.slice(0, 12)}…${npub.slice(-6)}`)}</code></li>` : '',
  ].filter(Boolean);
  return layout(`${name} · Event Index`, `<div class="page-head">
<p class="eyebrow">${esc(eyebrow)}</p>
<h1>${esc(name)}</h1>
<p class="muted">${publishedBy(entry)}</p>
<ul class="facts">
${facts.join('\n')}
</ul>
</div>

<section class="narrow" aria-labelledby="upcoming">
<div class="section-head"><h2 id="upcoming">Upcoming events</h2>${upcoming.length ? `<p class="muted">${upcoming.length}</p>` : ''}</div>
${upcoming.length ? `<ul class="rows">\n${upcoming.map((row) => eventRow(row, settings)).join('\n')}\n</ul>` : '<p class="muted">None at the moment.</p>'}
</section>

<section class="narrow" aria-labelledby="organizer">
${organizerBox(entry)}
</section>`, `Events of ${name}, from ${platformName(entry)}.`);
}

const SIGN_IN = `<div class="box">
<h2>Sign in with your nostr key</h2>
<p>Your nostr browser extension (NIP-07) signs each request for this page alone. Your key never leaves it.</p>
<p><button type="button" data-sign-in>Sign in with your nostr key</button></p>
<p class="muted" data-who></p>
</div>
<noscript><p class="box">This page needs JavaScript and a nostr browser extension (NIP-07).</p></noscript>`;
const STATUS = '<p data-status role="status" aria-live="polite"></p>';
const KINDS = `kinds ${DELEGATED_KINDS.filter((k) => k !== 5).join(', ')} and deletions`;

// Claiming a mirrored calendar, or, once it is theirs, how its organizer
// manages it.
export function claimPage(entry: StoredEntry): string {
  const name = entry.name ?? entry.d;
  const local = esc(entry.localName);
  const api = `/api/1.0/calendars/${local}`;
  const where = esc(PLATFORMS[entry.source]?.styled ?? 'the calendar\'s own site');
  if (entry.mode !== 'mirrored') {
    const owner = entry.owner ? `<p class="muted">Its organizer's key: <code>${esc(shortNpub(entry.owner))}</code></p>` : '';
    const delegated = entry.mode === 'delegated'
      ? `<div class="box" data-signer="${api}/signer">
<h2>The signer</h2>
<p>Event Index reads this calendar's feed and publishes its events as you, through the signer you connected, which it asks only for ${KINDS}. Disconnect it to publish the events yourself; the index then reads them from your relays.</p>
<p><button type="button" data-disconnect>Disconnect the signer</button></p>
</div>`
      : entry.source !== 'nostr'
        ? `<form class="box" data-connect data-signer="${api}/signer">
<h2>Have the index publish as you</h2>
<p>Connect a remote signer (NIP-46) and the index publishes this calendar's events from its feed on ${where} as you. It asks only for ${KINDS}, and you can disconnect it at any time, here or in your signer.</p>
<div class="field"><label for="bunker">Your signer's connection</label><input id="bunker" name="bunker" placeholder="bunker://…" autocomplete="off" required></div>
<button type="submit">Connect a signer</button>
</form>`
        : '';
    const remove = `<div class="box" data-remove="${api}/remove-request">
<h2>Remove this calendar</h2>
<p>Signed with the key it is published with, a removal is carried out at once, with no review: its events leave the index, and it is not listed again.</p>
<p><button type="button" data-remove-now>Remove this calendar now</button></p>
</div>`;
    return layout(`Manage ${name} · Event Index`, `<div class="page-head">
<p class="eyebrow"><a href="/calendar/${local}">${esc(name)}</a></p>
<h1>Manage ${esc(name)}</h1>
<p class="muted">${publishedBy(entry)}</p>
${owner}
</div>
<section class="narrow">
${SIGN_IN}
<div data-after-sign-in hidden>
${delegated}
${remove}
</div>
${STATUS}
</section>`, `How ${name} is published.`, true);
  }
  return layout(`Claim ${name} · Event Index`, `<div class="page-head">
<p class="eyebrow"><a href="/calendar/${local}">${esc(name)}</a></p>
<h1>Claim ${esc(name)}</h1>
<p class="muted">${mirroredFrom(entry)} Claim it to publish its events from your own nostr key instead of the key Event Index holds for it.</p>
</div>
<section class="narrow">
${SIGN_IN}
<form class="box" data-claim="${api}/claim" data-after-sign-in hidden>
<fieldset>
<legend>How should the calendar be published?</legend>
<label class="choice"><input type="radio" name="mode" value="own" checked><span><strong>I publish it myself.</strong> You post its events from your own nostr app. The index stops reading the feed and reads your events instead. Its key's upcoming events are withdrawn, kept as cancelled where people have answered them.</span></label>
<label class="choice"><input type="radio" name="mode" value="delegated"><span><strong>Publish it for me, as me.</strong> You keep using ${where}; the index keeps reading the feed and publishes each event as you, through a remote signer you connect (NIP-46). It asks only for ${KINDS}, and you can disconnect it at any time.</span></label>
</fieldset>
<div class="field" data-when="delegated"><label for="bunker">Your signer's connection</label><input id="bunker" name="bunker" placeholder="bunker://…" autocomplete="off"></div>
<button type="submit">Claim this calendar</button>
</form>
<div class="box" data-result hidden>
<h2>Show that you run the calendar</h2>
<p class="token"><code data-token></code></p>
<p data-instructions></p>
<form data-nip05 hidden>
<div class="field"><label for="nip05">Or name your key in NIP-05 at <span data-domains></span></label><input id="nip05" name="nip05" placeholder="events@example.org" autocomplete="off" required></div>
<button type="submit">Check</button>
</form>
</div>
${STATUS}
<p class="muted" data-claim-note>You will get a short code to place in the calendar's description, or in one of its events, on ${where}. A maintainer reviews each claim once the code is found.</p>
</section>`, `Claim ${name} on Event Index.`, true);
}

// Adding a calendar its organizer publishes on nostr, by their key.
export function nativePage(cities: City[]): string {
  const options = [...cities].sort((a, b) => a.name.localeCompare(b.name)).map((c) => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join('\n');
  return layout('Your calendar on nostr · Event Index', `<div class="page-head">
<h1>Your calendar on nostr</h1>
<p class="muted">If you publish your calendar's events on nostr (NIP-52) from your own key, the index lists it on its own as it reads the relays, and serves your events as iCalendar, jCal and JSON-LD. The index signs nothing for it. Sign in with your key to list it now, from your own relays, and to say where its events are.</p>
</div>
<section class="narrow">
${SIGN_IN}
<form class="box" data-native="/api/1.0/calendars/native" data-after-sign-in hidden>
<div class="field"><label for="city">Where are its events?</label><select id="city" name="city">
<option value="">Somewhere else</option>
${options}
</select></div>
<button type="submit">List it, or save its city</button>
</form>
${STATUS}
<p class="muted">To remove it, open its page once it is listed and manage it with the same key.</p>
</section>`, 'Your calendar on nostr, on Event Index.', true);
}

export function removeResultPage(entry: StoredEntry | null, outcome: { status: number; body: Record<string, unknown> }): string {
  const name = entry?.name ?? entry?.d ?? 'Calendar';
  if (outcome.status !== 202) {
    return layout('Request not received · Event Index', `<div class="page-head"><h1>Request not received</h1></div>
<p>${esc(outcome.body['message'])}</p>
${entry ? `<p><a href="/calendar/${esc(entry.localName)}">Back to ${esc(name)}</a></p>` : ''}`);
  }
  return layout('Request received · Event Index', `<div class="page-head"><h1>Request received</h1></div>
<p>Your request to remove <strong>${esc(name)}</strong> is waiting for a maintainer.</p>
<p class="token"><code>${esc(outcome.body['token'])}</code></p>
<p>${esc(outcome.body['instructions'])}</p>
<p><a href="/calendar/${esc(entry!.localName)}">Back to ${esc(name)}</a></p>`);
}

export function submitResultPage(outcome: { status: number; body: Record<string, unknown> }): string {
  if (outcome.status === 201) {
    if (outcome.body['status'] === 'listed') {
      return layout('Listed · Event Index', `<div class="page-head"><h1>Listed</h1></div>
<p>${esc(outcome.body['found'])}</p>
<p>${esc(outcome.body['message'])}</p>
<p><a href="/calendar/${esc(outcome.body['local_name'])}">See its page</a></p>`);
    }
    const name = outcome.body['name'] ?? outcome.body['d'];
    return layout('Added · Event Index', `<div class="page-head"><h1>Added</h1></div>
${outcome.body['found'] ? `<p>${esc(outcome.body['found'])}</p>\n` : ''}<p><strong>${esc(name)}</strong> is in the index. Its first events appear within minutes on <a href="/calendar/${esc(outcome.body['local_name'])}">its page</a>.</p>
<p><a href="/">Back to Event Index</a></p>`);
  }
  if (outcome.status === 202 && outcome.body['status'] === 'kept') {
    return layout('Kept · Event Index', `<div class="page-head"><h1>Kept</h1></div>
<p>${esc(outcome.body['found'])}</p>
<p>${esc(outcome.body['message'])}</p>
<p><a href="/calendar/${esc(outcome.body['local_name'])}">See its page</a></p>`);
  }
  if (outcome.status === 202) {
    const name = outcome.body['name'] ?? outcome.body['d'];
    const again = outcome.body['status'] === 'already-queued';
    return layout('Submitted · Event Index', `<div class="page-head"><h1>${again ? 'Already waiting for review' : 'Submitted'}</h1></div>
${outcome.body['found'] ? `<p>${esc(outcome.body['found'])}</p>\n` : ''}<p><strong>${esc(name)}</strong> ${again ? 'was submitted before and' : ''} is waiting for review. A maintainer reviews each submission before the calendar is indexed.</p>
<p><a href="/">Back to Event Index</a></p>`);
  }
  if (outcome.body['error'] === 'already-listed') {
    return layout('Already listed · Event Index', `<div class="page-head"><h1>Already listed</h1></div>
<p>This calendar is already in the directory: <a href="/calendar/${esc(outcome.body['local_name'])}">see its page</a>.</p>`);
  }
  return layout('Not submitted · Event Index', `<div class="page-head"><h1>Not submitted</h1></div>
<p>${outcome.status === 422 ? 'The feed could not be read. ' : ''}${esc(outcome.body['message'])}</p>
<p><a href="/">Back to Event Index</a></p>`);
}

export function messagePage(title: string, message: string): string {
  return layout(`${title} · Event Index`, `<div class="page-head"><h1>${esc(title)}</h1></div>\n<p>${esc(message)}</p>\n<p><a href="/">Back to Event Index</a></p>`);
}
