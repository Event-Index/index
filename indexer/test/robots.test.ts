import { test } from 'node:test';
import assert from 'node:assert/strict';
import { robotsAllows } from '../src/enrich/robots.ts';

// Shaped like a large site's file: several `*` groups, rules after the last
// group's sitemap lines, and a group for another crawler.
const SITE = `Sitemap: https://www.example.org/sitemap.xml

User-agent: *
Disallow: /files/
Disallow: /n/*

User-agent: *
Disallow: */events/rss/*
Disallow: /*?keywords=*

Sitemap: https://www.example.org/other-sitemap.xml
Disallow: /_next/data/*
Disallow: /gql*
Allow: */login/*

User-agent: OtherBot
Disallow: /
`;
const AGENT = 'EventIndex';

test('the * groups apply, together, and another crawler\'s group does not', () => {
  assert.equal(robotsAllows(SITE, AGENT, '/example-group/events/100000001/'), true);
  assert.equal(robotsAllows(SITE, AGENT, '/_next/data/build/example-group/events/100000001.json'), false);
  assert.equal(robotsAllows(SITE, AGENT, '/files/x.png'), false);
  assert.equal(robotsAllows(SITE, AGENT, '/example-group/events/rss/feed'), false);
  assert.equal(robotsAllows(SITE, AGENT, '/find/?keywords=python'), false);
  assert.equal(robotsAllows(SITE, AGENT, '/gql2'), false);
  assert.equal(robotsAllows(SITE, 'OtherBot', '/example-group/events/100000001/'), false);
});

test('a group naming the index replaces the * groups', () => {
  const own = `User-agent: *\nDisallow: /\n\nUser-agent: eventindex\nUser-agent: SomeBot\nDisallow: /private/\n`;
  assert.equal(robotsAllows(own, AGENT, '/example-group/events/1/'), true);
  assert.equal(robotsAllows(own, AGENT, '/private/x'), false);
  assert.equal(robotsAllows(own, 'Unknown', '/example-group/events/1/'), false);
});

test('the longest match wins, an allow wins a tie, and $ ends a pattern', () => {
  const rules = `User-agent: *\nDisallow: /a/\nAllow: /a/b/\nDisallow: /a/b/c\nDisallow: /*.json$\nAllow: /x\nDisallow: /x\n`;
  assert.equal(robotsAllows(rules, AGENT, '/a/z'), false);
  assert.equal(robotsAllows(rules, AGENT, '/a/b/z'), true);
  assert.equal(robotsAllows(rules, AGENT, '/a/b/cd'), false);
  assert.equal(robotsAllows(rules, AGENT, '/data.json'), false);
  assert.equal(robotsAllows(rules, AGENT, '/data.json?v=1'), true);
  assert.equal(robotsAllows(rules, AGENT, '/x'), true);
});

test('an empty file, an empty Disallow and comments allow everything', () => {
  assert.equal(robotsAllows('', AGENT, '/anything'), true);
  assert.equal(robotsAllows('# nothing here\nUser-agent: * # all\nDisallow:\n', AGENT, '/anything'), true);
});
