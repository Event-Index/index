// What an organizer hands the index for the poll service alone (a signer's
// connection): sealed with NIP-44 to the vault's intake key, from a key made
// for the one message. The HTTP service, which holds no secret, seals; only
// the poll service, which holds the signer secret, can open it.

import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44';

// The longest text sealed.
export const MAX_SEALED_TEXT = 4096;

export function sealFor(recipient: string, plaintext: string): string {
  if (plaintext.length > MAX_SEALED_TEXT) throw new Error('too long to seal');
  const sender = generateSecretKey();
  try {
    return JSON.stringify({ p: getPublicKey(sender), c: encrypt(plaintext, getConversationKey(sender, recipient)) });
  } finally {
    sender.fill(0);
  }
}

export function unsealWith(secret: Uint8Array, sealed: string): string {
  const { p, c } = JSON.parse(sealed) as { p: string; c: string };
  if (typeof p !== 'string' || typeof c !== 'string' || c.length > MAX_SEALED_TEXT * 2) throw new Error('not a sealed message');
  return decrypt(c, getConversationKey(secret, p));
}
