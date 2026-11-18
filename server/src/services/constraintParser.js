// Turns sentences like "Dr. Sharma can't teach before 10 on Mondays" into structured
// rules: { subjectType, subjectId, kind, day, periodFrom, periodTo }.
//
// 1. If GROQ_API_KEY is set, an LLM (free Groq tier) does the parsing.
// 2. If there is no key, the call fails, or the free-tier limit is hit (HTTP 429),
//    a built-in rule-based parser handles the common phrasings instead.
// Either way, nothing is saved until the user confirms the preview.
import { z } from 'zod';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const TITLES = new Set(['dr', 'prof', 'professor', 'mr', 'mrs', 'ms', 'miss', 'sir', 'madam', 'maam']);
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
};

// ---------- subject (teacher / section) matching ----------
export function findSubject(text, ctx) {
  const t = ` ${norm(text)} `;
  let best = [];
  let bestScore = 0;
  for (const f of ctx.faculty) {
    const parts = norm(f.name).split(' ').filter((w) => !TITLES.has(w));
    if (!parts.length) continue;
    const first = parts[0];
    const last = parts[parts.length - 1];
    let score = 0;
    if (t.includes(` ${parts.join(' ')} `)) score = 4;
    else if (parts.length > 1 && new RegExp(`\\b(dr|prof|professor|mr|mrs|ms)\\s+${last}\\b`).test(t)) score = 3;
    else if (parts.length > 1 && t.includes(` ${last} `)) score = 2;
    else if (t.includes(` ${first} `)) score = 1;
    if (score > bestScore) {
      bestScore = score;
      best = [f];
    } else if (score && score === bestScore) best.push(f);
  }
  if (best.length) return { type: 'faculty', matches: best, exact: bestScore >= 3 };
  for (const s of ctx.sections) {
    const n = norm(s.name);
    const label = n.split(/[\s-]/).pop();
    if (t.includes(` ${n} `) || new RegExp(`\\bsection\\s+${label}\\b`).test(t)) return { type: 'section', matches: [s] };
  }
  return { type: null, matches: [] };
}

// ---------- days ----------
const DAY_WORDS = [
  ['mon', /\b(mon|monday|mondays)\b/],
  ['tue', /\b(tue|tues|tuesday|tuesdays)\b/],
  ['wed', /\b(wed|wednesday|wednesdays)\b/],
  ['thu', /\b(thu|thur|thurs|thursday|thursdays)\b/],
  ['fri', /\b(fri|friday|fridays)\b/],
  ['sat', /\b(sat|saturday|saturdays)\b/],
  ['sun', /\b(sun|sunday|sundays)\b/],
];

export function findDays(text, days) {
  const t = norm(text);
  const all = days.map((_, i) => i);
  if (/\b(weekdays|every ?day|daily|all days|any day)\b/.test(t)) return all;
  const found = [];
  days.forEach((d, i) => {
    const key = d.toLowerCase().slice(0, 3);
    const entry = DAY_WORDS.find(([k]) => k === key);
    if (entry && entry[1].test(t)) found.push(i);
  });
  return found.length ? found : all;
}

// ---------- times → periods ----------
function parseTime(raw) {
  const m = raw.match(/(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const ap = (m[3] || '').toLowerCase().replace(/\./g, '');
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (!ap && h <= 7) h += 12; // "after 3" in a college day means 3 pm
  return h * 60 + min;
}

export function findPeriods(text, ctx) {
  const t = text.toLowerCase();
  const P = ctx.periodsPerDay;
  const breaks = new Set(ctx.breaks || []);
  const teaching = [...Array(P).keys()].filter((p) => !breaks.has(p));
  const times = ctx.periodTimes || [];
  const startOf = (p) => (times[p]?.start ? toMinutes(times[p].start) : null);
  const timeWord = '(\\d{1,2}(?:[:.]\\d{2})?\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)?)';

  let m;
  if (/\b(first|1st)\s+(period|class|lecture|slot)/.test(t)) return [teaching[0]];
  if (/\blast\s+(period|class|lecture|slot)/.test(t)) return [teaching[teaching.length - 1]];
  if ((m = t.match(/\bperiod\s+(\d{1,2})\b/)) || (m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+period\b/))) {
    const p = Number(m[1]) - 1;
    return p >= 0 && p < P ? [p] : [];
  }
  const firstBreak = Math.min(...(ctx.breaks?.length ? ctx.breaks : [Math.floor(P / 2)]));
  if (/\bmorning|before lunch\b/.test(t)) return teaching.filter((p) => p < firstBreak);
  if (/\bafternoon|after lunch\b/.test(t)) return teaching.filter((p) => p > firstBreak);
  if (!times.length) return teaching;
  if ((m = t.match(new RegExp(`\\b(?:between|from)\\s+${timeWord}\\s+(?:and|to|-|till|until)\\s+${timeWord}`)))) {
    const a = parseTime(m[1]);
    const b = parseTime(m[2]);
    return teaching.filter((p) => startOf(p) >= a && startOf(p) < b);
  }
  if ((m = t.match(new RegExp(`\\b(?:before|until|till)\\s+${timeWord}`)))) {
    const a = parseTime(m[1]);
    return teaching.filter((p) => startOf(p) < a);
  }
  if ((m = t.match(new RegExp(`\\b(?:after|from)\\s+${timeWord}`)))) {
    const a = parseTime(m[1]);
    return teaching.filter((p) => startOf(p) >= a);
  }
  return teaching;
}

const toRanges = (periods) => {
  const sorted = [...new Set(periods)].sort((a, b) => a - b);
  const ranges = [];
  for (const p of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && p === last[1] + 1) last[1] = p;
    else ranges.push([p, p]);
  }
  return ranges;
};

const describe = (c, ctx) => {
  const times = ctx.periodTimes || [];
  const from = times[c.periodFrom]?.start || `P${c.periodFrom + 1}`;
  const to = times[c.periodTo]?.end || `P${c.periodTo + 1}`;
  return `${c.subjectName} ${c.kind === 'avoid' ? 'prefers not to teach' : 'is unavailable'} on ${ctx.days[c.day]}, ${from}–${to}`;
};

export function parseWithRules(text, ctx) {
  const warnings = [];
  const subject = findSubject(text, ctx);
  if (!subject.matches.length) return { constraints: [], warnings: ['Could not find a teacher or section name in that sentence.'] };
  if (subject.matches.length > 1) warnings.push(`"${text}" could mean ${subject.matches.map((m) => m.name).join(' or ')}; using ${subject.matches[0].name}.`);
  const who = subject.matches[0];
  if (subject.type === 'faculty' && !subject.exact && subject.matches.length === 1)
    warnings.push(`No teacher matches that full name; guessed ${who.name}. Check before saving.`);
  const kind = /\b(prefer|prefers|rather|avoid|if possible|ideally|would like)\b/i.test(text) ? 'avoid' : 'unavailable';
  const days = findDays(text, ctx.days);
  const periods = findPeriods(text, ctx);
  if (!periods.length) return { constraints: [], warnings: [...warnings, 'Could not work out which periods that means.'] };
  const constraints = [];
  for (const day of days) {
    for (const [periodFrom, periodTo] of toRanges(periods)) {
      constraints.push({ subjectType: subject.type, subjectId: who.id, subjectName: who.name, kind, day, periodFrom, periodTo });
    }
  }
  return { constraints, warnings };
}

// ---------- LLM (Groq) ----------
const llmSchema = z.object({
  constraints: z
    .array(
      z.object({
        subjectType: z.enum(['faculty', 'section']),
        subjectId: z.string(),
        kind: z.enum(['unavailable', 'avoid']),
        days: z.array(z.number().int().min(0)),
        periodFrom: z.number().int().min(0),
        periodTo: z.number().int().min(0),
      }),
    )
    .default([]),
  warnings: z.array(z.string()).default([]),
});

function buildPrompt(ctx) {
  const periods = (ctx.periodTimes?.length ? ctx.periodTimes : [...Array(ctx.periodsPerDay)].map(() => ({})))
    .map((p, i) => `${i}: ${p.start || '?'}-${p.end || '?'}${ctx.breaks?.includes(i) ? ' (break)' : ''}`)
    .join('\n');
  return [
    'You convert timetable availability rules written in plain English into JSON. Reply with JSON only.',
    'Schema: {"constraints":[{"subjectType":"faculty"|"section","subjectId":string,"kind":"unavailable"|"avoid","days":[dayIndex],"periodFrom":periodIndex,"periodTo":periodIndex}],"warnings":[string]}',
    'Use "avoid" for soft preferences (prefers, would rather, if possible) and "unavailable" for hard rules.',
    'If no day is given, include every day. If no time is given, cover all teaching periods.',
    'If a rule covers non-adjacent periods, output several constraints. Only use ids from the lists below; if unsure, add a warning instead of guessing.',
    `Days (index: name): ${ctx.days.map((d, i) => `${i}: ${d}`).join(', ')}`,
    `Periods (index: time):\n${periods}`,
    `Faculty (id: name):\n${ctx.faculty.slice(0, 400).map((f) => `${f.id}: ${f.name}`).join('\n')}`,
    `Sections (id: name):\n${ctx.sections.slice(0, 200).map((s) => `${s.id}: ${s.name}`).join('\n')}`,
  ].join('\n\n');
}

export async function parseWithGroq(text, ctx) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env.GROQ_MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: buildPrompt(ctx) },
        { role: 'user', content: text },
      ],
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Groq returned HTTP ${res.status}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  const json = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
  const parsed = llmSchema.parse(json);

  const facultyById = new Map(ctx.faculty.map((f) => [f.id, f]));
  const sectionById = new Map(ctx.sections.map((s) => [s.id, s]));
  const constraints = [];
  const warnings = [...parsed.warnings];
  for (const c of parsed.constraints) {
    const who = c.subjectType === 'faculty' ? facultyById.get(c.subjectId) : sectionById.get(c.subjectId);
    if (!who) {
      warnings.push(`Ignored a rule for unknown ${c.subjectType} "${c.subjectId}".`);
      continue;
    }
    if (c.periodFrom > c.periodTo || c.periodTo >= ctx.periodsPerDay) {
      warnings.push('Ignored a rule with an invalid period range.');
      continue;
    }
    for (const day of c.days.filter((d) => d < ctx.days.length)) {
      constraints.push({ subjectType: c.subjectType, subjectId: who.id, subjectName: who.name, kind: c.kind, day, periodFrom: c.periodFrom, periodTo: c.periodTo });
    }
  }
  return { constraints, warnings };
}

export async function parseConstraintText(text, ctx) {
  let result;
  let source = 'rules';
  if (env.GROQ_API_KEY) {
    try {
      result = await parseWithGroq(text, ctx);
      source = 'ai';
    } catch (err) {
      logger.warn('AI parsing failed, using built-in parser', { err: err.message });
      result = parseWithRules(text, ctx);
      result.warnings.unshift('AI parsing was unavailable, so the built-in parser was used.');
    }
  } else {
    result = parseWithRules(text, ctx);
  }
  return { source, ...result, constraints: result.constraints.map((c) => ({ ...c, summary: describe(c, ctx) })) };
}
