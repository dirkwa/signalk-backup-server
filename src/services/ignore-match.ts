interface Rule {
  negated: boolean;
  matches: (segments: string[]) => boolean;
}

const GLOBSTAR = '**';

type Part = RegExp | typeof GLOBSTAR;

// gitignore semantics as kopia applies them to .kopiaignore: the last matching line wins, and nothing below an ignored directory can be re-included.
export function isIgnoredDir(relPath: string, lines: readonly string[]): boolean {
  const segments = relPath.split('/').filter((s) => s !== '');
  const rules = lines.map(parseLine).filter((r): r is Rule => r !== null);
  for (let depth = 1; depth <= segments.length; depth++) {
    const prefix = segments.slice(0, depth);
    let ignored = false;
    for (const rule of rules) {
      if (rule.matches(prefix)) ignored = !rule.negated;
    }
    if (ignored) return true;
  }
  return false;
}

// A line kopia rejects fails the whole snapshot when it is in .kopiaignore.
export function unreadableIgnoreLines(lines: readonly string[]): string[] {
  return lines.filter((line) => splitLine(line)?.parts.includes(null) ?? false);
}

// Null for a blank or comment line; a null part is a segment kopia rejects.
function splitLine(
  line: string
): { negated: boolean; anchored: boolean; parts: (Part | null)[] } | null {
  let body = line.trim();
  if (body === '' || body.startsWith('#')) return null;
  const negated = body.startsWith('!');
  if (negated) body = body.slice(1);
  body = body.replace(/\/+$/, '');
  if (body === '') return null;
  // A slash before the end anchors the line at the snapshot root; without one it matches the name at any depth.
  const anchored = body.includes('/');
  const parts = body
    .replace(/^\//, '')
    .split('/')
    .map((p) => (/^\*{2,}$/.test(p) ? GLOBSTAR : segmentRegex(p)));
  return { negated, anchored, parts };
}

function parseLine(line: string): Rule | null {
  const split = splitLine(line);
  if (split === null) return null;
  const { negated, anchored, parts } = split;
  if (!parts.every((p): p is Part => p !== null)) return null;
  if (anchored) return { negated, matches: (segments) => matchParts(parts, segments) };
  const [name] = parts;
  if (!(name instanceof RegExp)) return { negated, matches: () => true };
  return { negated, matches: (segments) => name.test(segments.at(-1) ?? '') };
}

// `**` stands for zero or more whole segments.
function matchParts(parts: readonly Part[], segments: readonly string[]): boolean {
  const from = (pi: number, si: number): boolean => {
    const part = parts[pi];
    if (part === undefined) return si === segments.length;
    if (part === GLOBSTAR) {
      for (let k = si; k <= segments.length; k++) if (from(pi + 1, k)) return true;
      return false;
    }
    const segment = segments[si];
    return segment !== undefined && part.test(segment) && from(pi + 1, si + 1);
  };
  return from(0, 0);
}

// One segment in kopia's wildcard syntax. Null where kopia rejects the line (a trailing `\`, an unclosed `[`), because kopia then fails every snapshot instead of matching.
function segmentRegex(glob: string): RegExp | null {
  const chars = [...glob];
  let pos = 0;
  const read = (): string | undefined => chars[pos++];
  const unescape = (c: string | undefined): string | undefined => (c === '\\' ? read() : c);
  let source = '';
  for (let c = read(); c !== undefined; c = read()) {
    // Contiguous stars are one star, as in kopia.
    if (c === '*') source += source.endsWith('[^/]*') ? '' : '[^/]*';
    else if (c === '?') source += '[^/]';
    else if (c === '[') {
      // Only `!` negates; `[]` matches nothing and `[!]` any one character. Kopia 0.23 applies `[:digit:]` and the like only in a set within the first few characters of a line, so here they are plain characters.
      let ch = read();
      const negated = ch === '!';
      if (negated) ch = read();
      let members = '';
      for (; ch !== undefined && ch !== ']'; ch = read()) {
        const lo = unescape(ch);
        if (lo === undefined) return null;
        if (chars[pos] === '-' && chars[pos + 1] !== undefined && chars[pos + 1] !== ']') {
          read();
          const hi = unescape(read());
          if (hi === undefined) return null;
          // A reversed range matches nothing.
          if ((lo.codePointAt(0) ?? 0) <= (hi.codePointAt(0) ?? 0)) {
            members += `${escapeInSet(lo)}-${escapeInSet(hi)}`;
          }
        } else members += escapeInSet(lo);
      }
      if (ch === undefined) return null;
      if (members === '') source += negated ? '[^/]' : '(?!)';
      else source += negated ? `[^/${members}]` : `[${members}]`;
    } else {
      const literal = unescape(c);
      if (literal === undefined) return null;
      source += escapeRegex(literal);
    }
  }
  return new RegExp(`^${source}$`, 'u');
}

function escapeRegex(ch: string): string {
  return /[\^$\\.*+?()[\]{}|/]/.test(ch) ? `\\${ch}` : ch;
}

function escapeInSet(ch: string): string {
  return ch === '-' ? '\\-' : escapeRegex(ch);
}
