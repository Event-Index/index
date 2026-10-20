// Fetches a feed: conditional GET, gzip, a size cap, Retry-After, and no
// request to a private address. The address is checked when the connection
// is made (so a DNS answer cannot change between check and use), and the URL
// is checked again on every redirect.

import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';
import { checkFeedUrl, isPublicAddress, MAX_FEED_BYTES } from '../directory/validate.ts';
import { parseRetryAfter } from '../rules/schedule.ts';

export const USER_AGENT = 'EventIndex/0.1 (+https://eventindex.space)';
const MAX_REDIRECTS = 5;
// A socket idle for this long fails the fetch...
const TIMEOUT_MS = 30_000;
// ...and the whole fetch, every redirect and the body included, ends here.
const DEADLINE_MS = 60_000;

export interface Validators {
  etag?: string | null;
  lastModified?: string | null;
}

export type FetchResult =
  | { status: 'ok'; text: string; etag: string | null; lastModified: string | null; finalUrl: string }
  | { status: 'not-modified' }
  | { status: 'error'; code: string; retryAfter?: number };

export interface NetworkOptions {
  resolve?: (host: string) => Promise<string[]>;
  addressAllowed?: (ip: string, host: string) => boolean;
  maxBytes?: number;
  timeoutMs?: number;
  deadlineMs?: number;
  now?: () => number;
  // What is asked for: a feed unless given.
  accept?: string;
}

class FetchError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

async function defaultResolve(host: string): Promise<string[]> {
  return (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);
}

function guardedLookup(resolve: (host: string) => Promise<string[]>, allowed: (ip: string, host: string) => boolean): LookupFunction {
  return ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    resolve(hostname).then(
      (addresses) => {
        const usable = addresses.filter((ip) => allowed(ip, hostname));
        if (usable.length === 0) {
          callback(new FetchError(addresses.length === 0 ? 'dns' : 'private-address'));
          return;
        }
        const entries = usable.map((address) => ({ address, family: isIP(address) }));
        if (options?.all) callback(null, entries);
        else callback(null, entries[0]!.address, entries[0]!.family);
      },
      () => callback(new FetchError('dns')),
    );
  }) as LookupFunction;
}

interface Hop {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Readable;
}

function request(url: URL, headers: Record<string, string>, lookup: LookupFunction, timeoutMs: number, signal: AbortSignal): Promise<Hop> {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(url, { method: 'GET', headers, lookup, timeout: timeoutMs, signal }, (res) => {
      resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res });
    });
    req.on('timeout', () => req.destroy(new FetchError('timeout')));
    req.on('error', (error) => reject(error instanceof FetchError ? error : new FetchError(signal.aborted ? 'timeout' : errorCode(error))));
    req.end();
  });
}

function errorCode(error: unknown): string {
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof FetchError) return cause.code;
  const code = (error as { code?: string }).code;
  return code ? `network-${code.toLowerCase()}` : 'network';
}

async function readBody(hop: Hop, maxBytes: number, signal: AbortSignal): Promise<string> {
  const declared = Number(hop.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    hop.body.destroy();
    throw new FetchError('too-large');
  }
  const encoding = String(hop.headers['content-encoding'] ?? '').toLowerCase();
  let stream: Readable = hop.body;
  if (encoding === 'gzip' || encoding === 'x-gzip') stream = hop.body.pipe(createGunzip());
  else if (encoding === 'deflate') stream = hop.body.pipe(createInflate());
  else if (encoding === 'br') stream = hop.body.pipe(createBrotliDecompress());
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) {
        hop.body.destroy();
        throw new FetchError('too-large');
      }
      chunks.push(chunk as Buffer);
    }
  } catch (error) {
    if (error instanceof FetchError) throw error;
    throw new FetchError(signal.aborted ? 'timeout' : 'bad-encoding');
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function fetchFeed(input: string, validators: Validators, options: NetworkOptions = {}): Promise<FetchResult> {
  const allowed = options.addressAllowed ?? ((ip: string) => isPublicAddress(ip));
  const lookup = guardedLookup(options.resolve ?? defaultResolve, allowed);
  const maxBytes = options.maxBytes ?? MAX_FEED_BYTES;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  let url = new URL(input.trim().replace(/^webcals?:\/\//i, 'https://'));
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), options.deadlineMs ?? DEADLINE_MS);

  try {
    for (let hops = 0; ; hops += 1) {
      const check = checkFeedUrl(url.toString());
      if (!check.ok) throw new FetchError(check.reason);
      const literal = url.hostname.replace(/^\[|\]$/g, '');
      if (isIP(literal) && !allowed(literal, literal)) throw new FetchError('private-address');

      const headers: Record<string, string> = {
        'user-agent': USER_AGENT,
        accept: options.accept ?? 'text/calendar, application/calendar+json;q=0.5, */*;q=0.1',
        'accept-encoding': 'gzip, deflate, br',
      };
      if (hops === 0 && validators.etag) headers['if-none-match'] = validators.etag;
      if (hops === 0 && validators.lastModified) headers['if-modified-since'] = validators.lastModified;

      const hop = await request(url, headers, lookup, options.timeoutMs ?? TIMEOUT_MS, controller.signal);
      if (hop.status >= 300 && hop.status < 400 && hop.status !== 304) {
        hop.body.resume();
        const location = hop.headers.location;
        if (!location) throw new FetchError(`http-${hop.status}`);
        if (hops >= MAX_REDIRECTS) throw new FetchError('too-many-redirects');
        url = new URL(location, url);
        continue;
      }
      if (hop.status === 304) {
        hop.body.resume();
        return { status: 'not-modified' };
      }
      if (hop.status !== 200) {
        hop.body.resume();
        const retryAfter = parseRetryAfter(hop.headers['retry-after'] as string | undefined, now());
        return retryAfter === null ? { status: 'error', code: `http-${hop.status}` } : { status: 'error', code: `http-${hop.status}`, retryAfter };
      }
      const text = await readBody(hop, maxBytes, controller.signal);
      return {
        status: 'ok',
        text,
        etag: (hop.headers.etag as string | undefined) ?? null,
        lastModified: (hop.headers['last-modified'] as string | undefined) ?? null,
        finalUrl: url.toString(),
      };
    }
  } catch (error) {
    if (controller.signal.aborted) return { status: 'error', code: 'timeout' };
    return { status: 'error', code: error instanceof FetchError ? error.code : errorCode(error) };
  } finally {
    clearTimeout(deadline);
  }
}
