import type { Source } from '../types.ts';
import type { Adapter } from './types.ts';
import { luma } from './luma.ts';
import { meetup } from './meetup.ts';
import { mobilizon } from './mobilizon.ts';
import { gancio } from './gancio.ts';
import { google } from './google.ts';
import { generic } from './generic.ts';

export type { Adapter, ContentPolicy, CalendarSide } from './types.ts';

const adapters: Partial<Record<Source, Adapter>> = { luma, meetup, mobilizon, gancio, google };

export function adapterFor(source: Source): Adapter {
  return adapters[source] ?? generic(source);
}
