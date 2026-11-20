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

Then in Slotwise: **Teachers & courses → Import full dataset** (admin only) and pick
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
| Room type | A room is a lab if its name has "Lab" in it. |
| Subjects | The abbreviation from the PDF is used as both code and name (rename them in the app). |
| Same class twice in a day | Kept as allowed for that class only (e.g. two LAC periods on one day). |
| Lunch | The free period each class has in the PDF (P5, or P4 for AIFT 3rd sem) becomes an "unavailable" rule. |
| Co-teaching ("Dr. A / Trainer 2") | Kept as one teaching team. |
| T- Himanshu | Kept as one person. The PDF double-books him; Slotwise will not. |
| Teacher limits | At least 4 periods a day and 18 a week, raised if the PDF already gives them more. |

Building blocks: MB = Martin Luther Block, TG = Turing, NB = Newton, Bloom Block for AIFT 3rd and 5th sem.
