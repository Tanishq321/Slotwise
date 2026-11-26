# Import a college timetable PDF

These two Node.js scripts turn timetable PDFs exported from aSc Timetables (one class per
page) into a Slotwise dataset file that the app can import in one go. Several PDFs can be
combined into one dataset, for example the CSE-AI class-wise PDF and the CSE group-wise PDF.

They take the data out of the PDF (classes, teachers, rooms, subjects, how many
periods each subject gets) so Slotwise can build its own clash-free timetable, and they
also keep the official timetable slot by slot so it can be published as it is.

```bash
cd tools/asc-pdf-import
npm install                       # installs pdf.js, the PDF reader (JavaScript)
node parse.mjs Class_Wise_Time_Table.pdf -o parsed-cse-ai.json --pages 1-22,24-33
node parse.mjs Group_Wise_Time_Table.pdf -o parsed-cse.json --pages 1-18
node build-dataset.mjs ../../server/data/chitkara-cse-ai.json parsed-cse-ai.json parsed-cse.json
```

When two PDFs have the same class, the PDF named later wins. The group-wise PDF has newer
timetables for the AIML iOS and UCA groups ("CSE G14 (iOS- AIML)", "CSE G13 (UCA - AIML)"),
so those replace CSE-AIML 5-iOS and 5-UCA from the class-wise PDF. Keeping both would
put the same teachers and rooms in two places at once.

A teacher is the person named in the label: "L&T ADI T1 / Shaffu" is Shaffu, and
"Dr. Pummy Dhiman" in one PDF is the same teacher as "NALR T2 / Pummy Dhiman" in the other.
The dataset also marks CSE 5 G15 as the class shown first on screen (Settings can change it).

Both scripts are plain Node.js (ES modules), like the rest of Slotwise. This folder is
not part of the app's workspaces, so Render never installs pdf.js.

The last command writes straight to `server/data/chitkara-cse-ai.json`. On the next deploy Slotwise clears the
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
| Subjects | The abbreviation from the PDF is used as both code and name (rename them in the app). A name longer than 30 characters gets its initials as the code ("Introduction to Web Game Development" → IWGD). |
| Same class twice in a day | Kept as allowed for that class only (e.g. two LAC periods on one day). |
| Lunch | The free period each class has in the PDF (P5, or P4 for AIFT 3rd sem) becomes an "unavailable" rule. |
| Co-teaching ("Dr. A / Trainer 2") | The named person is the teacher; the trainer role is dropped, so one person is never booked twice under two labels. |
| T- Himanshu | Split into "T- Himanshu (Java)" and "T- Himanshu (PA)": the PDF has a Himanshu in two rooms at the same hour every day, so they are two trainers. |
| Official timetable | Saved slot by slot in the dataset (`official`). It passes Slotwise's clash checker with zero clashes. |
| Teacher limits | At least 4 periods a day and 18 a week, raised if the PDF already gives them more. |

Building blocks: MB = Martin Luther Block, TG = Turing, NB = Newton, Bloom Block for AIFT 3rd and 5th sem.

## Choices made for the CSE group-wise file (16-11-2026)

| Item | What the script does |
|---|---|
| Pages | 1–18: CSE 5 G1 to G16, then the AIML iOS and UCA groups. |
| Class names | G11 and G12 become "(Cyber Security)", G13 "(UCA)", G14 "(iOS)", G16 "(Game Development)". |
| AIML iOS / UCA | Pages 17–18 replace CSE-AIML 5-iOS and 5-UCA from the class-wise file (newer timetable; keeping both gave 53 clashes). |
| Rooms | TG-xxx is Turing Block room xxx; "iOS Lab- Transform" is the iOS Lab; the Edison Basement is in Edison Block. |
| Class shown first | CSE 5 G15 (`settings.defaultSectionId`). The demo student login is put in this class. |

Both files together: 48 classes, 94 teachers, 49 rooms, 39 subjects. The combined official
timetable passes the clash checker with zero clashes, and Slotwise generates its own
timetable for all 48 classes in about 5 seconds.

## Loading on deploy (`LOAD_DATASET`)

In production the server starts with `LOAD_DATASET=chitkara-cse-ai` (set in `render.yaml`,
and the default when `NODE_ENV=production`). On the first start after the file changes it:

1. deletes every timetable version and the audit log from MongoDB,
2. replaces all teachers, rooms, classes, subjects and rules in PostgreSQL (logins are kept),
3. saves the official timetable and publishes it, so students see it at once.

The file's hash is stored in the `app_state` table, so later restarts do nothing. Set
`LOAD_DATASET=none` to turn this off.
