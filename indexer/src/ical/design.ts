// Value types of the properties RFC 7986 and RFC 9073 add, which ical.js does
// not know: without them it neither unescapes their text when reading nor
// escapes it when writing, and a line break in one breaks the record.

import ICAL from 'ical.js';

const TYPES: Record<string, { defaultType: string; allowedTypes?: string[]; multiValue?: string }> = {
  // RFC 7986
  name: { defaultType: 'text' },
  color: { defaultType: 'text' },
  'refresh-interval': { defaultType: 'duration' },
  source: { defaultType: 'uri' },
  image: { defaultType: 'uri', allowedTypes: ['uri', 'binary'] },
  conference: { defaultType: 'uri' },
  // RFC 9073
  'styled-description': { defaultType: 'text', allowedTypes: ['text', 'uri'] },
  'structured-data': { defaultType: 'text', allowedTypes: ['text', 'uri', 'binary'] },
  'location-type': { defaultType: 'text', multiValue: ',' },
  'participant-type': { defaultType: 'text' },
  'resource-type': { defaultType: 'text' },
  'calendar-address': { defaultType: 'cal-address' },
  // Microsoft's HTML description, written as TEXT.
  'x-alt-desc': { defaultType: 'text' },
};

const properties = ICAL.design.icalendar.property as Record<string, unknown>;
for (const [name, type] of Object.entries(TYPES)) properties[name] ??= type;
