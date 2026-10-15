// Plain text from the markup feeds put in DESCRIPTION, and the 280-character
// summary the projections carry.

export const SUMMARY_LENGTH = 280;

const HTML_TAG = /<\/?(a|p|br|div|span|b|i|u|em|strong|ul|ol|li|h[1-6]|blockquote|pre|code|img|table|tr|td|th)\b[^>]*>/i;

export function looksLikeHtml(text: string): boolean {
  return HTML_TAG.test(text);
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', middot: '·',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  if (!match) return null;
  return decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
}

export function links(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*>/gi)].map((m) => attribute(m[0], 'href')).filter((h): h is string => !!h);
}

function linkText(label: string, href: string | null): string {
  const text = label.trim();
  if (!href || href === text || href.replace(/\/$/, '') === text.replace(/\/$/, '')) return text || href || '';
  if (!text) return href;
  return `${text} (${href})`;
}

function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function htmlToText(html: string): string {
  let text = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  text = text.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_m, attrs: string, inner: string) => {
    const label = decodeEntities(inner.replace(/<[^>]+>/g, ''));
    return linkText(label, attribute(`<a ${attrs}>`, 'href'));
  });
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|blockquote|pre|tr|table)>/gi, '\n\n')
    .replace(/<\/(ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return tidy(decodeEntities(text));
}

export function markdownToText(markdown: string): string {
  let text = markdown.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => linkText(label, href));
  text = text
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\\([\\`*_{}\[\]()#+\-.!~|>,;:])/g, '$1');
  return tidy(text);
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// Normalizes whitespace and cuts to at most `limit` user-perceived
// characters, at the last word boundary when one is near, ending in "…".
export function summarize(text: string, limit = SUMMARY_LENGTH): string {
  const clean = tidy(text);
  const graphemes = [...segmenter.segment(clean)].map((s) => s.segment);
  if (graphemes.length <= limit) return clean;
  const kept = graphemes.slice(0, limit - 1);
  let cut = kept.length;
  for (let i = kept.length - 1; i >= Math.max(0, kept.length - 40); i -= 1) {
    if (/\s/.test(kept[i]!)) {
      cut = i;
      break;
    }
  }
  return `${kept.slice(0, cut).join('').trimEnd()}…`;
}
