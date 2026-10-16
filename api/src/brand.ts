// The logo files (../../brand/): the favicon set at the site root, the mark
// and wordmark under /brand/, and the site's typeface under /brand/fonts/.
// Read once at start; nothing else in the folder is served.

import { readFileSync, readdirSync } from 'node:fs';

const TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

export interface BrandFile {
  type: string;
  body: Buffer;
}

export function brandFiles(dir: URL = new URL('../../brand/', import.meta.url)): Map<string, BrandFile> {
  const files = new Map<string, BrandFile>();
  const add = (folder: string, prefix: string) => {
    for (const name of readdirSync(new URL(`${folder}/`, dir))) {
      const type = TYPES[name.slice(name.lastIndexOf('.'))];
      if (type && /^[a-z0-9@.-]+$/.test(name)) files.set(`${prefix}${name}`, { type, body: readFileSync(new URL(`${folder}/${name}`, dir)) });
    }
  };
  add('favicon', '/');
  add('mark', '/brand/');
  add('wordmark', '/brand/');
  add('fonts', '/brand/fonts/');
  return files;
}
