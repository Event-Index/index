// The calendar keys' retirement (spec/indexer-rules.md § 8): every event they
// signed to retire, kept once signed so it can be sent again without the
// keys, and so what remains on each relay can be counted after the keys are
// destroyed. The facts mark its steps.

import type { VerifiedEvent } from 'nostr-tools/pure';
import type { IndexDb } from './index-db.ts';

// Asked (admin), sent to every relay (indexer), destruction asked (admin), keys destroyed (indexer).
export const RETIRE = 'calendar_keys_retire';
export const RETIRED = 'calendar_keys_retired';
export const DESTROY = 'calendar_keys_destroy';
export const DESTROYED = 'calendar_keys_destroyed';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS retirement (
  id TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,
  calendar_d TEXT NOT NULL,
  kind INTEGER NOT NULL,
  event TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS retirement_pubkey ON retirement(pubkey);
`;

export function retirementStore(index: IndexDb) {
  const db = index.raw;
  db.exec(SCHEMA);
  const insert = db.prepare('INSERT OR IGNORE INTO retirement (id, pubkey, calendar_d, kind, event) VALUES (?, ?, ?, ?, ?)');
  return {
    put: db.transaction((events: Array<{ calendarD: string; event: VerifiedEvent }>) => {
      for (const { calendarD, event } of events) insert.run(event.id, event.pubkey, calendarD, event.kind, JSON.stringify(event));
    }),
    all: () => db.prepare<[], { event: string }>('SELECT event FROM retirement ORDER BY pubkey, kind, id').all().map((r) => JSON.parse(r.event) as VerifiedEvent),
    count: () => db.prepare<[], { n: number }>('SELECT count(*) AS n FROM retirement').get()!.n,
    keys: () => db.prepare<[], { pubkey: string; calendar_d: string }>('SELECT DISTINCT pubkey, calendar_d FROM retirement ORDER BY calendar_d')
      .all().map((r) => ({ pubkey: r.pubkey, calendarD: r.calendar_d })),
  };
}

export type RetirementStore = ReturnType<typeof retirementStore>;
