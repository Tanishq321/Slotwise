// npm run bench — measures how fast a clash-free timetable is found at different sizes.
import { generate, checkTimetable } from '../src/index.js';
import { buildProblem } from '../data/build-problem.js';

const sizes = process.argv.slice(2).map(Number).filter(Boolean);
const rows = [];
for (const n of sizes.length ? sizes : [8, 16, 40, 80]) {
  const problem = buildProblem({ sectionCount: n });
  const result = generate(problem, { seed: 1, timeLimitMs: 5000 });
  const clashes = checkTimetable(problem, result.events).length;
  rows.push({
    sections: n,
    faculty: problem.faculty.length,
    rooms: problem.rooms.length,
    classes: result.stats.events,
    status: result.status,
    clashes,
    'clash-free in (ms)': result.stats.constructMs,
    'cost before': result.stats.costBeforeOptimise,
    'cost after 5s': result.score.soft,
  });
}
console.table(rows);
