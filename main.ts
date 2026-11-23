// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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
  readonly moves: Array<[string, string]> = [];
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

/** A file as lines: its line break, and whether its text ends with one. */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function fileState(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderState(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/* ------------------------------------------------------------------ matching (SPEC.md section 5) */

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions i where O matches the file's lines from i, at one tier, at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const res: number[] = [];
  if (o.length === 0 || o.length > lines.length) return res;
  const want = o.map((l) => normLine(l, tier));
  for (let i = Math.max(0, from); i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

/** The first tier (0, then 1, then 2; 0 only with --strict) at which O occurs at or after `from`. */
function firstTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first line at or after `from` equal to `line` at the first tier where one is (single-line matching). */
function findAnchor(lines: string[], line: string, strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const want = normLine(line, t);
    for (let i = Math.max(0, from); i < lines.length; i++) {
      if (normLine(lines[i]!, t) === want) return i;
    }
  }
  return null;
}

interface SegLine {
  ctx: boolean;
  text: string;
}

function reindent(line: string, p: string, f: string): string {
  if (line === '' || line.trim() === '') return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

/**
 * The lines that replace a matched block: context lines are the file's own matched lines, other lines of N
 * are written as they are, re-indented at tier 2. `o` and `n` are the old and new segments; context lines in
 * the two appear in the same order.
 */
function mapN(o: SegLine[], n: SegLine[], fileLines: string[], at: number, tier: number): string[] {
  const ctxPos: number[] = [];
  o.forEach((x, idx) => {
    if (x.ctx) ctxPos.push(idx);
  });
  const p = o.length > 0 ? leadingWs(o[0]!.text) : '';
  const f = fileLines.length > at ? leadingWs(fileLines[at]!) : '';
  const out: string[] = [];
  let ord = 0;
  for (const x of n) {
    if (x.ctx) {
      out.push(fileLines[at + ctxPos[ord]!]!);
      ord += 1;
    } else {
      out.push(tier === 2 ? reindent(x.text, p, f) : x.text);
    }
  }
  return out;
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

/* ------------------------------------------------------------------ JSON edits (SPEC.md section 9) */

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
      const at = line;
      if (at < 0 || at > lines.length) throw new Fail('no-match', p);
      lines.splice(at, 0, ...add);
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

/* ------------------------------------------------------------------ unified diffs (SPEC.md section 6) */

interface HunkItem {
  t: 'c' | 'o' | 'n' | 'm';
  s: string;
}

interface Hunk {
  A: number;
  items: HunkItem[];
}

interface UniSection {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renFrom: string | null;
  renTo: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed. */
function headerPath(l: string): string {
  let p = l.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  return p.trim();
}

/** The two paths of a `diff --git a/<X> b/<Y>` line, or null when it is not of that form. */
function parseDiffGit(l: string): [string, string] | null {
  if (!l.startsWith('diff --git a/')) return null;
  const rest = l.slice('diff --git a/'.length);
  const sep = rest.lastIndexOf(' b/');
  if (sep < 0) return null;
  const x = rest.slice(0, sep).trim();
  const y = rest.slice(sep + 3).trim();
  if (x === '' || y === '') return null;
  return [x, y];
}

/** The old start line A of a hunk header, or null when it is not of the form `@@ -A[,B] +C[,D] @@`. */
function parseHunkHeader(l: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
  if (m === null) return null;
  return parseInt(m[1]!, 10);
}

/** A hunk's body from `start`: lines starting with ` `, `-`, `+`, `\`, or empty. */
function parseHunkBody(lines: string[], start: number): { items: HunkItem[]; next: number } {
  const items: HunkItem[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      items.push({ t: 'c', s: '' });
      i += 1;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      items.push({ t: 'c', s: l.slice(1) });
      i += 1;
      continue;
    }
    if (c === '-') {
      items.push({ t: 'o', s: l.slice(1) });
      i += 1;
      continue;
    }
    if (c === '+') {
      items.push({ t: 'n', s: l.slice(1) });
      i += 1;
      continue;
    }
    if (c === '\\') {
      items.push({ t: 'm', s: l });
      i += 1;
      continue;
    }
    break;
  }
  while (items.length > 0) {
    const last = items[items.length - 1]!;
    if (last.t === 'c' && last.s === '') items.pop();
    else break;
  }
  return { items, next: i };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function backslashAfterLastNew(items: HunkItem[]): boolean {
  for (let j = items.length - 1; j >= 0; j--) {
    if (items[j]!.t === 'c' || items[j]!.t === 'n') {
      return items[j + 1] !== undefined && items[j + 1]!.t === 'm';
    }
  }
  return false;
}

function segments(items: HunkItem[]): { o: SegLine[]; n: SegLine[] } {
  const o: SegLine[] = [];
  const n: SegLine[] = [];
  for (const it of items) {
    if (it.t === 'c') {
      o.push({ ctx: true, text: it.s });
      n.push({ ctx: true, text: it.s });
    } else if (it.t === 'o') o.push({ ctx: false, text: it.s });
    else if (it.t === 'n') n.push({ ctx: false, text: it.s });
  }
  return { o, n };
}

/** Apply one section's hunks, in order, to a file's text. */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = fileState(before);
  let d = 0;
  for (const h of hunks) {
    const { o, n } = segments(h.items);
    const O = o.map((x) => x.text);
    const N = n.map((x) => x.text);
    const noEol = backslashAfterLastNew(h.items);
    if (O.length === 0) {
      const at = Math.max(0, Math.min(h.A + d, f.lines.length));
      const atEnd = at === f.lines.length;
      const ins = mapN(o, n, f.lines, at, 0);
      f.lines.splice(at, 0, ...ins);
      if (atEnd) f.final = !noEol;
      d += N.length;
      continue;
    }
    const found = firstTier(f.lines, O, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.A - 1 + d;
    let at = found.occ[0]!;
    let best = Math.abs(at - target);
    for (const p of found.occ) {
      const dd = Math.abs(p - target);
      if (dd < best) {
        at = p;
        best = dd;
      }
    }
    const runsToEnd = at + O.length === f.lines.length;
    const repl = mapN(o, n, f.lines, at, found.tier);
    f.lines.splice(at, O.length, ...repl);
    if (runsToEnd) f.final = !noEol;
    d += N.length - O.length;
  }
  return renderState(f);
}

function unifiedSectionEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.pairOld ?? sec.renFrom ?? sec.diffOld;
    const newP = sec.pairNew ?? sec.renTo ?? sec.diffNew;
    if (oldP === null || newP === null) throw new Fail('missing', oldP ?? newP ?? '');
    const isCreate = sec.create || oldP === '/dev/null';
    const isDelete = !isCreate && (sec.del || newP === '/dev/null');
    if (isCreate) {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const it of h.items) if (it.t === 'n') plus.push(it.s);
      let noEol = false;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const items = sec.hunks[hi]!.items;
        for (let j = items.length - 1; j >= 0; j--) {
          if (items[j]!.t === 'n') {
            noEol = items[j + 1] !== undefined && items[j + 1]!.t === 'm';
            break outer;
          }
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const after = applyHunks(before, sec.hunks, strict, oldP);
      tree.now.set(newP, after);
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, applyHunks(before, sec.hunks, strict, oldP));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  const fresh = (): UniSection => {
    const s: UniSection = {
      diffOld: null,
      diffNew: null,
      pairOld: null,
      pairNew: null,
      renFrom: null,
      renTo: null,
      create: false,
      del: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const d = parseDiffGit(l);
      if (d === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.diffOld = d[0];
      cur.diffNew = d[1];
      inHeader = true;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && cur.pairOld === null) {
        cur.pairOld = stripAB(headerPath(l));
        cur.pairNew = stripAB(headerPath(lines[i + 1]!));
        i += 2;
        continue;
      }
      cur = fresh();
      cur.pairOld = stripAB(headerPath(l));
      cur.pairNew = stripAB(headerPath(lines[i + 1]!));
      inHeader = true;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseHunkHeader(l);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      const body = parseHunkBody(lines, i + 1);
      cur.hunks.push({ A: a, items: body.items });
      i = body.next;
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) cur.renFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.create = true;
      else if (l.startsWith('deleted file mode')) cur.del = true;
      else if (l.startsWith('+++ ')) cur.pairNew = stripAB(headerPath(l));
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/* ------------------------------------------------------------------ SEARCH/REPLACE blocks (SPEC.md section 7) */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = fileState(before);
    const found = firstTier(f.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const o = oldLines.map((t) => ({ ctx: false, text: t }));
    const nn = newLines.map((t) => ({ ctx: false, text: t }));
    const repl = mapN(o, nn, f.lines, at, found.tier);
    f.lines.splice(at, oldLines.length, ...repl);
    tree.now.set(path, renderState(f));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let eq = -1;
    let rep = -1;
    for (let j = s + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    let path: string | null = null;
    for (let j = s - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ V4A patches (SPEC.md section 8) */

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  items: { t: 'c' | 'o' | 'n'; s: string }[];
}

interface RawLine {
  text: string;
  abs: number;
}

function parseV4aChunks(raw: RawLine[], updateLine: number): { moveTo: string | null; chunks: V4aChunk[] } {
  let k = 0;
  let moveTo: string | null = null;
  while (k < raw.length && blank(raw[k]!.text)) k += 1;
  if (k < raw.length && raw[k]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[k]!.text.slice('*** Move to: '.length).trim();
    k += 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let count = 0;
  for (; k < raw.length; k++) {
    const { text, abs } = raw[k]!;
    if (text.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      const anchor = text.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
      count += 1;
      continue;
    }
    if (text.trimEnd() === '*** End of File' && text === text.trimStart()) {
      if (cur === null) throw new Exit2(`error: parse ${abs + 1}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      continue;
    }
    if (text === '' || text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
      if (cur === null) {
        if (count !== 0) throw new Exit2(`error: parse ${abs + 1}`);
        cur = { anchor: null, eof: false, items: [] };
        count += 1;
      }
      if (text === '') cur.items.push({ t: 'c', s: '' });
      else if (text[0] === ' ') cur.items.push({ t: 'c', s: text.slice(1) });
      else if (text[0] === '-') cur.items.push({ t: 'o', s: text.slice(1) });
      else cur.items.push({ t: 'n', s: text.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${abs + 1}`);
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
  return { moveTo, chunks };
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = fileState(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const idx = findAnchor(f.lines, ch.anchor, strict, cursor);
        if (idx === null) throw new Fail('no-match', path);
        cursor = idx + 1;
      }
      const o: SegLine[] = [];
      const n: SegLine[] = [];
      for (const it of ch.items) {
        if (it.t === 'c') {
          o.push({ ctx: true, text: it.s });
          n.push({ ctx: true, text: it.s });
        } else if (it.t === 'o') o.push({ ctx: false, text: it.s });
        else n.push({ ctx: false, text: it.s });
      }
      const O = o.map((x) => x.text);
      const N = n.map((x) => x.text);
      if (O.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        const ins = mapN(o, n, f.lines, at, 0);
        f.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      const found = firstTier(f.lines, O, strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      let at: number;
      if (ch.eof) {
        const want = f.lines.length - O.length;
        if (want < cursor || !found.occ.includes(want)) throw new Fail('no-match', path);
        at = want;
      } else {
        at = found.occ[0]!;
      }
      const repl = mapN(o, n, f.lines, at, found.tier);
      f.lines.splice(at, O.length, ...repl);
      cursor = at + repl.length;
    }
    const after = renderState(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, after);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, after);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
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
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      const isAdd = l.startsWith('*** Add File: ');
      const isDel = l.startsWith('*** Delete File: ');
      const prefix = isAdd ? '*** Add File: ' : isDel ? '*** Delete File: ' : '*** Update File: ';
      const path = l.slice(prefix.length).trim();
      const startLine = i;
      const raw: RawLine[] = [];
      let j = i + 1;
      while (j < last) {
        const m = lines[j]!;
        if (isSectionStart(m)) break;
        raw.push({ text: m, abs: j });
        j += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      if (isAdd) {
        const fileLines: string[] = [];
        for (const r of raw) {
          if (r.text === '') fileLines.push('');
          else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
          else throw new Exit2(`error: parse ${r.abs + 1}`);
        }
        edits.push(v4aAddEdit(path, fileLines));
      } else if (isDel) {
        for (const r of raw) {
          if (!blank(r.text)) throw new Exit2(`error: parse ${r.abs + 1}`);
        }
        edits.push(v4aDeleteEdit(path));
      } else {
        const { moveTo, chunks } = parseV4aChunks(raw, startLine);
        edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      }
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ running (SPEC.md sections 1, 2, 10) */

function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (usedNew.has(newP)) continue;
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      usedOld.add(oldP);
      usedNew.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (usedOld.has(p) || usedNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  const out = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was !== null && now === null) rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (now === null || was === now) continue;
      try {
        if (statSync(p).isDirectory()) rmSync(p, { recursive: true, force: true });
      } catch {
        /* not there */
      }
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
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
