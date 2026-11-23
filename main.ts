// main.ts is mend, the CLI SPEC.md specifies (MIT). It reads the four formats AI models write edits in,
// matches lines at three tiers of whitespace tolerance, and writes every file or none.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and the last lines below hand over
// to runner.ts: that hand-over and runner.ts stay as they are.

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

interface Edit {
  apply: (tree: Tree) => void;
  move?: { from: string; to: string };
}

interface NLine {
  text: string;
  ctx: boolean;
  oi: number;
}

interface HunkLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

interface Hunk {
  a: number;
  body: HunkLine[];
}

interface USection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  delete: boolean;
  hunks: Hunk[];
  maxTier: number;
  move?: { from: string; to: string };
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

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function matchAt(lines: string[], O: string[], pos: number, tier: number): boolean {
  if (pos < 0 || pos + O.length > lines.length) return false;
  for (let j = 0; j < O.length; j += 1) if (!tierEq(lines[pos + j]!, O[j]!, tier)) return false;
  return true;
}

/** The first tier at which O occurs at all, with every occurrence at that tier. */
function findFirst(lines: string[], O: string[], maxTier: number): { tier: number; occ: number[] } | null {
  for (let t = 0; t <= maxTier; t += 1) {
    const occ: number[] = [];
    for (let k = 0; k + O.length <= lines.length; k += 1) if (matchAt(lines, O, k, t)) occ.push(k);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first tier at which O occurs, taking the occurrence nearest to `target` (the earlier of two equally near). */
function findNearest(lines: string[], O: string[], target: number, maxTier: number): { tier: number; pos: number } | null {
  for (let t = 0; t <= maxTier; t += 1) {
    let best = -1;
    let bestD = 0;
    for (let k = 0; k + O.length <= lines.length; k += 1) {
      if (!matchAt(lines, O, k, t)) continue;
      const d = Math.abs(k - target);
      if (best < 0 || d < bestD) {
        best = k;
        bestD = d;
      }
    }
    if (best >= 0) return { tier: t, pos: best };
  }
  return null;
}

interface Doc {
  lines: string[];
  br: string;
  final: boolean;
}

function splitDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text.charAt(nl - 1) === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let final = false;
  if (parts.length > 1 && parts[parts.length - 1] === '') {
    final = true;
    parts.pop();
  }
  return { lines: parts, br, final };
}

function joinDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

/** The replacement lines for a match of O at `pos`: context lines as the file has them, added lines re-indented at tier 2. */
function buildRep(lines: string[], pos: number, O: string[], N: NLine[], tier: number): string[] {
  const P = leadingWs(O.length > 0 ? O[0]! : '');
  const F = leadingWs(pos < lines.length ? lines[pos]! : '');
  const rep: string[] = [];
  for (const e of N) {
    if (e.ctx) {
      rep.push(lines[pos + e.oi]!);
      continue;
    }
    let t = e.text;
    if (tier === 2 && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
    rep.push(t);
  }
  return rep;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart().charAt(0);
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => stripTrail(l) === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------- section 6: unified diffs

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function headerPath(line: string): string | null {
  const rest = line.slice(4).split('\t')[0]!.trim();
  if (rest === '/dev/null') return null;
  return rest.startsWith('a/') || rest.startsWith('b/') ? rest.slice(2) : rest;
}

function parseUnified(lines: string[], maxTier: number): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    const L = lines[i]!;
    if (L.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    const isGit = L.startsWith('diff --git ');
    const isDash = L.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
    if (!isGit && !isDash) {
      i += 1;
      continue;
    }
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let named = false;
    let mode: string | null = null;
    let j = i;
    if (isGit) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(L);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      oldPath = m[1]!;
      newPath = m[2]!;
      j = i + 1;
    }
    const hunks: Hunk[] = [];
    let started = false;
    while (j < lines.length) {
      const M = lines[j]!;
      if (M.startsWith('diff --git ')) break;
      if (M.startsWith('@@')) {
        const hm = HUNK_HEAD.exec(M);
        if (hm === null) throw new Exit2(`error: parse ${j + 1}`);
        started = true;
        const a = Number(hm[1]);
        const body: HunkLine[] = [];
        let k = j + 1;
        while (k < lines.length) {
          const B = lines[k]!;
          if (B.startsWith('diff --git ')) break;
          if (B.startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ')) break;
          if (B === '') {
            body.push({ kind: ' ', text: '' });
            k += 1;
            continue;
          }
          const c = B.charAt(0);
          if (c === ' ' || c === '-' || c === '+' || c === '\\') {
            body.push({ kind: c as HunkLine['kind'], text: B.slice(1) });
            k += 1;
            continue;
          }
          break;
        }
        while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '') body.pop();
        hunks.push({ a, body });
        j = k;
        continue;
      }
      if (started) {
        if (M.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        j += 1;
        continue;
      }
      if (M.startsWith('--- ')) {
        if (!(lines[j + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${j + 2}`);
        oldPath = headerPath(M);
        newPath = headerPath(lines[j + 1]!);
        named = true;
        j += 2;
        continue;
      }
      if (M.startsWith('rename from ')) {
        if (!named) oldPath = M.slice(12).trim();
        j += 1;
        continue;
      }
      if (M.startsWith('rename to ')) {
        if (!named) newPath = M.slice(10).trim();
        j += 1;
        continue;
      }
      if (M.startsWith('new file mode')) mode = 'create';
      else if (M.startsWith('deleted file mode')) mode = 'delete';
      j += 1;
    }
    const create = mode === 'create' || (oldPath === null && newPath !== null);
    const del = mode === 'delete' || (newPath === null && oldPath !== null);
    const move = !create && !del && oldPath !== null && newPath !== null && oldPath !== newPath ? { from: oldPath, to: newPath } : undefined;
    edits.push(unifiedEdit({ oldPath, newPath, create, delete: del, hunks, maxTier, move }));
    i = j;
  }
  return edits;
}

function unifiedEdit(sec: USection): Edit {
  const edit: Edit = {
    apply: (tree: Tree): void => {
      const oldP = sec.oldPath;
      const newP = sec.newPath;
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && newP !== oldP && !safe(newP)) throw new Fail('unsafe', newP);
      if (sec.create) {
        if (newP === null) throw new Fail('missing', oldP ?? '');
        const p = newP;
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const out: string[] = [];
        let noEol = false;
        for (const h of sec.hunks) {
          for (let k = 0; k < h.body.length; k += 1) {
            const b = h.body[k]!;
            if (b.kind !== '+') continue;
            out.push(b.text);
            noEol = h.body[k + 1] !== undefined && h.body[k + 1]!.kind === '\\';
          }
        }
        tree.now.set(p, joinDoc({ lines: out, br: '\n', final: !noEol }));
        return;
      }
      if (sec.delete) {
        if (oldP === null) throw new Fail('missing', newP ?? '');
        const p = oldP;
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      if (oldP === null) throw new Fail('missing', newP ?? '');
      const p = oldP;
      const src = tree.get(p);
      if (src === null) throw new Fail('missing', p);
      const out = applyHunks(splitDoc(src), sec.hunks, p, sec.maxTier);
      if (newP !== null && newP !== p) {
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        tree.now.set(newP, out);
        tree.now.set(p, null);
      } else {
        tree.now.set(p, out);
      }
    },
  };
  if (sec.move !== undefined) edit.move = sec.move;
  return edit;
}

function applyHunks(doc: Doc, hunks: Hunk[], p: string, maxTier: number): string {
  let lines = doc.lines.slice();
  let final = doc.final;
  let d = 0;
  for (const h of hunks) {
    const O: string[] = [];
    const N: NLine[] = [];
    let oi = 0;
    let lastN = -1;
    for (let k = 0; k < h.body.length; k += 1) {
      const b = h.body[k]!;
      if (b.kind === ' ') {
        O.push(b.text);
        N.push({ text: b.text, ctx: true, oi });
        oi += 1;
        lastN = k;
      } else if (b.kind === '-') {
        O.push(b.text);
        oi += 1;
      } else if (b.kind === '+') {
        N.push({ text: b.text, ctx: false, oi: -1 });
        lastN = k;
      }
    }
    const noEol = lastN >= 0 && h.body[lastN + 1] !== undefined && h.body[lastN + 1]!.kind === '\\';
    let pos = 0;
    let tier = 0;
    if (O.length === 0) {
      pos = Math.min(Math.max(h.a + d, 0), lines.length);
    } else {
      const found = findNearest(lines, O, h.a - 1 + d, maxTier);
      if (found === null) throw new Fail('no-match', p);
      pos = found.pos;
      tier = found.tier;
    }
    const endReached = pos + O.length >= lines.length;
    const rep = buildRep(lines, pos, O, N, tier);
    lines = [...lines.slice(0, pos), ...rep, ...lines.slice(pos + O.length)];
    d += N.length - O.length;
    if (endReached) final = !noEol;
  }
  return joinDoc({ lines, br: doc.br, final });
}

// ---------------------------------------------------------------- section 7: SEARCH/REPLACE blocks

const isSearchLine = (s: string): boolean => stripTrail(s) === '<<<<<<< SEARCH';
const isSepLine = (s: string): boolean => stripTrail(s) === '=======';
const isReplaceLine = (s: string): boolean => stripTrail(s) === '>>>>>>> REPLACE';

function parseSearchReplace(lines: string[], maxTier: number): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (!isSearchLine(lines[i]!)) {
      i += 1;
      continue;
    }
    let sep = -1;
    let end = -1;
    for (let k = i + 1; k < lines.length; k += 1) {
      if (sep < 0 && isSepLine(lines[k]!)) {
        sep = k;
        continue;
      }
      if (isReplaceLine(lines[k]!)) {
        end = k;
        break;
      }
    }
    if (sep < 0 || end < 0) throw new Exit2(`error: parse ${i + 1}`);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    let path: string | null = null;
    for (let k = i - 1; k > prevEnd; k -= 1) {
      const t = lines[k]!;
      if (blank(t)) continue;
      const tt = t.trim();
      if (tt.startsWith('```')) continue;
      path = tt;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    const p: string = path;
    const O = oldLines;
    const N: NLine[] = newLines.map((t) => ({ text: t, ctx: false, oi: -1 }));
    edits.push({
      apply: (tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (O.length === 0) {
          if (tree.get(p) !== null) throw new Fail('exists', p);
          tree.now.set(p, joinDoc({ lines: newLines, br: '\n', final: true }));
          return;
        }
        const src = tree.get(p);
        if (src === null) throw new Fail('missing', p);
        const doc = splitDoc(src);
        const found = findFirst(doc.lines, O, maxTier);
        if (found === null) throw new Fail('no-match', p);
        if (found.occ.length > 1) throw new Fail('ambiguous', p);
        const pos = found.occ[0]!;
        const rep = buildRep(doc.lines, pos, O, N, found.tier);
        const lines = [...doc.lines.slice(0, pos), ...rep, ...doc.lines.slice(pos + O.length)];
        tree.now.set(p, joinDoc({ lines, br: doc.br, final: doc.final }));
      },
    });
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

// ---------------------------------------------------------------- section 8: V4A patches

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: HunkLine[];
}

const isAddFile = (s: string): boolean => s.startsWith('*** Add File: ');
const isDeleteFile = (s: string): boolean => s.startsWith('*** Delete File: ');
const isUpdateFile = (s: string): boolean => s.startsWith('*** Update File: ');
const isSectionStart = (s: string): boolean => isAddFile(s) || isDeleteFile(s) || isUpdateFile(s);

function parseV4a(lines: string[], maxTier: number): Edit[] {
  const firstNonBlank = lines.findIndex((l) => !blank(l));
  if (firstNonBlank < 0) throw new Exit2('error: parse 1');
  if (lines[firstNonBlank]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstNonBlank + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = firstNonBlank + 1;
  while (i < last) {
    const L = lines[i]!;
    if (blank(L)) {
      i += 1;
      continue;
    }
    if (isAddFile(L)) {
      const p = L.slice(14).trim();
      const body: string[] = [];
      let j = i + 1;
      let noEol = false;
      while (j < last && !isSectionStart(lines[j]!)) {
        const M = lines[j]!;
        if (M === '') body.push('');
        else if (M.startsWith('+')) body.push(M.slice(1));
        else throw new Exit2(`error: parse ${j + 1}`);
        j += 1;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      noEol = false;
      edits.push({
        apply: (tree: Tree): void => {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (tree.get(p) !== null) throw new Fail('exists', p);
          tree.now.set(p, joinDoc({ lines: body, br: '\n', final: !noEol }));
        },
      });
      i = j;
      continue;
    }
    if (isDeleteFile(L)) {
      const p = L.slice(17).trim();
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
        j += 1;
      }
      edits.push({
        apply: (tree: Tree): void => {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (tree.get(p) === null) throw new Fail('missing', p);
          tree.now.set(p, null);
        },
      });
      i = j;
      continue;
    }
    if (isUpdateFile(L)) {
      const p = L.slice(17).trim();
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice(13).trim();
        j += 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      while (j < last) {
        const M = lines[j]!;
        if (isSectionStart(M)) break;
        if (M.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const text = M.slice(2).trim();
          cur = { anchor: text === '' ? null : text, eof: false, body: [] };
          j += 1;
          continue;
        }
        if (M.trim() === '*** End of File') {
          if (cur === null) cur = { anchor: null, eof: true, body: [] };
          else cur.eof = true;
          chunks.push(cur);
          cur = null;
          j += 1;
          continue;
        }
        if (M === '' || M.startsWith(' ') || M.startsWith('-') || M.startsWith('+')) {
          if (cur === null) cur = { anchor: null, eof: false, body: [] };
          cur.body.push({ kind: M === '' ? ' ' : (M.charAt(0) as HunkLine['kind']), text: M === '' ? '' : M.slice(1) });
          j += 1;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      if (cur !== null) chunks.push(cur);
      for (const ch of chunks) {
        while (ch.body.length > 0 && ch.body[ch.body.length - 1]!.kind === ' ' && ch.body[ch.body.length - 1]!.text === '') ch.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      const edit: Edit = {
        apply: (tree: Tree): void => {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
          const src = tree.get(p);
          if (src === null) throw new Fail('missing', p);
          if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
          const doc = splitDoc(src);
          let lines = doc.lines.slice();
          let cursor = 0;
          for (const ch of chunks) {
            if (ch.anchor !== null) {
              const anchor = ch.anchor;
              let found = -1;
              for (let t = 0; t <= maxTier && found < 0; t += 1) {
                for (let k = cursor; k < lines.length; k += 1) {
                  if (tierEq(lines[k]!, anchor, t)) {
                    found = k;
                    break;
                  }
                }
              }
              if (found < 0) throw new Fail('no-match', p);
              cursor = found + 1;
            }
            const O: string[] = [];
            const N: NLine[] = [];
            let oi = 0;
            for (const b of ch.body) {
              if (b.kind === ' ') {
                O.push(b.text);
                N.push({ text: b.text, ctx: true, oi });
                oi += 1;
              } else if (b.kind === '-') {
                O.push(b.text);
                oi += 1;
              } else if (b.kind === '+') {
                N.push({ text: b.text, ctx: false, oi: -1 });
              }
            }
            let pos = -1;
            let tier = 0;
            if (O.length === 0) {
              pos = ch.eof ? lines.length : Math.min(cursor, lines.length);
            } else {
              for (let t = 0; t <= maxTier && pos < 0; t += 1) {
                for (let k = cursor; k + O.length <= lines.length; k += 1) {
                  if (!matchAt(lines, O, k, t)) continue;
                  if (ch.eof && k + O.length !== lines.length) continue;
                  pos = k;
                  tier = t;
                  break;
                }
              }
              if (pos < 0) throw new Fail('no-match', p);
            }
            const rep = buildRep(lines, pos, O, N, tier);
            lines = [...lines.slice(0, pos), ...rep, ...lines.slice(pos + O.length)];
            cursor = pos + rep.length;
          }
          const out = joinDoc({ lines, br: doc.br, final: doc.final });
          if (moveTo !== null) {
            tree.now.set(moveTo, out);
            tree.now.set(p, null);
          } else {
            tree.now.set(p, out);
          }
        },
      };
      if (moveTo !== null) edit.move = { from: p, to: moveTo };
      edits.push(edit);
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// ---------------------------------------------------------------- section 9: JSON edits

function jsonEdit(v: unknown): ((tree: Tree) => void) | null {
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
      const crlf = nl > 0 && before.charAt(nl - 1) === '\r';
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
      const br = nl > 0 && before.charAt(nl - 1) === '\r' ? '\r\n' : '\n';
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
      edits.push({ apply: e });
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: ((tree: Tree) => void) | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push({ apply: e });
  });
  return edits;
}

// ---------------------------------------------------------------- the command line

function byteCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
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
  const maxTier = strict ? 0 : 2;
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, maxTier);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, maxTier);
    else edits = parseV4a(lines, maxTier);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: Array<{ from: string; to: string }> = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit.apply(tree);
      if (edit.move !== undefined) moves.push(edit.move);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };

  // A move is reported as one R row only when the old path existed before, is gone after, and the
  // new path did not exist before and does after; anything else is an ordinary A, D or M.
  const moveRow = new Map<string, string>();
  const movedFrom = new Set<string>();
  for (const m of moves) {
    if (tree.original(m.from) !== null && tree.get(m.from) === null && tree.original(m.to) === null && tree.get(m.to) !== null) {
      moveRow.set(m.to, m.from);
      movedFrom.add(m.from);
    }
  }
  const rows: string[] = [];
  const writes: Array<[string, string | null]> = [];
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (movedFrom.has(p)) {
      writes.push([p, null]);
      continue;
    }
    const from = moveRow.get(p);
    if (from !== undefined && tree.get(from) === null) rows.push(`R ${from} -> ${p}`);
    else rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    writes.push([p, now]);
  }
  if (!check) {
    for (const [p, now] of writes) {
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  rows.push(`ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`);
  return { code: 0, out: rows };
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
