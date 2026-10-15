import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, markdownToText, summarize, looksLikeHtml, links } from '../src/ical/text.ts';

test('htmlToText keeps link targets and line structure', () => {
  assert.equal(htmlToText('<a href="https://in.pycon.org/2013/">PyCon India 2013</a>'), 'PyCon India 2013 (https://in.pycon.org/2013/)');
  assert.equal(htmlToText('<span>Join: <a href="https://zoom.us/j/1">https://zoom.us/j/1</a><br></span><br>Passcode: 1'), 'Join: https://zoom.us/j/1\n\nPasscode: 1');
  assert.equal(htmlToText('<p>One</p><p>Two &amp; three&nbsp;&#8212; four</p>'), 'One\n\nTwo & three — four');
  assert.equal(htmlToText('<ul><li>a</li><li>b</li></ul>'), '- a\n- b');
});

test('looksLikeHtml detects markup, not angle brackets in prose', () => {
  assert.equal(looksLikeHtml('<a href="x">y</a>'), true);
  assert.equal(looksLikeHtml('Line one<br>Line two'), true);
  assert.equal(looksLikeHtml('ages 5 < x > 3, bring <3'), false);
});

test('links lists the anchors of an HTML text in order', () => {
  assert.deepEqual(links('<a href="https://a.example/">A</a> and <a href=\'https://b.example/\'>B</a>'), ['https://a.example/', 'https://b.example/']);
});

test('markdownToText removes emphasis and escapes and keeps links', () => {
  assert.equal(markdownToText('**GETTING INTO THE VENUE**'), 'GETTING INTO THE VENUE');
  assert.equal(markdownToText('join: [https://discord.gg/x](https://discord.gg/x)'), 'join: https://discord.gg/x');
  assert.equal(markdownToText('our [YouTube channel](https://www.youtube.com/@sd)'), 'our YouTube channel (https://www.youtube.com/@sd)');
  assert.equal(markdownToText('Taille : \\~20 personnes\\-\\-\\-fin'), 'Taille : ~20 personnes---fin');
  assert.equal(markdownToText('## Agenda\n- 18:30 Accueil'), 'Agenda\n- 18:30 Accueil');
});

test('summarize leaves short text alone and trims it', () => {
  assert.equal(summarize('  Bring a laptop.\n'), 'Bring a laptop.');
  assert.equal(summarize(''), '');
});

test('summarize cuts long text at a word boundary within 280 characters', () => {
  const text = `${'word '.repeat(80)}end`;
  const result = summarize(text);
  assert.ok([...new Intl.Segmenter().segment(result)].length <= 280);
  assert.ok(result.endsWith('word…'));
});

test('summarize never splits an emoji or a combined character', () => {
  const family = '👩🏽‍💻';
  const text = `${'a'.repeat(278)}${family}${family} tail`;
  const result = summarize(text);
  const graphemes = [...new Intl.Segmenter().segment(result)].map((s) => s.segment);
  assert.ok(graphemes.length <= 280);
  for (const g of graphemes) assert.ok(g === family || g.length <= 2, `split grapheme ${JSON.stringify(g)}`);
});

test('summarize collapses runs of blank lines and spaces', () => {
  assert.equal(summarize('One\n\n\n\nTwo   three'), 'One\n\nTwo three');
});
