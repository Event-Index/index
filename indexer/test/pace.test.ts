import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostPacer } from '../src/enrich/pace.ts';
import type { FetchResult } from '../src/poller/fetch.ts';

function clock() {
  const c = { ms: 1_000_000, slept: [] as number[] };
  return { c, now: () => c.ms, sleep: async (ms: number) => { c.slept.push(ms); c.ms += ms; } };
}

test('requests to a paced host are at least the interval apart, whoever makes them; other hosts wait for nothing', async () => {
  const { c, now, sleep } = clock();
  const pacer = hostPacer({ hosts: ['meetup.com'], intervalMs: 5000, now, sleep });
  const seen: Array<[string, number]> = [];
  const fetch = async (url: string): Promise<FetchResult> => {
    seen.push([url, c.ms]);
    c.ms += 300;
    return { status: 'not-modified' };
  };
  const feeds = pacer.wrap(fetch);
  const pages = pacer.wrap(fetch);
  await feeds('https://www.meetup.com/a/events/ical/', {});
  await pages('https://www.meetup.com/a/events/1/', {});
  await feeds('https://luma.com/ics/x', {});
  await pages('https://meetup.com/b/events/2/', {});
  await feeds('https://notmeetup.com/x', {});
  const meetup = seen.filter(([u]) => /\/\/(www\.)?meetup\.com\//.test(u)).map(([, at]) => at);
  assert.equal(meetup.length, 3);
  for (let i = 1; i < meetup.length; i += 1) assert.ok(meetup[i]! - meetup[i - 1]! >= 5000, `${meetup[i]! - meetup[i - 1]!} ms apart`);
  const others = seen.filter(([u]) => !/\/\/(www\.)?meetup\.com\//.test(u));
  assert.equal(others.length, 2);
  assert.equal(c.slept.length, 2, 'only the paced host waited');
});

test('requests to a paced host made at once still go one at a time', async () => {
  const { c, now, sleep } = clock();
  const pacer = hostPacer({ hosts: ['meetup.com'], intervalMs: 5000, now, sleep });
  const at: number[] = [];
  const fetch = pacer.wrap(async (): Promise<FetchResult> => { at.push(c.ms); return { status: 'not-modified' }; });
  await Promise.all([1, 2, 3].map((n) => fetch(`https://www.meetup.com/g/events/${n}/`, {})));
  assert.deepEqual(at.map((t) => t - at[0]!), [0, 5000, 10000]);
});
