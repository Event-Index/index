import type ICAL from 'ical.js';
import type { Source } from '../types.ts';

// What public projections may carry for a source. Feeds from platforms whose
// terms reserve event content get titles, times, places, a summary and a
// link back; the full description and images stay in the record.
export interface ContentPolicy {
  fullDescription: boolean;
  images: boolean;
}

export interface CalendarSide {
  // The calendar's own name as the feed states it (NAME or X-WR-CALNAME).
  name: string | null;
}

export interface Adapter {
  source: Source;
  policy: ContentPolicy;
  // How DESCRIPTION is written when it is not HTML.
  descriptionFormat: 'text' | 'markdown';
  isDefaultCalendarName?(name: string): boolean;
  isDefaultCalendarDescription?(text: string): boolean;
  isDefaultOrganizerName?(name: string): boolean;
  // Adjusts one VEVENT in place before the record's property set applies.
  event?(vevent: ICAL.Component, calendar: CalendarSide): void;
  // The part of a plain-text description a summary is cut from.
  summaryText?(plain: string): string;
}

export const OPEN: ContentPolicy = { fullDescription: true, images: true };
export const RESERVED: ContentPolicy = { fullDescription: false, images: false };
