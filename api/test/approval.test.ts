// Submissions that are safe to index are approved at once; the rest wait.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { harness, type Harness } from './harness.ts';
import { readFixture } from '../../indexer/test/helpers.ts';
import type { FetchResult } from '../../indexer/src/poller/fetch.ts';

let h: Harness;
before(async () => { h = await harness(); });
after(() => h.close());

const API = '/api/1.0';
let ip = 0;
const from = () => ({ 'x-real-ip': `192.0.2.${(ip += 1)}` });
const ok = (url: string, text: string): FetchResult => ({ status: 'ok', text, etag: null, lastModified: null, finalUrl: url });
async function submit(url: string, fixture: string | null, text?: string) {
  h.feeds.set(url, ok(url, text ?? readFixture(fixture!)));
  const response = await h.post(`${API}/feeds/add`, { url }, from());
  return { status: response.status, body: await response.json() as any };
}

test('a named calendar on a known platform is approved at once, filed for its first poll, and logged', async () => {
  const { status, body } = await submit('https://www.meetup.com/othergroup/events/ical/', 'meetup-pythonsd.ics');
  assert.equal(status, 201);
  assert.equal(body.status, 'approved');
  assert.equal(body.d, 'meetup:othergroup');
  assert.equal(body.local_name, 'meetup-othergroup');
  assert.equal(body.page, 'https://eventindex.space/calendar/meetup-othergroup');
  assert.match(body.message, /minutes/);
  const entry = h.dir.get('meetup:othergroup')!;
  assert.equal(entry.foundVia, 'submission');
  assert.equal(entry.pubkey, null, 'its key comes with its first poll');
  const sub = h.queues.submission(body.submission)!;
  assert.equal(sub.status, 'approved');
  assert.equal(sub.approvedBy, 'auto');
  assert.ok(h.logs.some((l) => l === `auto-approved submission ${body.submission}: meetup:othergroup https://www.meetup.com/othergroup/events/ical/`));
});

test('a public Google calendar, a Mobilizon group and a named Luma calendar are approved too', async () => {
  const google = 'https://calendar.google.com/calendar/ical/j7gov1cmnqr9tvg14k621j7t5c%40group.calendar.google.com/public/basic.ics';
  assert.equal((await submit(google, 'google-python-events.ics')).body.status, 'approved');
  assert.equal((await submit('https://mobilizon.fr/@othergroup/feed/ics', 'mobilizon-lyontechhub.ics')).body.status, 'approved');
  const luma = await submit('https://api.luma.com/ics/get?entity=calendar&id=cal-OtherNamed1234', 'luma-calendar-journaling.ics');
  assert.equal(luma.body.status, 'approved');
});

test('everything else waits for review: default calendars, city pages, other hosts, feeds without events', async () => {
  const personal = await submit('https://api.luma.com/ics/get?entity=calendar&id=cal-EpqkMBrIPXa045L', 'luma-personal-newlab.ics');
  assert.equal(personal.status, 202);
  assert.equal(personal.body.status, 'queued');
  const city = await submit('https://api.luma.com/ics/get?entity=discover&id=discplace-Izx1rQVSh8njYpP', 'luma-city-nyc.ics');
  assert.equal(city.body.status, 'queued', 'an aggregator is reviewed');
  const other = await submit('https://calendar.example.org/club.ics', 'meetup-pythonsd.ics');
  assert.equal(other.body.status, 'queued', 'an unknown host is reviewed');
  const empty = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\nNAME:A Group\r\nEND:VCALENDAR\r\n';
  const noEvents = await submit('https://www.meetup.com/emptygroup/events/ical/', null, empty);
  assert.equal(noEvents.body.status, 'queued', 'a calendar without events is reviewed');
  for (const d of ['luma:cal-EpqkMBrIPXa045L', 'meetup:emptygroup']) assert.equal(h.dir.get(d), null);
});

test('auto-approvals have a daily cap; past it, submissions wait for review', async () => {
  const capped = await harness({ limits: { autoApprovalsPerDay: 1 } });
  try {
    const send = async (group: string) => {
      const url = `https://www.meetup.com/${group}/events/ical/`;
      capped.feeds.set(url, ok(url, readFixture('meetup-pythonsd.ics')));
      return ((await (await capped.post(`${API}/feeds/add`, { url }, from())).json()) as any).status;
    };
    assert.equal(await send('first-group'), 'approved');
    assert.equal(await send('second-group'), 'queued');
  } finally {
    await capped.close();
  }
});

test('the submit form says when a calendar was indexed at once', async () => {
  const url = 'https://www.meetup.com/formgroup/events/ical/';
  h.feeds.set(url, ok(url, readFixture('meetup-pythonsd.ics')));
  const response = await h.post('/submit', `url=${encodeURIComponent(url)}`, from());
  const html = await response.text();
  assert.equal(response.status, 201);
  assert.match(html, /<h1>Added<\/h1>/);
  assert.ok(html.includes('href="/calendar/meetup-formgroup"'));
});
