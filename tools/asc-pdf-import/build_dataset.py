"""Turn the parsed class-wise timetable (parsed.json) into a Slotwise dataset.

The dataset describes WHAT has to be taught (who teaches which subject to which
classes, how long each class is and how often), not WHEN. Slotwise then builds its
own timetable from it.

  * Same subject + teacher + room at the same time in several classes -> one combined class.
  * Cells split into Group 1 / Group 2 -> an elective basket (options run in parallel).
  * Each class keeps its own lunch hour as an "unavailable" rule (most classes break at
    1-2 pm, CSE-AIFT 3rd semester at 12-1 pm).
  * Teacher limits are raised where the real timetable already asks more of someone.
"""
import json
import math
import re
import sys
from collections import Counter, defaultdict

SECTION_SIZE = 60
ROOM_CAPACITY = 70
BIG_ROOMS = {'Exploretorium': 400}
LAB_COURSES = {'Design Thinking with iOS', 'iOS App Development Swift-I', 'PA using AI'}  # only ever in the iOS Lab
BUILDINGS = {'MB': 'Martin Luther Block', 'TG': 'Turing Block', 'NB': 'Newton Block', 'Bloom Block': 'Bloom Block'}
DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
TIMES = [('09:00', '10:00'), ('10:00', '11:00'), ('11:00', '12:00'), ('12:00', '13:00'), ('13:00', '14:00'), ('14:00', '15:00'), ('15:00', '16:00')]


def slug(text):
    return re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')


def clean(label):
    return re.sub(r'\s+', ' ', label).strip()


def teacher_key(label):
    """'T- Ashish' and 'T-Ashish' are the same person; ignore spacing and dots."""
    return re.sub(r'[\s.]', '', label).lower()


def section_info(name):
    program, rest = name.split(' ', 1)
    m = re.match(r'(\d+)', rest)
    semester = int(m.group(1)) if m else 1  # 'G1' (no number) is 1st semester
    return program, semester


def main(src='parsed.json', out='chitkara-cse-ai.json'):
    classes = json.load(open(src))
    teacher_name = {}
    rooms = {}
    sections = []
    for c in classes:
        program, semester = section_info(c['name'])
        sections.append({'id': slug(c['name']), 'name': c['name'], 'program': program, 'semester': semester, 'size': SECTION_SIZE})
        for b in c['blocks']:
            teacher_name.setdefault(teacher_key(b['teacher']), clean(b['teacher']))
            rooms.setdefault(clean(b['room']), None)
    sec_id = {c['name']: slug(c['name']) for c in classes}

    # --- 1. Merge identical blocks across classes (combined classes) ---------------
    plain = defaultdict(set)     # (day, start, dur, subject, teacherKey, room) -> section ids
    parallel = defaultdict(set)  # per class & slot: set of options
    for c in classes:
        slot_opts = defaultdict(set)
        for b in c['blocks']:
            tk = teacher_key(b['teacher'])
            if b['parallel']:
                slot_opts[(b['day'], b['start'], b['duration'])].add((clean(b['subject']), tk, clean(b['room'])))
            else:
                plain[(b['day'], b['start'], b['duration'], clean(b['subject']), tk, clean(b['room']))].add(sec_id[c['name']])
        for slot, opts in slot_opts.items():
            parallel[(*slot, frozenset(opts))].add(sec_id[c['name']])

    # --- 2. Offerings: who teaches what to whom, how long and how often ------------
    off_count = Counter()
    off_days = defaultdict(Counter)  # how many times a week-day this class meets in the real timetable
    for (day, start, dur, subj, tk, room), secs in plain.items():
        off_count[(subj, tk, frozenset(secs), dur)] += 1
        off_days[(subj, tk, frozenset(secs), dur)][day] += 1
    offerings = []
    for i, ((subj, tk, secs, dur), n) in enumerate(sorted(off_count.items(), key=lambda x: (x[0][0], sorted(x[0][2]), x[0][1], x[0][3])), 1):
        o = {'id': f'off-{i:03d}', 'courseId': 'crs-' + slug(subj), 'facultyId': 'fac-' + slug(teacher_name[tk]),
             'sectionIds': sorted(secs), 'duration': dur, 'sessionsPerWeek': n}
        busiest = max(off_days[(subj, tk, secs, dur)].values())
        if busiest > math.ceil(n / 5):
            o['maxSessionsPerDay'] = busiest  # e.g. two separate LAC periods on one day
        offerings.append(o)

    # --- 3. Elective baskets (parallel groups) -------------------------------------
    bk_count = Counter()
    for (day, start, dur, opts), secs in parallel.items():
        bk_count[(opts, frozenset(secs), dur)] += 1
    section_name = {s['id']: s['name'] for s in sections}
    baskets = []
    for i, ((opts, secs, dur), n) in enumerate(sorted(bk_count.items(), key=lambda x: sorted(x[0][1])), 1):
        opts = sorted(opts)
        students = SECTION_SIZE * len(secs)
        names = sorted(section_name[s] for s in secs)
        baskets.append({
            'id': f'bkt-{i:02d}',
            'name': f"{' / '.join(o[0] for o in opts)} ({', '.join(names)})",
            'sectionIds': sorted(secs),
            'sessionsPerWeek': n,
            'duration': dur,
            'options': [{'offeringId': f'opt-{i:02d}-{j}', 'courseId': 'crs-' + slug(s), 'facultyId': 'fac-' + slug(teacher_name[tk]),
                         'size': math.ceil(students / len(opts))} for j, (s, tk, _room) in enumerate(opts, 1)],
        })

    # --- 4. Courses ------------------------------------------------------------------
    subjects = sorted({o['courseId'] for o in offerings} | {opt['courseId'] for b in baskets for opt in b['options']})
    subj_name = {}
    for c in classes:
        for b in c['blocks']:
            subj_name['crs-' + slug(clean(b['subject']))] = clean(b['subject'])
    usual = defaultdict(Counter)
    for o in offerings:
        usual[o['courseId']][o['sessionsPerWeek']] += 1
    # Stream of a subject/teacher = the streams (CSE-AIML, CSE-AIFT) of the classes it is taught to.
    sec_stream = {sec['id']: sec['program'] for sec in sections}
    streams_of = defaultdict(set)
    for o in offerings:
        for sid in o['sectionIds']:
            streams_of[o['courseId']].add(sec_stream[sid])
            streams_of[o['facultyId']].add(sec_stream[sid])
    for b in baskets:
        for opt in b['options']:
            for sid in b['sectionIds']:
                streams_of[opt['courseId']].add(sec_stream[sid])
                streams_of[opt['facultyId']].add(sec_stream[sid])
    stream_label = lambda key: ', '.join(sorted(streams_of[key])) or 'CSE-AI'
    courses = [{'id': cid, 'code': subj_name[cid], 'name': subj_name[cid], 'type': 'lab' if subj_name[cid] in LAB_COURSES else 'lecture',
                'sessionsPerWeek': max(1, min(10, (usual[cid].most_common(1) or [(2, 0)])[0][0])), 'department': stream_label(cid)} for cid in subjects]

    # --- 5. Rooms ------------------------------------------------------------------
    def building(name):
        for prefix, full in BUILDINGS.items():
            if name.startswith(prefix):
                return full
        return None
    room_list = [{'id': 'room-' + slug(r), 'name': r, 'type': 'lab' if 'Lab' in r else 'lecture',
                  'capacity': BIG_ROOMS.get(r, ROOM_CAPACITY), 'building': building(r)} for r in sorted(rooms)]

    # --- 6. Teacher limits (never below what the real timetable already needs) -------
    week = Counter()
    per_day = Counter()
    for (day, start, dur, subj, tk, room) in plain:
        week[tk] += dur
        per_day[(tk, day)] += dur
    for (day, start, dur, opts) in parallel:
        for (_s, tk, _r) in opts:
            week[tk] += dur
            per_day[(tk, day)] += dur
    can_teach = defaultdict(set)
    for o in offerings:
        can_teach[o['facultyId']].add(o['courseId'])
    for b in baskets:
        for opt in b['options']:
            can_teach[opt['facultyId']].add(opt['courseId'])
    faculty = []
    for tk, name in sorted(teacher_name.items(), key=lambda x: x[1].lower()):
        fid = 'fac-' + slug(name)
        max_day = max([per_day[(tk, d)] for d in range(5)] + [0])
        faculty.append({'id': fid, 'name': name, 'maxPerDay': min(12, max(4, max_day)), 'maxPerWeek': min(60, max(18, week[tk])),
                        'canTeach': sorted(can_teach[fid]), 'department': stream_label(fid)})
    assert len({f['id'] for f in faculty}) == len(faculty), 'teacher id collision'

    # --- 7. Lunch: the middle period each class never uses ----------------------------
    constraints = []
    for c in classes:
        used = {(b['day'], p) for b in c['blocks'] for p in range(b['start'], b['start'] + b['duration'])}
        for p in (4, 3):  # 1-2 pm, else 12-1 pm
            if not any((d, p) in used for d in range(5)):
                for d in range(5):
                    constraints.append({'subjectType': 'section', 'subjectId': sec_id[c['name']], 'kind': 'unavailable',
                                        'day': d, 'periodFrom': p, 'periodTo': p, 'note': 'Lunch'})
                break

    dataset = {
        'format': 'slotwise-dataset/1',
        'name': 'Chitkara University - CSE-AI department (odd semester 2026)',
        'source': 'Class-wise timetable PDF generated 14-11-2026 (32 classes)',
        'settings': {'institution': 'Chitkara University - CSE-AI', 'days': DAYS, 'periodsPerDay': 7, 'breaks': [], 'labDuration': 2,
                     'periodTimes': [{'start': a, 'end': b} for a, b in TIMES], 'termWeeks': 16},
        'rooms': room_list, 'faculty': faculty, 'sections': sections, 'courses': courses,
        'offerings': offerings, 'baskets': baskets, 'constraints': constraints,
    }
    json.dump(dataset, open(out, 'w'), indent=1, ensure_ascii=False)
    real_periods = sum(b['duration'] for c in classes for b in c['blocks'])
    print(f"{len(sections)} sections, {len(faculty)} teachers, {len(room_list)} rooms, {len(courses)} courses, "
          f"{len(offerings)} offerings, {len(baskets)} baskets, {len(constraints)} lunch rules; {real_periods} class-periods in the PDF")


if __name__ == '__main__':
    main(*sys.argv[1:])
