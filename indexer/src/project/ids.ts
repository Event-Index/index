// Identifiers shared by every projection of a record.

import { createHash } from 'node:crypto';

function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

// The `d` of an event's NIP-52 projection: sha256 of the UID, or of
// UID ":" occurrence key for an occurrence of a recurring event.
export function nostrD(uid: string, occurrence?: string): string {
  return sha256(occurrence === undefined ? uid : `${uid}:${occurrence}`).toString('hex');
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export function base32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

// The public event id: stable across polls, rebuilds and claims, unique
// across calendars, safe in a URL. 160 bits as 32 base32 characters.
export function publicEventId(calendarD: string, eventD: string): string {
  return base32(sha256(`${calendarD}\u0000${eventD}`).subarray(0, 20));
}
