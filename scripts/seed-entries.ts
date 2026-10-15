// Turns a seed list into unsigned directory entries, one JSON event per line,
// for the index key to sign (for example with `nak event`), and reports each
// calendar's outcome on stderr.
//
//   CALENDAR_KEY_SECRET=<64 hex> node scripts/seed-entries.ts <seed.json> \
//     --index-pubkey <hex> --vault <vault.db> > entries.jsonl
//
// Calendar keys are created in the vault for the calendars that are filed.

import { readFileSync } from 'node:fs';
import { seedEntries, type Seed } from '../indexer/src/directory/seed.ts';
import { fetchFeed } from '../indexer/src/poller/fetch.ts';
import { openVault } from '../indexer/src/store/vault-db.ts';

function option(name: string): string {
  const at = process.argv.indexOf(name);
  const value = at > 0 ? process.argv[at + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const seedPath = process.argv[2];
  if (!seedPath) throw new Error('usage: seed-entries.ts <seed.json> --index-pubkey <hex> --vault <path>');
  const secret = process.env['CALENDAR_KEY_SECRET'] ?? '';
  if (!/^[0-9a-f]{64}$/i.test(secret)) throw new Error('CALENDAR_KEY_SECRET must be 64 hex digits');
  const vault = openVault(option('--vault'), Buffer.from(secret, 'hex'));
  try {
    const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as Seed;
    const { entries, report } = await seedEntries(seed, {
      fetch: (url) => fetchFeed(url, {}),
      indexPubkey: option('--index-pubkey'),
      now: Math.floor(Date.now() / 1000),
      keyFor: (d) => vault.createKey(d),
    });
    for (const entry of entries) process.stdout.write(`${JSON.stringify(entry)}\n`);
    for (const line of report) process.stderr.write(`${JSON.stringify(line)}\n`);
  } finally {
    vault.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});
