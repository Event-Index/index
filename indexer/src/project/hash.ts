// The republish decision: an event is republished when the hash of its
// projected kind, tags and content differs from the last one published.

import { createHash } from 'node:crypto';
import type { EventTemplate } from './nip52.ts';

export function projectionHash(template: EventTemplate): string {
  return createHash('sha256').update(JSON.stringify([template.kind, template.tags, template.content])).digest('hex');
}
