// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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
  readonly moves: [string, string][] = [];
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

let STRICT = false;

/** The matching tiers of SPEC.md section 5: 0 exact, 1 trailing ws, 2 both sides. */
function lineKey(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function tiers(): number[] {
  return STRICT ? [0] : [0, 1, 2];
}

/** Positions where o occurs in lines at tier, at or after `from` (overlaps count). */
function occurrencesAt(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const ok = o.map((l) => lineKey(l, tier));
  for (let i = from; i + o.length <= lines.length; i++) {
    let good = true;
    for (let j = 0; j < o.length; j++) {
      if (lineKey(lines[i + j]!, tier) !== ok[j]) { good = false; break; }
    }
    if (good) out.push(i);
  }
  return out;
}

interface Found { tier: number; occ: number[]; }

/** First tier with an occurrence at or after `from`; endOnly keeps only ones ending at the last line. */
function findTiered(lines: string[], o: string[], from: number, endOnly: boolean): Found | null {
  for (const t of tiers()) {
    let occ = occurrencesAt(lines, o, t, from);
    if (endOnly) occ = occ.filter((p) => p + o.length === lines.length);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface NLine { text: string; oIdx: number; } // oIdx >= 0: context line, the file's own O[oIdx]; -1: added line

/** The lines that replace a matched O at pos: context lines are the file's own, added lines re-indented at tier 2. */
function buildReplacement(o: string[], n: NLine[], fileLines: string[], pos: number, tier: number): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = /^[ \t]*/.exec(fileLines[pos]!)![0];
    p = /^[ \t]*/.exec(o[0]!)![0];
  }
  const out: string[] = [];
  for (const item of n) {
    if (item.oIdx >= 0) out.push(fileLines[pos + item.oIdx]!);
    else {
      const t = item.text;
      if (tier === 2 && o.length > 0 && t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    }
  }
  return out;
}

interface FileState { lines: string[]; br: string; final: boolean; }

/** Split a file's text at its own line break (CRLF when its first LF follows a CR, else LF). */
function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let final = false;
  if (text.endsWith(br)) { final = true; parts.pop(); }
  return { lines: parts, br, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** O and N of a hunk/chunk body: context and `-` lines are O, context and `+` lines are N, in body order. */
function bodyON(body: string[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const bl of body) {
    if (bl.startsWith(' ') || bl === '') {
      const t = bl === '' ? '' : bl.slice(1);
      o.push(t);
      n.push({ text: t, oIdx: o.length - 1 });
    } else if (bl.startsWith('-')) o.push(bl.slice(1));
    else if (bl.startsWith('+')) n.push({ text: bl.slice(1), oIdx: -1 });
  }
  return { o, n };
}

/** Apply unified hunks in order to a file's text (SPEC.md section 6). */
function applyHunks(text: string, hunks: Hunk[], path: string): string {
  const st = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const { o, n } = bodyON(h.body);
    if (o.length === 0) {
      const at = Math.min(h.a + d, st.lines.length);
      const atEnd = at === st.lines.length;
      const ins = n.map((x) => x.text);
      st.lines.splice(at, 0, ...ins);
      if (atEnd) st.final = !h.backslash;
      d += n.length;
    } else {
      const found = findTiered(st.lines, o, 0, false);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) { best = p; bestDist = dist; }
      }
      const touchesEnd = best + o.length === st.lines.length;
      const rep = buildReplacement(o, n, st.lines, best, found.tier);
      st.lines.splice(best, o.length, ...rep);
      if (touchesEnd) st.final = !h.backslash;
      d += n.length - o.length;
    }
  }
  return joinFile(st);
}

interface Hunk { a: number; body: string[]; backslash: boolean; }

interface USection {
  oldGit: string | null | undefined; newGit: string | null | undefined;
  oldPair: string | null | undefined; newPair: string | null | undefined;
  oldRename: string | null | undefined; newRename: string | null | undefined;
  pairSeen: boolean;
  isCreate: boolean; isDelete: boolean;
  hunks: Hunk[];
}

function pickPath(a: string | null | undefined, b: string | null | undefined, c: string | null | undefined): string | null | undefined {
  if (a !== undefined) return a;
  if (b !== undefined) return b;
  return c;
}

/** A `--- ` or `+++ ` path: text after the four characters, up to the first tab, trimmed; /dev/null means no file. */
function headerPath(line: string): string | null {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  const p = (tab >= 0 ? rest.slice(0, tab) : rest).trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function unifiedEdit(sec: USection): Edit {
  const oldP = pickPath(sec.oldPair, sec.oldRename, sec.oldGit);
  const newP = pickPath(sec.newPair, sec.newRename, sec.newGit);
  const isCreate = sec.isCreate || oldP === null;
  const isDelete = !isCreate && (sec.isDelete || newP === null);
  return (tree) => {
    if (isCreate) {
      const np = newP;
      if (np === null || np === undefined) throw new Fail('unsafe', '');
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const bl of h.body) if (bl.startsWith('+')) plus.push(bl.slice(1));
      let content = '';
      if (plus.length > 0) {
        let noBreak = false;
        outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
          const h = sec.hunks[hi]!;
          for (let bi = h.body.length - 1; bi >= 0; bi--) {
            if (h.body[bi]!.startsWith('+')) {
              noBreak = (h.body[bi + 1] ?? '').startsWith('\\');
              break outer;
            }
          }
        }
        content = plus.join('\n') + (noBreak ? '' : '\n');
      }
      tree.now.set(np, content);
      return;
    }
    if (isDelete) {
      const op = oldP;
      if (op === null || op === undefined) throw new Fail('unsafe', '');
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldP as string;
    const np = newP as string;
    if (op !== np) {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const text = tree.get(op);
      if (text === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyHunks(text, sec.hunks, op);
      tree.now.set(op, null);
      tree.now.set(np, out);
      tree.moves.push([op, np]);
      return;
    }
    if (!safe(op)) throw new Fail('unsafe', op);
    const text = tree.get(op);
    if (text === null) throw new Fail('missing', op);
    tree.now.set(op, applyHunks(text, sec.hunks, op));
  };
}

/** Read a patch as a unified diff (SPEC.md section 6). */
function parseUnified(lines: string[]): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let curHunk: Hunk | null = null;
  const flushHunk = (): void => {
    if (curHunk === null || cur === null) return;
    while (curHunk.body.length > 0 && curHunk.body[curHunk.body.length - 1]!.trim() === '') curHunk.body.pop();
    let last = -1;
    curHunk.body.forEach((bl, idx) => { if (bl.startsWith(' ') || bl.startsWith('+') || bl === '') last = idx; });
    curHunk.backslash = last >= 0 && (curHunk.body[last + 1] ?? '').startsWith('\\');
    cur.hunks.push(curHunk);
    curHunk = null;
  };
  const newSection = (): USection => {
    const s: USection = {
      oldGit: undefined, newGit: undefined, oldPair: undefined, newPair: undefined,
      oldRename: undefined, newRename: undefined, pairSeen: false,
      isCreate: false, isDelete: false, hunks: [],
    };
    sections.push(s);
    cur = s;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (curHunk !== null) {
      if (line.startsWith('diff --git ') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        flushHunk();
        continue;
      }
      if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\') || line === '') {
        curHunk.body.push(line);
        i++;
        continue;
      }
      flushHunk();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.oldGit = m[1]!;
      s.newGit = m[2]!;
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (cur !== null && cur.hunks.length === 0 && !cur.pairSeen) {
          cur.oldPair = headerPath(line);
          cur.newPair = headerPath(lines[i + 1]!);
          cur.pairSeen = true;
        } else {
          const s = newSection();
          s.oldPair = headerPath(line);
          s.newPair = headerPath(lines[i + 1]!);
          s.pairSeen = true;
        }
        i += 2;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('+++ ') && cur !== null && cur.hunks.length === 0) {
      cur.newPair = headerPath(line);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      curHunk = { a: parseInt(m[1]!, 10), body: [], backslash: false };
      i++;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.oldRename = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.newRename = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
    }
    i++;
  }
  flushHunk();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map(unifiedEdit);
}

/** One SEARCH/REPLACE block (SPEC.md section 7). */
function srEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const st = splitFile(text);
    const found = findTiered(st.lines, oldLines, 0, false);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const rep = buildReplacement(oldLines, newLines.map((t) => ({ text: t, oIdx: -1 })), st.lines, pos, found.tier);
    st.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, joinFile(st));
  };
}

/** Read a patch as SEARCH/REPLACE blocks (SPEC.md section 7). */
function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    let s = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') { s = j; break; }
    }
    if (s < 0) break;
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j >= i; j--) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    prevPath = path;
    edits.push(srEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep)));
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

interface VChunk { anchor: string | null; eof: boolean; body: string[]; }

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

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null) {
      if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
      if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    }
    const st = splitFile(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const found = findTiered(st.lines, [ch.anchor], cursor, false);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.occ[0]! + 1;
      }
      const { o, n } = bodyON(ch.body);
      if (o.length === 0) {
        const at = ch.eof ? st.lines.length : cursor;
        const ins = n.map((x) => x.text);
        st.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
      } else {
        const found = findTiered(st.lines, o, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.occ[0]!;
        const rep = buildReplacement(o, n, st.lines, pos, found.tier);
        st.lines.splice(pos, o.length, ...rep);
        cursor = pos + rep.length;
      }
    }
    const out = joinFile(st);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

/** Read a patch in the V4A format (SPEC.md section 8). */
function parseV4a(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let idx = lines.length - 1; idx >= 0; idx--) {
    if (!blank(lines[idx]!)) { last = idx; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && blank(lines[i]!)) i++;
    if (i >= last) break;
    const line = lines[i]!;
    const head = line.startsWith('*** Add File:') ? 'add'
      : line.startsWith('*** Delete File:') ? 'delete'
      : line.startsWith('*** Update File:') ? 'update' : null;
    if (head === null) throw new Exit2(`error: parse ${i + 1}`);
    const prefix = head === 'add' ? '*** Add File:' : head === 'delete' ? '*** Delete File:' : '*** Update File:';
    const path = line.slice(prefix.length).trim();
    const headerLine = i + 1;
    let end = last;
    for (let j = i + 1; j < last; j++) {
      const l = lines[j]!;
      if (l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:')) { end = j; break; }
    }
    const extent = lines.slice(i + 1, end);
    while (extent.length > 0 && blank(extent[extent.length - 1]!)) extent.pop();
    if (head === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < extent.length; k++) {
        const l = extent[k]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (head === 'delete') {
      if (extent.length > 0) throw new Exit2(`error: parse ${i + 2}`);
      edits.push(v4aDeleteEdit(path));
    } else {
      const chunks: VChunk[] = [];
      let moveTo: string | null = null;
      let cur: VChunk | null = null;
      for (let k = 0; k < extent.length; k++) {
        const l = extent[k]!;
        const abs = i + 2 + k;
        if (cur === null && blank(l)) continue;
        if (cur === null && moveTo === null && chunks.length === 0 && l.startsWith('*** Move to:')) {
          moveTo = l.slice('*** Move to:'.length).trim();
          continue;
        }
        if (l.startsWith('@@')) {
          cur = { anchor: l.slice(2).trim(), eof: false, body: [] };
          chunks.push(cur);
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${abs}`);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${abs}`);
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          cur.body.push(l);
          continue;
        }
        throw new Exit2(`error: parse ${abs}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks));
    }
    i = end;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
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
  STRICT = strict;
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else edits = parseV4a(lines);
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
  const changed = [...tree.now.keys()]
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .filter((p) => tree.original(p) !== tree.now.get(p));
  const origin = new Map<string, string>();
  for (const [o, n] of tree.moves) origin.set(n, origin.get(o) ?? o);
  const renamed = new Map<string, string>();
  for (const [n, o] of origin) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) renamed.set(n, o);
  }
  const renamedOld = new Set(renamed.values());
  const display: { key: string; line: string }[] = [];
  for (const p of changed) {
    if (renamed.has(p) || renamedOld.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    display.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [n, o] of renamed) display.push({ key: n, line: `R ${o} -> ${n}` });
  display.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = display.map((d) => d.line);
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
