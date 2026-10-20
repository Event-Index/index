import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEventPage } from '../src/enrich/event-page.ts';
import { readPage } from './helpers.ts';

const page = (...blocks: unknown[]) => blocks.map((b) => `<script type="application/ld+json">${JSON.stringify(b)}</script>`).join('\n');
const event = (extra: Record<string, unknown>) => ({ '@context': 'https://schema.org', '@type': 'Event', name: 'E', startDate: '2026-10-22T19:00:00-07:00', ...extra });

test('a venue is its name, street address and locality, each once', () => {
  assert.deepEqual(readEventPage(readPage('synthetic/meetup-venue.html')), { location: 'Example Hall, 100 Example Way, San Diego, CA', cancelled: false });
  const separate = page(event({ location: { '@type': 'Place', name: 'Example Library', address: { '@type': 'PostalAddress', streetAddress: '5 Sample Street', addressLocality: 'Atlanta' } } }));
  assert.equal(readEventPage(separate)!.location, 'Example Library, 5 Sample Street, Atlanta');
  const addressText = page(event({ location: { '@type': 'Place', name: 'Hall', address: '9 Text Road, Denver' } }));
  assert.equal(readEventPage(addressText)!.location, 'Hall, 9 Text Road, Denver');
  const nameIsStreet = page(event({ location: { '@type': 'Place', name: '19 Sample Ave S', address: { streetAddress: '19 Sample Ave S, Nashville, TN', addressLocality: 'Nashville' } } }));
  assert.equal(readEventPage(nameIsStreet)!.location, '19 Sample Ave S, Nashville, TN');
});

test('an online event is "Online"; a mixed one keeps its venue', () => {
  assert.deepEqual(readEventPage(readPage('synthetic/meetup-online.html')), { location: 'Online', cancelled: false });
  const mixed = page(event({
    eventAttendanceMode: 'https://schema.org/MixedEventAttendanceMode',
    location: [{ '@type': 'VirtualLocation', url: 'https://example.org/stream' }, { '@type': 'Place', name: 'Hall', address: { streetAddress: '1 Road', addressLocality: 'Austin' } }],
  }));
  assert.equal(readEventPage(mixed)!.location, 'Hall, 1 Road, Austin');
  assert.equal(readEventPage(page(event({ eventStatus: 'https://schema.org/EventMovedOnline', location: { '@type': 'Place', name: 'Hall' } })))!.location, 'Online');
});

test('a cancelled event says so, in an array or a graph', () => {
  assert.deepEqual(readEventPage(readPage('synthetic/meetup-cancelled.html')), { location: 'Example Library, 5 Sample Street, Atlanta', cancelled: true });
  const graph = page({ '@context': 'https://schema.org', '@graph': [event({ eventStatus: 'http://schema.org/EventCancelled' })] });
  assert.deepEqual(readEventPage(graph), { location: null, cancelled: true });
});

test('a venue the page does not show is not taken, and the page\'s app data is never read', () => {
  assert.deepEqual(readEventPage(readPage('synthetic/meetup-members-only.html')), { location: null, cancelled: false });
  for (const name of ['Location visible to members', 'Needs a location', 'TBA']) {
    assert.equal(readEventPage(page(event({ location: { '@type': 'Place', name } })))!.location, null, name);
  }
  assert.equal(readEventPage(page(event({ location: { '@type': 'Place', address: { '@type': 'PostalAddress', addressCountry: 'us' } } })))!.location, null);
});

test('a page without an event in its JSON-LD gives nothing; a broken block is passed over', () => {
  assert.equal(readEventPage('<html><body>No data</body></html>'), null);
  assert.equal(readEventPage(page({ '@context': 'https://schema.org', '@type': 'Organization', name: 'Meetup' })), null);
  const broken = `<script type="application/ld+json">{"@type": "Event",</script>${page(event({ location: { '@type': 'Place', name: 'Hall', address: { streetAddress: '2 Road' } } }))}`;
  assert.equal(readEventPage(broken)!.location, 'Hall, 2 Road');
});

test('venue text is plain and short', () => {
  const long = page(event({ location: { '@type': 'Place', name: `  Big\n  Hall  ${'x'.repeat(400)}`, address: { streetAddress: '3 Road' } } }));
  const location = readEventPage(long)!.location!;
  assert.ok(location.startsWith('Big Hall x'));
  assert.ok(location.length <= 300);
  assert.ok(!/\s{2}|\n/.test(location));
});
