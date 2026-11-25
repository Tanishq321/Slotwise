# Import a college timetable PDF

These two scripts turn a class-wise timetable PDF exported from aSc Timetables
(one class per page) into a Slotwise dataset file that the app can import in one go.

They take the *data* out of the PDF (classes, teachers, rooms, subjects, how many
periods each subject gets) so Slotwise can build its own clash-free timetable from it.
The official slot positions are not copied.

```bash
pip install pdfplumber
python parse.py Class_Wise_Time_Table.pdf -o parsed.json --pages 1-22,24-33
python build_dataset.py parsed.json chitkara-cse-ai.json
```

Copy the result to `server/data/chitkara-cse-ai.json`. On the next deploy Slotwise clears the
old timetables, loads the data and publishes the official timetable (see `LOAD_DATASET` below).

Or by hand in Slotwise: **Teachers & courses → Import full dataset** (admin only) and pick
the `.json` file. Everything on the data tabs is replaced in one step; logins and
saved timetable versions are kept. Use **Download all data** first if you want a backup.

## How the PDF is read

* The grid comes from the drawn lines: header verticals give the 7 period columns,
  long horizontals give the 5 day rows.
* A class that spans two periods has no vertical line between them.
* "Group 1 / Group 2" splits are thin horizontal lines inside a block. These become
  **elective baskets** (both groups meet at the same time with different teachers).
* In each block the big text is the subject; the small bottom line is the room on the
  left and the teacher on the right.

## Choices made for the Chitkara CSE-AI file (16-11-2026)

| Item | What the script does |
|---|---|
| Pages | 1–22 and 24–33. CSE-AI 7A, Psychology and DEAKIN are left out for now. |
| Class size | 60 students per section (estimate). |
| Room size | 70 per room, 400 for the Exploretorium (estimate). |
| Room type | Every room is a lecture hall, including the iOS Lab, because the university also teaches lectures (BPC, DNN) there. |
| Room size | Never smaller than the biggest class the PDF puts in it (MB LH-304 holds the combined NALR class of 120). |
| Subjects | The abbreviation from the PDF is used as both code and name (rename them in the app). |
| Same class twice in a day | Kept as allowed for that class only (e.g. two LAC periods on one day). |
| Lunch | The free period each class has in the PDF (P5, or P4 for AIFT 3rd sem) becomes an "unavailable" rule. |
| Co-teaching ("Dr. A / Trainer 2") | Kept as one teaching team. |
| T- Himanshu | Split into "T- Himanshu (Java)" and "T- Himanshu (PA)": the PDF has a Himanshu in two rooms at the same hour every day, so they are two trainers. |
| Official timetable | Saved slot by slot in the dataset (`official`). It passes Slotwise's clash checker with zero clashes. |
| Teacher limits | At least 4 periods a day and 18 a week, raised if the PDF already gives them more. |

Building blocks: MB = Martin Luther Block, TG = Turing, NB = Newton, Bloom Block for AIFT 3rd and 5th sem.

## Loading on deploy (`LOAD_DATASET`)

In production the server starts with `LOAD_DATASET=chitkara-cse-ai` (set in `render.yaml`,
and the default when `NODE_ENV=production`). On the first start after the file changes it:

1. deletes every timetable version and the audit log from MongoDB,
2. replaces all teachers, rooms, classes, subjects and rules in PostgreSQL (logins are kept),
3. saves the official timetable and publishes it, so students see it at once.

The file's hash is stored in the `app_state` table, so later restarts do nothing. Set
`LOAD_DATASET=none` to turn this off.
