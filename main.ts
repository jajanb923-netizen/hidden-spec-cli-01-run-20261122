// main.ts is mend, the CLI SPEC.md specifies: it reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; new: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file split into lines, with its own line break and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: string;
  ends: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const ends = text.endsWith(br);
  if (ends) lines.pop();
  return { lines, br, ends };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.ends ? f.br : '');
}

const rtrimWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** Line equality at one matching tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimWS(a) === rtrimWS(b);
  return trimWS(a) === trimWS(b);
}

interface Match {
  tier: number;
  positions: number[];
}

/**
 * The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs in `lines` at or
 * after `from`, and every such occurrence. With `eof`, only occurrences ending at the file's last
 * line count (a V4A end-of-file chunk).
 */
function findMatch(lines: string[], o: string[], strict: boolean, from: number, eof: boolean): Match | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = from; i + o.length <= lines.length; i++) {
      if (eof && i + o.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (!lineEq(lines[i + j]!, o[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One body line of a hunk, block or chunk: a context line, an old line, or a new line. */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
}

/**
 * Replace the O lines at `pos` with the N lines of `items` (SPEC.md section 5): a context line is
 * written as the file's own matched line, never the patch's; at tier 2 every other line of N is
 * re-indented from O's first line's leading whitespace to the file's first matched line's.
 */
function applyItems(lines: string[], items: BodyItem[], tier: number, pos: number): string[] {
  const oLen = items.reduce((n, it) => n + (it.kind === 'new' ? 0 : 1), 0);
  const oFirst = items.find((it) => it.kind !== 'new');
  const f = leadWS(lines[pos] ?? '');
  const p = leadWS(oFirst === undefined ? '' : oFirst.text);
  const out: string[] = [];
  let oi = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(lines[pos + oi]!);
      oi++;
    } else if (it.kind === 'old') {
      oi++;
    } else {
      let t = it.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return [...lines.slice(0, pos), ...out, ...lines.slice(pos + oLen)];
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Unified diffs (SPEC.md section 6) ----

interface Hunk {
  a: number;
  items: BodyItem[];
  /** A `\` line follows the hunk's last context or `+` line. */
  bsAfterLast: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  bsAfterLastPlus: boolean;
}

interface Section {
  gitA: string | undefined;
  gitB: string | undefined;
  hdrOld: string | null | undefined;
  hdrNew: string | null | undefined;
  renOld: string | undefined;
  renNew: string | undefined;
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let hasPaths = false;
  const closeSection = (): void => {
    if (cur !== null) {
      // Paths: a ---/+++ pair names them, else rename from/to, else the diff --git paths.
      cur.oldPath = cur.hdrOld !== undefined ? cur.hdrOld : cur.renOld !== undefined ? cur.renOld : cur.gitA !== undefined ? cur.gitA : null;
      cur.newPath = cur.hdrNew !== undefined ? cur.hdrNew : cur.renNew !== undefined ? cur.renNew : cur.gitB !== undefined ? cur.gitB : null;
      sections.push(cur);
    }
    cur = null;
    inHeader = false;
    hasPaths = false;
  };
  const parseDiffGit = (line: string): [string, string] | null => {
    if (!line.startsWith('diff --git a/')) return null;
    const rest = line.slice('diff --git a/'.length);
    const idx = rest.indexOf(' b/');
    if (idx < 0) return null;
    return [rest.slice(0, idx), rest.slice(idx + 3)];
  };
  const cleanPath = (raw: string): string | null => {
    if (raw === '/dev/null') return null;
    if (raw.startsWith('a/')) return raw.slice(2);
    if (raw.startsWith('b/')) return raw.slice(2);
    return raw;
  };
  const headerPath = (line: string): string | null => {
    let p = line.slice(4);
    const tab = p.indexOf('\t');
    if (tab >= 0) p = p.slice(0, tab);
    return cleanPath(p.trim());
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const g = parseDiffGit(line);
      if (g === null) throw new Exit2(`error: parse ${i + 1}`);
      closeSection();
      cur = { gitA: g[0], gitB: g[1], hdrOld: undefined, hdrNew: undefined, renOld: undefined, renNew: undefined, oldPath: undefined, newPath: undefined, newFile: false, deletedFile: false, hunks: [] };
      inHeader = true;
      hasPaths = false;
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        if (cur !== null && inHeader && !hasPaths) {
          cur.hdrOld = headerPath(line);
          cur.hdrNew = headerPath(next);
          hasPaths = true;
        } else {
          closeSection();
          cur = { gitA: undefined, gitB: undefined, hdrOld: headerPath(line), hdrNew: headerPath(next), renOld: undefined, renNew: undefined, oldPath: undefined, newPath: undefined, newFile: false, deletedFile: false, hunks: [] };
          inHeader = true;
          hasPaths = true;
        }
        i += 2;
        continue;
      }
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      const raw: Array<BodyItem | { kind: 'bs'; src: string }> = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl.startsWith(' ')) {
          raw.push({ kind: 'ctx', text: bl.slice(1) });
          j++;
        } else if (bl.startsWith('-')) {
          raw.push({ kind: 'old', text: bl.slice(1) });
          j++;
        } else if (bl.startsWith('+')) {
          raw.push({ kind: 'new', text: bl.slice(1) });
          j++;
        } else if (bl.startsWith('\\')) {
          raw.push({ kind: 'bs', src: bl });
          j++;
        } else if (bl === '') {
          raw.push({ kind: 'ctx', text: '' });
          j++;
        } else break;
      }
      // Empty lines at the end of a body are not part of it.
      while (raw.length > 0) {
        const lastItem = raw[raw.length - 1]!;
        if (lastItem.kind === 'ctx' && lastItem.text === '') {
          // A context line whose text is empty came from a '' or a ' ' patch line; only a
          // truly empty patch line is an empty line of the body. Recover it from the patch.
          const srcLine = lines[j - 1]!;
          if (srcLine === '') {
            raw.pop();
            j--;
            continue;
          }
        }
        break;
      }
      let bsAfterLast = false;
      let bsAfterLastPlus = false;
      for (let k = raw.length - 1; k >= 0; k--) {
        if (raw[k]!.kind === 'ctx' || raw[k]!.kind === 'new') {
          bsAfterLast = raw[k + 1] !== undefined && raw[k + 1]!.kind === 'bs';
          break;
        }
      }
      for (let k = raw.length - 1; k >= 0; k--) {
        if (raw[k]!.kind === 'new') {
          bsAfterLastPlus = raw[k + 1] !== undefined && raw[k + 1]!.kind === 'bs';
          break;
        }
      }
      const items: BodyItem[] = raw.filter((it) => it.kind !== 'bs') as BodyItem[];
      cur.hunks.push({ a, items, bsAfterLast, bsAfterLastPlus });
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) {
        cur.renOld = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renNew = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  closeSection();
  return sections.map((s) => makeUnifiedEdit(s, strict));
}

function makeUnifiedEdit(s: Section, strict: boolean): Edit {
  const oldPath = s.oldPath === undefined ? null : s.oldPath;
  const newPath = s.newPath === undefined ? null : s.newPath;
  const isCreate = oldPath === null || s.newFile;
  const isDelete = !isCreate && (newPath === null || s.deletedFile);
  const isMove = !isCreate && !isDelete && oldPath !== null && newPath !== null && oldPath !== newPath;
  return (tree) => {
    if (isCreate) {
      if (newPath === null) return;
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      for (const h of s.hunks) for (const it of h.items) if (it.kind === 'new') plus.push(it.text);
      let ends = true;
      for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
        const h = s.hunks[hi]!;
        if (h.items.some((it) => it.kind === 'new')) {
          ends = !h.bsAfterLastPlus;
          break;
        }
      }
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (ends ? '\n' : ''));
      return;
    }
    if (isDelete) {
      if (oldPath === null) return;
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (oldPath === null) return;
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    const text = tree.get(oldPath);
    if (text === null) throw new Fail('missing', oldPath);
    if (isMove) {
      if (newPath === null) return;
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
    }
    const f = splitFile(text);
    let d = 0;
    for (const h of s.hunks) {
      const o = h.items.filter((it) => it.kind !== 'new').map((it) => it.text);
      const nCount = h.items.filter((it) => it.kind === 'new').length;
      if (o.length > 0) {
        const m = findMatch(f.lines, o, strict, 0, false);
        if (m === null) throw new Fail('no-match', oldPath);
        const target = h.a - 1 + d;
        let best = m.positions[0]!;
        let bestDist = Math.abs(best - target);
        for (const pos of m.positions) {
          const dist = Math.abs(pos - target);
          if (dist < bestDist) {
            best = pos;
            bestDist = dist;
          }
        }
        const atEnd = best + o.length === f.lines.length;
        f.lines = applyItems(f.lines, h.items, m.tier, best);
        if (atEnd) f.ends = !h.bsAfterLast;
        d += nCount - o.length;
      } else {
        const nLines = h.items.filter((it) => it.kind === 'new').map((it) => it.text);
        const pos = Math.max(0, Math.min(h.a + d, f.lines.length));
        const atEnd = pos === f.lines.length;
        f.lines = [...f.lines.slice(0, pos), ...nLines, ...f.lines.slice(pos)];
        if (atEnd) f.ends = !h.bsAfterLast;
        d += nLines.length;
      }
    }
    const out = renderFile(f);
    if (isMove && newPath !== null) {
      tree.now.set(oldPath, null);
      tree.now.set(newPath, out);
      tree.moves.push({ old: oldPath, new: newPath });
    } else {
      tree.now.set(oldPath, out);
    }
  };
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function makeSREdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const f = splitFile(text);
    const m = findMatch(f.lines, oldLines, strict, 0, false);
    if (m === null) throw new Fail('no-match', path);
    if (m.positions.length > 1) throw new Fail('ambiguous', path);
    const items: BodyItem[] = [
      ...oldLines.map((t): BodyItem => ({ kind: 'old', text: t })),
      ...newLines.map((t): BodyItem => ({ kind: 'new', text: t })),
    ];
    f.lines = applyItems(f.lines, items, m.tier, m.positions[0]!);
    tree.now.set(path, renderFile(f));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(makeSREdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC.md section 8) ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

/** The first line at or after `from` equal to the anchor at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, tier)) return i;
    }
  }
  return -1;
}

function makeV4aEdit(
  kind: 'add' | 'delete' | 'update',
  path: string,
  raw: string[],
  startIdx: number,
  headerLineNo: number,
  strict: boolean,
): Edit {
  let addLines: string[] = [];
  let moveTo: string | null = null;
  let chunks: VChunk[] = [];
  if (kind === 'add') {
    for (let k = 0; k < raw.length; k++) {
      const l = raw[k]!;
      if (l.startsWith('+')) addLines.push(l.slice(1));
      else if (blank(l)) addLines.push('');
      else throw new Exit2(`error: parse ${startIdx + k + 1}`);
    }
  } else if (kind === 'delete') {
    if (raw.length > 0) throw new Exit2(`error: parse ${startIdx + 1}`);
  } else {
    let idx = 0;
    if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
      moveTo = raw[0]!.slice('*** Move to: '.length).trim();
      idx = 1;
    }
    let cur: VChunk | null = null;
    let sawChunk = false;
    for (; idx < raw.length; idx++) {
      const l = raw[idx]!;
      if (l.startsWith('@@')) {
        if (cur !== null) chunks.push(cur);
        const anchor = l.slice(2).trim();
        cur = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
        sawChunk = true;
      } else if (l === '*** End of File') {
        if (cur === null) throw new Exit2(`error: parse ${startIdx + idx + 1}`);
        cur.eof = true;
        chunks.push(cur);
        cur = null;
      } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || blank(l)) {
        if (cur === null) {
          if (sawChunk) throw new Exit2(`error: parse ${startIdx + idx + 1}`);
          cur = { anchor: null, eof: false, items: [] };
          sawChunk = true;
        }
        if (l.startsWith(' ')) cur.items.push({ kind: 'ctx', text: l.slice(1) });
        else if (l.startsWith('-')) cur.items.push({ kind: 'old', text: l.slice(1) });
        else if (l.startsWith('+')) cur.items.push({ kind: 'new', text: l.slice(1) });
        else cur.items.push({ kind: 'ctx', text: '' });
      } else {
        throw new Exit2(`error: parse ${startIdx + idx + 1}`);
      }
    }
    if (cur !== null) chunks.push(cur);
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLineNo}`);
  }
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (kind === 'add') {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
      return;
    }
    if (kind === 'delete') {
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
      return;
    }
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const apos = findAnchor(f.lines, ch.anchor, cursor, strict);
        if (apos === -1) throw new Fail('no-match', path);
        cursor = apos + 1;
      }
      const o = ch.items.filter((it) => it.kind !== 'new').map((it) => it.text);
      if (o.length === 0) {
        const insPos = ch.eof ? f.lines.length : cursor;
        const ins = ch.items.filter((it) => it.kind === 'new').map((it) => it.text);
        f.lines = [...f.lines.slice(0, insPos), ...ins, ...f.lines.slice(insPos)];
        cursor = insPos + ins.length;
      } else {
        const m = findMatch(f.lines, o, strict, cursor, ch.eof);
        if (m === null) throw new Fail('no-match', path);
        const pos = m.positions[0]!;
        f.lines = applyItems(f.lines, ch.items, m.tier, pos);
        cursor = pos + ch.items.filter((it) => it.kind !== 'old').length;
      }
    }
    const out = renderFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      const kind = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'delete' : 'update';
      const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
      const path = line.slice(prefix.length).trim();
      const start = i + 1;
      let j = start;
      while (j < last) {
        const l = lines[j]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
        j++;
      }
      const raw = lines.slice(start, j);
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      edits.push(makeV4aEdit(kind, path, raw, start, i + 1, strict));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string }> = [];
  const pairedOld = new Set<string>();
  const pairedNew = new Set<string>();
  for (const mv of tree.moves) {
    const wasOld = tree.original(mv.old);
    const nowOld = tree.now.get(mv.old);
    const wasNew = tree.original(mv.new);
    const nowNew = tree.now.get(mv.new);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      pairedOld.add(mv.old);
      pairedNew.add(mv.new);
      rows.push({ key: mv.new, line: `R ${mv.old} -> ${mv.new}` });
    }
  }
  const byteOrd = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  for (const p of [...tree.now.keys()].sort(byteOrd)) {
    if (pairedOld.has(p) || pairedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteOrd(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
