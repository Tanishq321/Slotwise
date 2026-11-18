// Builds a realistic 5th-semester CSE timetable problem. `sectionCount` scales it up
// for benchmarks (8 = one department, 40 = a large school). All names are made up.

const FIRST = ['Anjali', 'Rohit', 'Neha', 'Vikram', 'Priya', 'Arjun', 'Kavita', 'Sandeep', 'Meera', 'Rahul', 'Pooja', 'Amit', 'Shalini', 'Karan', 'Divya', 'Manish', 'Ritu', 'Gaurav', 'Swati', 'Harpreet', 'Nisha', 'Deepak', 'Simran', 'Ajay'];
const LAST = ['Sharma', 'Verma', 'Gupta', 'Singh', 'Kaur', 'Malhotra', 'Bansal', 'Chawla', 'Arora', 'Kapoor', 'Sethi', 'Bhatia', 'Joshi', 'Saini', 'Grover', 'Dhillon'];

export const CONFIG = {
  days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  periodsPerDay: 8,
  breaks: [4],
  labDuration: 2,
  periodTimes: [
    { start: '09:00', end: '09:50' },
    { start: '09:50', end: '10:40' },
    { start: '10:50', end: '11:40' },
    { start: '11:40', end: '12:30' },
    { start: '12:30', end: '13:20', label: 'Lunch' },
    { start: '13:20', end: '14:10' },
    { start: '14:10', end: '15:00' },
    { start: '15:00', end: '15:50' },
  ],
};

// [id, code, name, type, sessionsPerWeek, sectionsPerTeacher]
const CORE = [
  ['bee2-lab', '24CS0305', 'Back End Engineering-II', 'lab', 4, 2],
  ['aiml', '24CS0301', 'Artificial Intelligence & ML', 'lecture', 3, 3],
  ['aiml-lab', '24CS0301L', 'AI & ML Lab', 'lab', 1, 3],
  ['ps', '24MA0302', 'Probability & Statistics', 'lecture', 3, 4],
  ['cn', '24CS0303', 'Computer Networks', 'lecture', 3, 3],
  ['cn-lab', '24CS0303L', 'Computer Networks Lab', 'lab', 1, 3],
  ['toc', '24CS0304', 'Theory of Computation', 'lecture', 3, 4],
  ['pc', '24HS0306', 'Professional Communication', 'lecture', 2, 8],
];
const ELECTIVES = [
  ['oe-ent', '24OE0101', 'Entrepreneurship'],
  ['oe-psy', '24OE0102', 'Introduction to Psychology'],
  ['oe-dm', '24OE0103', 'Digital Marketing'],
  ['oe-pho', '24OE0104', 'Photography & Visual Storytelling'],
];

export function buildProblem({ sectionCount = 8 } = {}) {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const sections = Array.from({ length: sectionCount }, (_, i) => {
    const label = i < 26 ? letters[i] : `${letters[Math.floor(i / 26) - 1]}${letters[i % 26]}`;
    return {
      id: `sec-${label.toLowerCase()}`,
      name: `CSE 5-${label}`,
      size: 60 + ((i * 7) % 7),
      // Wednesday last period is reserved for sports & clubs.
      unavailable: [{ day: 2, period: 7 }],
    };
  });

  const courses = [
    ...CORE.map(([id, code, name, type, sessionsPerWeek]) => ({ id, code, name, type, sessionsPerWeek })),
    ...ELECTIVES.map(([id, code, name]) => ({ id, code, name, type: 'lecture', sessionsPerWeek: 2 })),
  ];

  let nameIdx = 0;
  const faculty = [];
  const newTeacher = (extra = {}) => {
    const n = nameIdx++;
    const f = {
      id: `fac-${String(n + 1).padStart(3, '0')}`,
      name: `Dr. ${FIRST[n % FIRST.length]} ${LAST[(n * 5 + Math.floor(n / FIRST.length)) % LAST.length]}`,
      maxPerDay: 4,
      maxPerWeek: 18,
      unavailable: [],
      avoid: [],
      canTeach: [],
      ...extra,
    };
    faculty.push(f);
    return f;
  };

  const offerings = [];
  for (const [courseId, , , , , perTeacher] of CORE) {
    let teacher = null;
    sections.forEach((s, i) => {
      if (i % perTeacher === 0) {
        teacher = newTeacher();
        // Related courses this teacher could cover as a substitute.
        teacher.canTeach.push(courseId.replace('-lab', ''), `${courseId.replace('-lab', '')}-lab`);
      }
      offerings.push({ id: `off-${courseId}-${s.id.slice(4)}`, courseId, facultyId: teacher.id, sectionIds: [s.id] });
    });
  }

  // NEP open electives: each basket of up to 4 sections picks one of four options,
  // all running at the same time. One teacher per option covers two baskets.
  const baskets = [];
  const basketSize = 4;
  const basketCount = Math.ceil(sectionCount / basketSize);
  let electiveTeachers = [];
  for (let b = 0; b < basketCount; b++) {
    if (b % 2 === 0) electiveTeachers = ELECTIVES.map(([id]) => newTeacher({ canTeach: [id], maxPerWeek: 12 }));
    const secs = sections.slice(b * basketSize, (b + 1) * basketSize);
    const students = secs.reduce((n, s) => n + s.size, 0);
    baskets.push({
      id: `oe-basket-${b + 1}`,
      name: `Open Elective — Group ${b + 1}`,
      sectionIds: secs.map((s) => s.id),
      sessionsPerWeek: 2,
      options: ELECTIVES.map(([courseId], i) => ({
        offeringId: `off-${courseId}-g${b + 1}`,
        courseId,
        facultyId: electiveTeachers[i].id,
        size: Math.ceil(students / ELECTIVES.length) + 5,
      })),
    });
  }

  // A few realistic personal constraints.
  if (faculty[0]) faculty[0].unavailable.push(...[5, 6, 7].map((period) => ({ day: 2, period })));
  if (faculty[5]) faculty[5].avoid.push(...[0, 1, 2, 3, 4].map((day) => ({ day, period: 0 })));
  if (faculty[9]) faculty[9].unavailable.push(...[0, 1, 2, 3].map((period) => ({ day: 0, period })));

  // Rooms: sized from demand with ~30% headroom.
  const labHours = offerings.reduce((n, o) => {
    const c = courses.find((x) => x.id === o.courseId);
    return n + (c.type === 'lab' ? c.sessionsPerWeek * 2 : 0);
  }, 0);
  const lectureHours = offerings.reduce((n, o) => {
    const c = courses.find((x) => x.id === o.courseId);
    return n + (c.type === 'lab' ? 0 : c.sessionsPerWeek);
  }, 0) + baskets.length * 2 * ELECTIVES.length;
  const labRooms = Math.ceil((labHours / 30) * 1.3);
  // At least one room per parallel elective option, or a basket could never be placed.
  const lectureRooms = Math.max(ELECTIVES.length + 1, Math.ceil((lectureHours / 34) * 1.3));
  const rooms = [
    ...Array.from({ length: labRooms }, (_, i) => ({ id: `lab-${i + 1}`, name: `Computer Lab ${i + 1}`, type: 'lab', capacity: 70 })),
    ...Array.from({ length: lectureRooms }, (_, i) => ({ id: `lr-${i + 1}`, name: `Room ${101 + i}`, type: 'lecture', capacity: i % 5 === 4 ? 130 : 72 })),
  ];

  return { config: CONFIG, rooms, faculty, sections, courses, offerings, baskets };
}
