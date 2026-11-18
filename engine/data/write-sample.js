// Regenerates sample-problem.json: `node data/write-sample.js`
import { writeFileSync } from 'node:fs';
import { buildProblem } from './build-problem.js';

const problem = buildProblem({ sectionCount: 8 });
writeFileSync(new URL('./sample-problem.json', import.meta.url), JSON.stringify(problem, null, 2));
console.log(`sample-problem.json: ${problem.sections.length} sections, ${problem.faculty.length} faculty, ${problem.rooms.length} rooms, ${problem.offerings.length} offerings, ${problem.baskets.length} elective baskets`);
