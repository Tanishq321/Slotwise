"""Parse the aSc class-wise timetable PDF into structured blocks.

Each page is one class. The grid has 7 period columns and 5 day rows. Merged cells
are detected from missing vertical separators; split cells (Group 1 / Group 2) from
thin horizontal lines inside a block. Inside a block, large text is the subject and
the small text on the bottom line is room (left) and teacher (right).
"""
import json
import re
import sys

import pdfplumber

DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
# Pages used for the Chitkara CSE-AI file of 14-11-2026. Pages 23 (CSE-AI 7A),
# 34 (Psychology) and 35+ (DEAKIN) are left out for now. Override with --pages.
DEFAULT_PAGES = '1-22,24-33'


def page_set(spec):
    out = set()
    for part in spec.split(','):
        a, _, b = part.partition('-')
        out.update(range(int(a), int(b or a) + 1))
    return out


def near(a, b, tol=1.2):
    return abs(a - b) <= tol


def text_items(chars):
    """Group chars (in drawing order) into runs; a run breaks when the text jumps
    backwards (overlapping labels), changes line or size, or has a large gap."""
    items, cur = [], None
    for c in chars:
        if c['text'].strip() == '' and cur is None:
            continue
        brk = cur is None or abs(c['size'] - cur['size']) > 0.5 or abs(c['top'] - cur['top']) > 2 \
            or c['x0'] < cur['x1'] - 1.0 or c['x0'] - cur['x1'] > 6
        if brk:
            if cur:
                items.append(cur)
            cur = {'text': c['text'], 'x0': c['x0'], 'x1': c['x1'], 'top': c['top'], 'size': c['size']}
        else:
            if c['x0'] - cur['x1'] > 1.2 and not cur['text'].endswith(' '):
                cur['text'] += ' '
            cur['text'] += c['text']
            cur['x1'] = c['x1']
    if cur:
        items.append(cur)
    for it in items:
        it['text'] = re.sub(r'\s+', ' ', it['text']).strip()
    return [it for it in items if it['text']]


def parse_block(chars, box):
    x0, y0, x1, y1 = box
    inside = [c for c in chars if x0 - 0.5 <= (c['x0'] + c['x1']) / 2 <= x1 + 0.5 and y0 - 0.5 <= (c['top'] + c['bottom']) / 2 <= y1 + 0.5]
    if not inside:
        return None
    items = text_items(inside)
    big = sorted([i for i in items if i['size'] >= 11], key=lambda i: (round(i['top']), i['x0']))
    small = [i for i in items if i['size'] < 11]
    group = None
    rest = []
    for s in small:
        m = re.fullmatch(r'Group\s*(\d+)', s['text'])
        if m:
            group = int(m.group(1))
        else:
            rest.append(s)
    subject = ' '.join(i['text'] for i in big).strip()
    room = teacher = ''
    if rest:
        bottom = max(r['top'] for r in rest)
        line = sorted([r for r in rest if abs(r['top'] - bottom) < 3], key=lambda r: r['x0'])
        mid = (x0 + x1) / 2
        if len(line) == 1:
            if (line[0]['x0'] + line[0]['x1']) / 2 < mid:
                room = line[0]['text']
            else:
                teacher = line[0]['text']
        else:
            room = line[0]['text']
            teacher = ' '.join(r['text'] for r in line[1:])
    if not subject and not room and not teacher:
        return None
    return {'subject': subject, 'room': room, 'teacher': teacher, 'group': group}


def parse_page(pg):
    words = pg.extract_words(extra_attrs=['size'])
    title = ' '.join(w['text'] for w in words if w['size'] > 25 and w['top'] < 40)
    V = [l for l in pg.lines if abs(l['x0'] - l['x1']) < 0.5]
    H = [l for l in pg.lines if abs(l['top'] - l['bottom']) < 0.5]
    # Column edges: the header separators plus the left/right grid borders.
    hdr_bottom = min(l['top'] for l in H if l['x1'] - l['x0'] > 600 and l['top'] > 80)
    xs = sorted({round(l['x0'], 1) for l in V if l['top'] < hdr_bottom - 5 and l['bottom'] > hdr_bottom - 5})
    xs = [x for x in xs if x > 50]  # drop the outer left border; first edge is the day-label column
    # Row edges: horizontal lines that start at the far-left border.
    ys = sorted({round(l['top'], 1) for l in H if l['x0'] < 20 and l['top'] >= hdr_bottom - 1})
    assert len(xs) == 8 and len(ys) == 6, (title, xs, ys)
    col_mid = [(xs[i] + xs[i + 1]) / 2 for i in range(7)]
    out = []
    for d in range(5):
        y0, y1 = ys[d], ys[d + 1]
        seps = {xs[0], xs[-1]}
        for l in V:
            if l['top'] <= y0 + 1.5 and l['bottom'] >= y1 - 1.5 and xs[0] - 1 < l['x0'] < xs[-1] + 1:
                seps.add(round(l['x0'], 1))
        seps = sorted(seps)
        for a, b in zip(seps, seps[1:]):
            periods = [i for i, m in enumerate(col_mid) if a < m < b]
            if not periods:
                continue
            # Thin horizontal splits inside this block (sub-groups running in parallel).
            cuts = sorted({round(l['top'], 1) for l in H if y0 + 2 < l['top'] < y1 - 2 and l['x0'] <= a + 1.5 and l['x1'] >= b - 1.5})
            bands = list(zip([y0] + cuts, cuts + [y1]))
            for by0, by1 in bands:
                blk = parse_block(pg.chars, (a, by0, b, by1))
                if blk:
                    blk.update({'day': d, 'start': periods[0], 'duration': len(periods), 'parallel': len(bands) > 1})
                    out.append(blk)
    times = [w['text'] for w in words if 5.5 < w['size'] < 7]
    return title, out, words


if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser(description='Read an aSc class-wise timetable PDF into parsed.json')
    ap.add_argument('pdf')
    ap.add_argument('-o', '--out', default='parsed.json')
    ap.add_argument('--pages', default=DEFAULT_PAGES, help='e.g. 1-22,24-33')
    args = ap.parse_args()
    wanted = page_set(args.pages)
    pdf = pdfplumber.open(args.pdf)
    classes = []
    for i, pg in enumerate(pdf.pages, 1):
        if i not in wanted:
            continue
        title, blocks, _ = parse_page(pg)
        classes.append({'page': i, 'name': title, 'blocks': blocks})
    json.dump(classes, open(args.out, 'w'), indent=1)
    print(f'{len(classes)} classes, {sum(len(c["blocks"]) for c in classes)} blocks')
