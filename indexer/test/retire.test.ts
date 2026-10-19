import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retirementTemplates, MAX_DELETION_TAGS } from '../src/project/retire.ts';
import { RETIRED_NAME } from '../src/project/profile.ts';

const PK = 'ab'.repeat(32);
const id = (n: number) => n.toString(16).padStart(64, '0');

test('a retired key\'s last profile, then deletions of every address and version it signed, with their kinds', () => {
  const [profile, ...deletions] = retirementTemplates({
    pubkey: PK, localName: 'luma-cal-abc',
    addresses: [
      { kind: 10002, d: '', versions: [id(1), id(2)] },
      { kind: 31923, d: 'evt-1', versions: [id(3)] },
      { kind: 31924, d: 'calendar', versions: [id(4), id(5)] },
    ],
  });
  assert.equal(profile!.kind, 0);
  const content = JSON.parse(profile!.content);
  assert.equal(content.name, RETIRED_NAME);
  assert.match(content.about, /https:\/\/eventindex\.space\/calendar\/luma-cal-abc/);
  assert.equal(content.nip05, undefined);
  assert.equal(content.website, undefined);
  assert.equal(deletions.length, 1);
  const tags = deletions[0]!.tags;
  assert.equal(deletions[0]!.kind, 5);
  assert.deepEqual(tags.filter((t) => t[0] === 'e').map((t) => t[1]), [id(1), id(2), id(3), id(4), id(5)]);
  assert.deepEqual(tags.filter((t) => t[0] === 'a').map((t) => t[1]), [`10002:${PK}:`, `31923:${PK}:evt-1`, `31924:${PK}:calendar`]);
  assert.deepEqual(tags.filter((t) => t[0] === 'k').map((t) => t[1]), ['10002', '31923', '31924']);
});

test('a key that signed many events has its deletions split, an address never across two', () => {
  const addresses = Array.from({ length: 150 }, (_, n) => ({ kind: 31923, d: `evt-${n}`, versions: [id(2 * n), id(2 * n + 1)] }));
  const [, ...deletions] = retirementTemplates({ pubkey: PK, localName: 'x', addresses });
  assert.ok(deletions.length > 1);
  for (const deletion of deletions) assert.ok(deletion.tags.length <= MAX_DELETION_TAGS, String(deletion.tags.length));
  const named = deletions.flatMap((d) => d.tags.filter((t) => t[0] === 'a').map((t) => t[1]));
  assert.equal(named.length, 150);
  assert.equal(new Set(named).size, 150);
  // Each address's versions travel with it.
  for (const deletion of deletions) {
    const ds = deletion.tags.filter((t) => t[0] === 'a').map((t) => Number(t[1]!.split(':evt-')[1]));
    const es = deletion.tags.filter((t) => t[0] === 'e').map((t) => parseInt(t[1]!, 16)).sort((a, b) => a - b);
    assert.deepEqual(es, ds.flatMap((n) => [2 * n, 2 * n + 1]).sort((a, b) => a - b));
  }
});

test('a key that signed nothing but its profile gets only the retired profile', () => {
  const all = retirementTemplates({ pubkey: PK, localName: 'x', addresses: [] });
  assert.deepEqual(all.map((t) => t.kind), [0]);
});

test('an address with more versions than one deletion holds is named in each of its deletions', () => {
  const versions = Array.from({ length: 450 }, (_, n) => id(n));
  const [, ...deletions] = retirementTemplates({ pubkey: PK, localName: 'x', addresses: [{ kind: 31924, d: 'calendar', versions }] });
  assert.equal(deletions.length, 3);
  for (const deletion of deletions) {
    assert.ok(deletion.tags.length <= MAX_DELETION_TAGS);
    assert.deepEqual(deletion.tags.filter((t) => t[0] !== 'e'), [['a', `31924:${PK}:calendar`], ['k', '31924']]);
  }
  assert.deepEqual(deletions.flatMap((d) => d.tags.filter((t) => t[0] === 'e').map((t) => t[1])), versions);
});
