// Keeps form spam out of the two forms anyone can send without a key (the
// remove form and the submit form), in memory only: nothing about a visitor
// is written anywhere.
//
// Each form the site renders carries a token the API signs with a secret it
// holds for as long as it runs: the time it was rendered, for what (a
// calendar's remove form, or the submit form). A form sent without one, with
// another form's, before a person could have filled it in, after a day, or a
// second time is blocked; so is one whose hidden field, which people never
// see, was filled in. A token from before a restart is not taken: the form
// comes back fresh, to send again.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const FORM_FIELD = 'form';
// The hidden field: a name browsers do not fill in for people.
export const HONEYPOT = 'topic';
export const FORM_MIN_SECONDS = 3;
export const FORM_MAX_AGE = 86400;
// A message this long, sent again, is a duplicate; a shorter one ("please
// remove us") is common.
export const DUPLICATE_MIN_LENGTH = 40;
const MAX_REMEMBERED = 50_000;

export type Blocked = 'no-form-token' | 'form-expired' | 'too-fast' | 'form-reused' | 'honeypot';

export function formGuard(secret: Uint8Array = randomBytes(32)) {
  const sign = (purpose: string, at: number) => createHmac('sha256', secret).update(`${purpose}\n${at}`).digest('base64url').slice(0, 32);
  // Tokens used, until they would have expired anyway.
  const used = new Map<string, number>();
  return {
    issue(purpose: string, now: number): string {
      return `${now}.${sign(purpose, now)}`;
    },
    check(purpose: string, fields: Record<string, unknown>, now: number): Blocked | null {
      const bait = fields[HONEYPOT];
      if (typeof bait === 'string' && bait !== '') return 'honeypot';
      const token = fields[FORM_FIELD];
      const match = typeof token === 'string' ? /^(\d{1,12})\.([A-Za-z0-9_-]{32})$/.exec(token) : null;
      if (!match) return 'no-form-token';
      const at = Number(match[1]);
      const expected = Buffer.from(sign(purpose, at));
      if (!timingSafeEqual(expected, Buffer.from(match[2]!)) || at > now) return 'no-form-token';
      if (now - at > FORM_MAX_AGE) return 'form-expired';
      if (now - at < FORM_MIN_SECONDS) return 'too-fast';
      if (used.has(token as string)) return 'form-reused';
      if (used.size >= MAX_REMEMBERED) for (const [t, until] of used) if (until <= now) used.delete(t);
      used.set(token as string, at + FORM_MAX_AGE);
      return null;
    },
  };
}

export type FormGuard = ReturnType<typeof formGuard>;

// Two messages are the same when they differ only in case and spacing, and
// are long enough to count.
export function sameMessage(a: string | null, b: string | null): boolean {
  const fold = (m: string | null) => (m ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  return fold(a).length >= DUPLICATE_MIN_LENGTH && fold(a) === fold(b);
}
