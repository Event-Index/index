// Event Index: requests signed with an organizer's own nostr key, through a
// browser extension (NIP-07). Each request is signed for itself (NIP-98) and
// posted to this site; nothing is sent anywhere else, and the key never
// leaves the extension.
'use strict';

(() => {
  const status = document.querySelector('[data-status]');
  const say = (text) => {
    if (status) status.textContent = text;
  };
  let pubkey = null;

  const hex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
  const sha256 = async (text) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  const base64 = (text) => {
    let binary = '';
    for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
    return btoa(binary);
  };

  // npub (NIP-19): the key in bech32, as people know it.
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  function polymod(values) {
    const generator = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let check = 1;
    for (const value of values) {
      const top = check >>> 25;
      check = ((check & 0x1ffffff) << 5) ^ value;
      for (let i = 0; i < 5; i += 1) if ((top >>> i) & 1) check ^= generator[i];
    }
    return check;
  }
  function npub(key) {
    const words = [];
    let acc = 0;
    let bits = 0;
    for (const pair of key.match(/../g)) {
      acc = ((acc << 8) | parseInt(pair, 16)) & 0xfff;
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        words.push((acc >>> bits) & 31);
      }
    }
    if (bits > 0) words.push((acc << (5 - bits)) & 31);
    const prefix = 'npub';
    const expanded = [...prefix].map((c) => c.charCodeAt(0) >> 5).concat([0], [...prefix].map((c) => c.charCodeAt(0) & 31));
    const mod = polymod([...expanded, ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
    const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31);
    return `${prefix}1${[...words, ...checksum].map((w) => CHARSET[w]).join('')}`;
  }

  function extension() {
    if (!window.nostr) throw new Error('No nostr extension was found in this browser. Install one that supports NIP-07, then reload this page.');
    return window.nostr;
  }

  async function signIn() {
    pubkey = await extension().getPublicKey();
    const who = document.querySelector('[data-who]');
    if (who) {
      const name = npub(pubkey);
      who.textContent = `Signed in as ${name.slice(0, 14)}…${name.slice(-6)}.`;
    }
    for (const step of document.querySelectorAll('[data-after-sign-in]')) step.hidden = false;
    return pubkey;
  }

  // A request signed for its URL, method and body.
  async function post(path, body) {
    if (!pubkey) await signIn();
    const text = JSON.stringify(body);
    const event = await extension().signEvent({
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      content: '',
      tags: [['u', new URL(path, window.location.origin).href], ['method', 'POST'], ['payload', await sha256(text)]],
    });
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Nostr ${base64(JSON.stringify(event))}` },
      body: text,
    });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(answer.message || `The index answered ${response.status}.`);
    return answer;
  }

  // Runs a step, saying what happened in the status line.
  const run = (work) => async (event) => {
    if (event) event.preventDefault();
    say('Working…');
    try {
      say(await work(event));
    } catch (error) {
      say(error.message);
    }
  };

  const signInButton = document.querySelector('[data-sign-in]');
  if (signInButton) signInButton.addEventListener('click', run(async () => (await signIn(), '')));

  const claim = document.querySelector('form[data-claim]');
  if (claim) {
    const delegated = claim.querySelector('[data-when="delegated"]');
    const sync = () => {
      delegated.hidden = claim.elements.mode.value !== 'delegated';
    };
    claim.addEventListener('change', sync);
    sync();
    claim.addEventListener('submit', run(async () => {
      const mode = claim.elements.mode.value;
      const body = mode === 'delegated' ? { mode, bunker: claim.elements.bunker.value.trim() } : { mode };
      const answer = await post(claim.dataset.claim, body);
      const result = document.querySelector('[data-result]');
      result.querySelector('[data-token]').textContent = answer.token;
      result.querySelector('[data-instructions]').textContent = answer.instructions;
      const nip05 = result.querySelector('form[data-nip05]');
      if (nip05 && answer.nip05_domains && answer.nip05_domains.length) {
        result.querySelector('[data-domains]').textContent = answer.nip05_domains.join(' or ');
        nip05.hidden = false;
        nip05.addEventListener('submit', run(async () => {
          await post(`${claim.dataset.claim}/${answer.claim}/nip05`, { nip05: nip05.elements.nip05.value.trim() });
          return 'Checked: the calendar\'s domain names your key. A maintainer reviews the claim next.';
        }));
      }
      claim.hidden = true;
      result.hidden = false;
      const note = document.querySelector('[data-claim-note]');
      if (note) note.hidden = true;
      return 'Your claim was received.';
    }));
  }

  const disconnect = document.querySelector('[data-disconnect]');
  if (disconnect) {
    disconnect.addEventListener('click', run(async () => (await post(disconnect.closest('[data-signer]').dataset.signer, { action: 'disconnect' })).message));
  }

  const connect = document.querySelector('form[data-connect]');
  if (connect) {
    connect.addEventListener('submit', run(async () => (await post(connect.dataset.signer, { action: 'connect', bunker: connect.elements.bunker.value.trim() })).message));
  }

  const native = document.querySelector('form[data-native]');
  if (native) {
    native.addEventListener('submit', run(async () => {
      const answer = await post(native.dataset.native, { city: native.elements.city.value });
      if (answer.status === 'updated') return `Saved. Your calendar's page: /calendar/${answer.local_name}`;
      const found = `${answer.events} calendar event${answer.events === 1 ? '' : 's'}`;
      return `Listed${answer.name ? `: ${answer.name}` : ''}, with ${found} found under your key. Its page: /calendar/${answer.local_name}`;
    }));
  }

  const removeNow = document.querySelector('[data-remove-now]');
  if (removeNow) {
    removeNow.addEventListener('click', run(async () => (await post(removeNow.closest('[data-remove]').dataset.remove, {})).message));
  }
})();
