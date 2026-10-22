import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formGuard, FORM_FIELD, HONEYPOT, FORM_MIN_SECONDS, FORM_MAX_AGE, sameMessage } from '../src/guard.ts';
import { NOW } from '../../indexer/test/helpers.ts';

test('a form the guard issued is let through once, after the least time a person takes to send it', () => {
  const guard = formGuard();
  const token = guard.issue('remove meetup:x', NOW);
  assert.equal(guard.check('remove meetup:x', { [FORM_FIELD]: token }, NOW + FORM_MIN_SECONDS), null);
  assert.equal(guard.check('remove meetup:x', { [FORM_FIELD]: token }, NOW + 60), 'form-reused');
});

test('a form sent too fast, after a day, for another calendar, forged, from before a restart or without its token is blocked', () => {
  const guard = formGuard();
  const token = guard.issue('remove meetup:x', NOW);
  assert.equal(guard.check('remove meetup:x', { [FORM_FIELD]: token }, NOW + 1), 'too-fast');
  assert.equal(guard.check('remove meetup:y', { [FORM_FIELD]: token }, NOW + 10), 'no-form-token');
  assert.equal(guard.check('remove meetup:x', { [FORM_FIELD]: token }, NOW + FORM_MAX_AGE + 1), 'form-expired');
  assert.equal(guard.check('remove meetup:x', {}, NOW + 10), 'no-form-token');
  assert.equal(guard.check('remove meetup:x', { [FORM_FIELD]: `${NOW}.forged` }, NOW + 10), 'no-form-token');
  assert.equal(guard.check('remove meetup:x', { [FORM_FIELD]: ['a', 'b'] }, NOW + 10), 'no-form-token');
  assert.equal(formGuard().check('remove meetup:x', { [FORM_FIELD]: token }, NOW + 10), 'no-form-token', 'another guard\'s token is not taken');
  // None of these used the token up.
  assert.equal(guard.check('remove meetup:x', { [FORM_FIELD]: token }, NOW + 10), null);
});

test('a form with its hidden field filled in is blocked', () => {
  const guard = formGuard();
  const token = guard.issue('submit', NOW);
  assert.equal(guard.check('submit', { [FORM_FIELD]: token, [HONEYPOT]: 'https://spam.example' }, NOW + 10), 'honeypot');
  assert.equal(guard.check('submit', { [FORM_FIELD]: token, [HONEYPOT]: '' }, NOW + 10), null, 'left empty, it passes');
});

test('two messages are the same when they differ only in case and spacing, and only a long one counts', () => {
  const spam = 'Submit eventindex.space in Google\'s Search Index today at siteindex.example';
  assert.ok(sameMessage(spam, `  ${spam.toUpperCase().replace(/ /g, '\n  ')} `));
  assert.ok(!sameMessage(spam, `${spam}!`));
  assert.ok(!sameMessage('Please remove us.', 'please remove   us.'), 'a short message is common: never a duplicate');
  assert.ok(!sameMessage(null, null));
});
