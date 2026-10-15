// Trims a captured iCalendar feed into a fixture.
//
//   node scripts/sanitize-fixture.ts <in.ics> <out.ics> [options]
//
//   --uid <uid>            keep the VEVENTs with this UID (repeatable)
//   --first <n>            keep the first n VEVENTs (after --uid matches)
//   --replace <from=>to>   replace text everywhere (repeatable)
//   --max-attendees <n>    keep at most n ATTENDEE lines per VEVENT (default 2)
//
// Calendar-level lines are kept, and the VTIMEZONE blocks that kept VEVENTs
// reference. Kept lines stay
// byte-for-byte as captured unless they change. Every e-mail address on an
// ORGANIZER or ATTENDEE line becomes redacted@example.invalid, and every
// other e-mail address in the output is reported so it can be reviewed.

import { readFileSync, writeFileSync } from 'node:fs';

const REDACTED = 'redacted@example.invalid';
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

interface Options {
  uids: Set<string>;
  first: number;
  replacements: Array<[string, string]>;
  maxAttendees: number;
}

function parseArgs(argv: string[]): { input: string; output: string; options: Options } {
  const [input, output, ...rest] = argv;
  if (!input || !output) {
    throw new Error('usage: sanitize-fixture.ts <in.ics> <out.ics> [--uid U] [--first N] [--replace A=>B]');
  }
  const options: Options = { uids: new Set(), first: 0, replacements: [], maxAttendees: 2 };
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1] ?? '';
    if (flag === '--uid') options.uids.add(value);
    else if (flag === '--first') options.first = Number(value);
    else if (flag === '--max-attendees') options.maxAttendees = Number(value);
    else if (flag === '--replace') {
      const at = value.indexOf('=>');
      if (at <= 0) throw new Error(`--replace needs from=>to, got ${value}`);
      options.replacements.push([value.slice(0, at), value.slice(at + 2)]);
    } else throw new Error(`unknown option ${flag}`);
  }
  return { input, output, options };
}

// A content line as captured: its physical lines (first + continuations).
interface ContentLine {
  physical: string[];
}

function splitContentLines(text: string): { lines: ContentLine[]; eol: string } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const physical = text.split(/\r?\n/);
  if (physical.at(-1) === '') physical.pop();
  const lines: ContentLine[] = [];
  for (const line of physical) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
      lines.at(-1)!.physical.push(line);
    } else {
      lines.push({ physical: [line] });
    }
  }
  return { lines, eol };
}

function logical(line: ContentLine): string {
  return line.physical.map((p, i) => (i === 0 ? p : p.slice(1))).join('');
}

// Folds at 75 octets without splitting a UTF-8 sequence (RFC 5545 § 3.1).
function fold(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let octets = 0;
  for (const ch of value) {
    const size = Buffer.byteLength(ch, 'utf8');
    const limit = out.length === 0 ? 75 : 74;
    if (octets + size > limit) {
      out.push(out.length === 0 ? current : ` ${current}`);
      current = '';
      octets = 0;
    }
    current += ch;
    octets += size;
  }
  out.push(out.length === 0 ? current : ` ${current}`);
  return out;
}

function rewrite(line: ContentLine, text: string, folded: boolean): ContentLine {
  if (text === logical(line)) return line;
  return { physical: folded ? fold(text) : [text] };
}

function propertyName(text: string): string {
  const match = /^[A-Za-z0-9-]+/.exec(text);
  return match ? match[0].toUpperCase() : '';
}

function main(): void {
  const { input, output, options } = parseArgs(process.argv.slice(2));
  const { lines, eol } = splitContentLines(readFileSync(input, 'utf8'));
  const folded = lines.some((l) => l.physical.length > 1);

  const kept: Array<ContentLine | { zone: string; block: ContentLine[] }> = [];
  const keptEvents: ContentLine[] = [];
  let event: ContentLine[] | null = null;
  let zone: ContentLine[] | null = null;
  let depth = 0;
  let firstTaken = 0;

  const flushEvent = (block: ContentLine[]): void => {
    const uidLine = block.find((l) => propertyName(logical(l)) === 'UID');
    const uid = uidLine ? logical(uidLine).replace(/^UID:/i, '') : '';
    let keep = options.uids.has(uid);
    if (!keep && firstTaken < options.first) {
      keep = true;
      firstTaken += 1;
    }
    if (!keep) return;
    let attendees = 0;
    for (const line of block) {
      const name = propertyName(logical(line));
      if (name === 'ATTENDEE') {
        attendees += 1;
        if (attendees > options.maxAttendees) continue;
      }
      kept.push(line);
      keptEvents.push(line);
    }
  };

  for (const line of lines) {
    const text = logical(line);
    if (/^BEGIN:VEVENT$/i.test(text) && depth === 1) {
      event = [line];
      depth += 1;
      continue;
    }
    if (event) {
      event.push(line);
      if (/^BEGIN:/i.test(text)) depth += 1;
      if (/^END:/i.test(text)) depth -= 1;
      if (depth === 1) {
        flushEvent(event);
        event = null;
      }
      continue;
    }
    if (/^BEGIN:VTIMEZONE$/i.test(text) && depth === 1) {
      zone = [line];
      depth += 1;
      continue;
    }
    if (zone) {
      zone.push(line);
      if (/^BEGIN:/i.test(text)) depth += 1;
      if (/^END:/i.test(text)) depth -= 1;
      if (depth === 1) {
        const tzid = zone.map(logical).find((l) => /^TZID:/i.test(l))?.slice(5) ?? '';
        kept.push({ zone: tzid, block: zone });
        zone = null;
      }
      continue;
    }
    if (/^BEGIN:/i.test(text)) depth += 1;
    if (/^END:/i.test(text)) depth -= 1;
    kept.push(line);
  }

  const referenced = new Set(
    keptEvents.flatMap((l) => [...logical(l).matchAll(/;TZID=("[^"]+"|[^;:]+)/gi)].map((m) => m[1]!.replace(/"/g, ''))),
  );
  const lines2 = kept.flatMap((item) => ('zone' in item ? (referenced.has(item.zone) ? item.block : []) : [item]));

  const result = lines2.map((line) => {
    let text = logical(line);
    for (const [from, to] of options.replacements) text = text.split(from).join(to);
    const name = propertyName(text);
    if (name === 'ORGANIZER' || name === 'ATTENDEE') text = text.replace(EMAIL, REDACTED);
    return rewrite(line, text, folded);
  });

  const body = result.flatMap((l) => l.physical).join(eol) + eol;
  writeFileSync(output, body);

  const unfolded = body.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter((l) => !/^UID[:;]/i.test(l));
  const leftovers = new Set(unfolded.flatMap((l) => l.match(EMAIL) ?? []).filter((e) => e !== REDACTED));
  const events = (body.match(/^BEGIN:VEVENT/gm) ?? []).length;
  process.stdout.write(`${output}: ${events} VEVENT(s)\n`);
  for (const address of leftovers) process.stdout.write(`  review address: ${address}\n`);
}

main();
