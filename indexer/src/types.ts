export type Source = 'luma' | 'meetup' | 'mobilizon' | 'gancio' | 'google' | 'ics' | 'nostr';

// A calendar's events are signed by its own key. An aggregator only leads
// the index to calendars.
export type Role = 'calendar' | 'aggregator';
