#!/usr/bin/env node
// Reads a class-wise timetable PDF exported from aSc Timetables (one class per page)
// and writes parsed.json: every block on every page with its subject, room, teacher,
// day, start period and length.
//
//   node parse.mjs Class_Wise_Time_Table.pdf -o parsed.json --pages 1-22,24-33
//
// How a page is read:
//   * The grid comes from the drawn lines: header verticals give the 7 period columns,
//     long horizontals that start at the left border give the 5 day rows.
//   * A class that spans two periods has no vertical line between them.
//   * "Group 1 / Group 2" splits are horizontal lines inside a block; those blocks run
//     in parallel (they become elective baskets).
//   * Inside a block the big text is the subject; the small bottom line is the room on
//     the left and the teacher on the right.
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

// Pages used for the Chitkara CSE-AI file of 14-11-2026. Page 23 (CSE-AI 7A),
// 34 (Psychology) and 35 (DEAKIN) are left out for now. Override with --pages.
const DEFAULT_PAGES = '1-22,24-33';

const round1 = (v) => Math.round(v * 10) / 10;

export function pageSet(spec) {
  const out = new Set();
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-').map(Number);
    for (let p = a; p <= (b || a); p++) out.add(p);
  }
  return out;
}

const multiply = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/** Straight two-point strokes on the page, in top-left coordinates (like a screen). */
async function pageLines(page, height) {
  const ops = await page.getOperatorList();
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const lines = [];
  for (let k = 0; k < ops.fnArray.length; k++) {
    const fn = ops.fnArray[k];
    const args = ops.argsArray[k];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = multiply(ctm, args);
    else if (fn === OPS.constructPath) {
      const [cmds, coords] = args;
      if (cmds.length !== 2 || cmds[0] !== OPS.moveTo || cmds[1] !== OPS.lineTo) continue;
      const pt = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
      const [ax, ay] = pt(coords[0], coords[1]);
      const [bx, by] = pt(coords[2], coords[3]);
      lines.push({ x0: Math.min(ax, bx), x1: Math.max(ax, bx), top: height - Math.max(ay, by), bottom: height - Math.min(ay, by) });
    }
  }
  return lines;
}

/** Text pieces with their box, merged into runs the way they read on screen. */
async function pageText(page, height) {
  const { items } = await page.getTextContent();
  const pieces = items
    .filter((i) => i.str.trim())
    .map((i) => {
      const size = Math.hypot(i.transform[2], i.transform[3]);
      const [x, y] = [i.transform[4], i.transform[5]];
      return { text: i.str, x0: x, x1: x + i.width, top: height - y - size * 0.8, bottom: height - y + size * 0.2, size };
    });
  // A run breaks when the size or line changes, the text jumps backwards (overlapping
  // labels) or there is a big gap.
  const runs = [];
  let cur = null;
  for (const p of pieces) {
    const brk = !cur || Math.abs(p.size - cur.size) > 0.5 || Math.abs(p.top - cur.top) > 2 || p.x0 < cur.x1 - 1 || p.x0 - cur.x1 > 6;
    if (brk) {
      if (cur) runs.push(cur);
      cur = { ...p };
    } else {
      cur.text += (p.x0 - cur.x1 > 1.2 && !cur.text.endsWith(' ') ? ' ' : '') + p.text;
      cur.x1 = p.x1;
      cur.bottom = Math.max(cur.bottom, p.bottom);
    }
  }
  if (cur) runs.push(cur);
  return runs.map((r) => ({ ...r, text: r.text.replace(/\s+/g, ' ').trim() })).filter((r) => r.text);
}

function parseBlock(runs, [x0, y0, x1, y1]) {
  const inside = runs.filter((r) => {
    const cx = (r.x0 + r.x1) / 2;
    const cy = (r.top + r.bottom) / 2;
    return cx >= x0 - 0.5 && cx <= x1 + 0.5 && cy >= y0 - 0.5 && cy <= y1 + 0.5;
  });
  if (!inside.length) return null;
  const big = inside.filter((r) => r.size >= 11).sort((a, b) => Math.round(a.top) - Math.round(b.top) || a.x0 - b.x0);
  let group = null;
  const rest = [];
  for (const s of inside.filter((r) => r.size < 11)) {
    const m = s.text.match(/^Group\s*(\d+)$/);
    if (m) group = Number(m[1]);
    else rest.push(s);
  }
  const subject = big.map((r) => r.text).join(' ').trim();
  let room = '';
  let teacher = '';
  if (rest.length) {
    const bottom = Math.max(...rest.map((r) => r.top));
    const line = rest.filter((r) => Math.abs(r.top - bottom) < 3).sort((a, b) => a.x0 - b.x0);
    if (line.length === 1) {
      if ((line[0].x0 + line[0].x1) / 2 < (x0 + x1) / 2) room = line[0].text;
      else teacher = line[0].text;
    } else {
      room = line[0].text;
      teacher = line.slice(1).map((r) => r.text).join(' ');
    }
  }
  if (!subject && !room && !teacher) return null;
  return { subject, room, teacher, group };
}

export async function parsePage(page) {
  const { height } = page.getViewport({ scale: 1 });
  const [lines, runs] = await Promise.all([pageLines(page, height), pageText(page, height)]);
  const title = runs.filter((r) => r.size > 25 && r.top < 40).map((r) => r.text).join(' ');
  const V = lines.filter((l) => l.x1 - l.x0 < 0.5);
  const H = lines.filter((l) => l.bottom - l.top < 0.5);

  // Column edges: the header separators plus the right border (the first edge is the day-label column).
  const hdrBottom = Math.min(...H.filter((l) => l.x1 - l.x0 > 600 && l.top > 80).map((l) => l.top));
  const xs = [...new Set(V.filter((l) => l.top < hdrBottom - 5 && l.bottom > hdrBottom - 5).map((l) => round1(l.x0)))].filter((x) => x > 50).sort((a, b) => a - b);
  // Row edges: horizontal lines that start at the far-left border.
  const ys = [...new Set(H.filter((l) => l.x0 < 20 && l.top >= hdrBottom - 1).map((l) => round1(l.top)))].sort((a, b) => a - b);
  if (xs.length !== 8 || ys.length !== 6) throw new Error(`Unexpected grid on "${title}": ${xs.length} column edges, ${ys.length} row edges`);
  const colMid = Array.from({ length: 7 }, (_, i) => (xs[i] + xs[i + 1]) / 2);

  const blocks = [];
  for (let d = 0; d < 5; d++) {
    const [y0, y1] = [ys[d], ys[d + 1]];
    const seps = new Set([xs[0], xs[7]]);
    for (const l of V) if (l.top <= y0 + 1.5 && l.bottom >= y1 - 1.5 && l.x0 > xs[0] - 1 && l.x0 < xs[7] + 1) seps.add(round1(l.x0));
    const edges = [...seps].sort((a, b) => a - b);
    for (let k = 0; k + 1 < edges.length; k++) {
      const [a, b] = [edges[k], edges[k + 1]];
      const periods = colMid.map((m, i) => (a < m && m < b ? i : -1)).filter((i) => i >= 0);
      if (!periods.length) continue;
      // Thin horizontal splits inside this block = sub-groups running in parallel.
      const cuts = [...new Set(H.filter((l) => l.top > y0 + 2 && l.top < y1 - 2 && l.x0 <= a + 1.5 && l.x1 >= b - 1.5).map((l) => round1(l.top)))].sort((p, q) => p - q);
      const tops = [y0, ...cuts];
      const bottoms = [...cuts, y1];
      tops.forEach((by0, i) => {
        const blk = parseBlock(runs, [a, by0, b, bottoms[i]]);
        if (blk) blocks.push({ ...blk, day: d, start: periods[0], duration: periods.length, parallel: tops.length > 1 });
      });
    }
  }
  return { title, blocks };
}

export async function parsePdf(file, pages = DEFAULT_PAGES) {
  const wanted = pageSet(pages);
  const doc = await getDocument({ url: file, verbosity: 0 }).promise;
  const classes = [];
  for (let i = 1; i <= doc.numPages; i++) {
    if (!wanted.has(i)) continue;
    const { title, blocks } = await parsePage(await doc.getPage(i));
    classes.push({ page: i, name: title, blocks });
  }
  return classes;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string', short: 'o', default: 'parsed.json' }, pages: { type: 'string', default: DEFAULT_PAGES } } });
  if (!positionals[0]) {
    console.error('Usage: node parse.mjs <timetable.pdf> [-o parsed.json] [--pages 1-22,24-33]');
    process.exit(1);
  }
  const classes = await parsePdf(positionals[0], values.pages);
  await writeFile(values.out, JSON.stringify(classes, null, 1));
  console.log(`${classes.length} classes, ${classes.reduce((n, c) => n + c.blocks.length, 0)} blocks`);
}
