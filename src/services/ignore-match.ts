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

function parseLine(line: string): Rule | null {
  let body = line.trim();
  if (body === '' || body.startsWith('#')) return null;
  const negated = body.startsWith('!');
  if (negated) body = body.slice(1);
  body = body.replace(/\/+$/, '');
  if (body === '') return null;
  // A slash before the end anchors the line at the snapshot root; without one it matches the name at any depth.
  const anchored = body.includes('/');
  const parts: Part[] = body
    .replace(/^\//, '')
    .split('/')
    .map((p) => (p === GLOBSTAR ? GLOBSTAR : segmentRegex(p)));
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

// `*` and `?` stay within one segment; `[...]` is a character class, `[!...]` its complement.
function segmentRegex(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else if (c === '[' && glob.indexOf(']', i + 2) !== -1) {
      const end = glob.indexOf(']', i + 2);
      let body = glob.slice(i + 1, end);
      if (body.startsWith('!')) body = `^${body.slice(1)}`;
      source += `[${body.replace(/\\/g, '\\\\')}]`;
      i = end;
    } else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}
