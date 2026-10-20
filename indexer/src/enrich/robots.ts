// Whether a site's robots.txt lets a crawler read a path (RFC 9309): the
// groups that name the crawler, or else every `*` group, together; the
// longest matching rule decides, an allow winning a tie; `*` matches any run
// of characters and a final `$` ends the path.

interface Rule {
  allow: boolean;
  pattern: string;
  match: RegExp;
}

interface Group {
  agents: string[];
  rules: Rule[];
}

function compile(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern).split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

function parse(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let agentLine = false;
  for (const raw of text.split(/\r?\n|\r/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (!current || !agentLine) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      agentLine = true;
    } else if ((key === 'allow' || key === 'disallow') && current) {
      agentLine = false;
      if (value) current.rules.push({ allow: key === 'allow', pattern: value, match: compile(value) });
    }
  }
  return groups;
}

export function robotsAllows(text: string, agent: string, path: string): boolean {
  const groups = parse(text);
  const token = agent.toLowerCase();
  const named = groups.filter((g) => g.agents.includes(token));
  const rules = (named.length ? named : groups.filter((g) => g.agents.includes('*'))).flatMap((g) => g.rules);
  let best: Rule | null = null;
  for (const rule of rules) {
    if (!rule.match.test(path)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule;
  }
  return best?.allow ?? true;
}
