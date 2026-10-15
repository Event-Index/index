import { OPEN, type Adapter } from './types.ts';
import type { Source } from '../types.ts';

export function generic(source: Source): Adapter {
  return { source, policy: OPEN, descriptionFormat: 'text' };
}
