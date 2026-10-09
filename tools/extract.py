#!/usr/bin/env python3
"""Extract quiz.json and optimised assets from the Bollywood quiz .pptx.

Usage:  python3 tools/extract.py path/to/deck.pptx [out_dir]

Needs Pillow and ffmpeg. This is a one-off authoring tool; the site itself
has no build step. The deck's slide-jump links (hlinksldjump) are followed
rather than assuming slide adjacency, then cross-checked against each slide's
title so a clue can never be paired with the wrong answer.
"""
import json, os, re, subprocess, sys, zipfile
import xml.etree.ElementTree as ET
from PIL import Image

NS = {
    'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
    'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
}
R = '{%s}' % NS['r']
A = '{%s}' % NS['a']
P = '{%s}' % NS['p']
EMU_PT = 12700
MAX_W = 1600
WEBP_Q = 80

pptx = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else '.'
assets = os.path.join(out, 'assets')
os.makedirs(assets, exist_ok=True)
os.makedirs(os.path.join(out, 'docs'), exist_ok=True)
z = zipfile.ZipFile(pptx)


def xml(path):
    return ET.fromstring(z.read(path))


def rels(path):
    if path not in z.namelist():
        return {}
    return {r.get('Id'): (r.get('Type').split('/')[-1], r.get('Target')) for r in xml(path)}


# ---------------------------------------------------------------- slide order
pres_rels = rels('ppt/_rels/presentation.xml.rels')
order = [os.path.basename(pres_rels[s.get(R + 'id')][1])
         for s in xml('ppt/presentation.xml').iter(P + 'sldId')]
file2n = {f: i for i, f in enumerate(order, 1)}
assert len(order) == 160, len(order)


def para_text(sp):
    paras = []
    for p in sp.findall('./p:txBody/a:p', NS):
        s = ''
        for c in p:
            if c.tag == A + 'r' or c.tag == A + 'fld':
                s += ''.join(t.text or '' for t in c.findall('a:t', NS))
            elif c.tag == A + 'br':
                s += '\n'
        paras.append(s)
    return '\n'.join(paras)


def walk(node, tf, acc):
    """Collect sp/pic with absolute coords (pt), applying group transforms."""
    for ch in node:
        if ch.tag == P + 'grpSp':
            x = ch.find('./p:grpSpPr/a:xfrm', NS)
            off, ext = x.find('a:off', NS), x.find('a:ext', NS)
            co, ce = x.find('a:chOff', NS), x.find('a:chExt', NS)
            sx = int(ext.get('cx')) / int(ce.get('cx'))
            sy = int(ext.get('cy')) / int(ce.get('cy'))
            ox, oy = int(off.get('x')), int(off.get('y'))
            cx0, cy0 = int(co.get('x')), int(co.get('y'))
            pt = tf
            ntf = (lambda px, py, w, h, pt=pt, ox=ox, oy=oy, cx0=cx0, cy0=cy0, sx=sx, sy=sy:
                   pt(ox + (px - cx0) * sx, oy + (py - cy0) * sy, w * sx, h * sy))
            walk(ch, ntf, acc)
        elif ch.tag in (P + 'sp', P + 'pic'):
            acc.append((ch, tf))


def load_slide(n):
    fn = order[n - 1]
    root = xml('ppt/slides/' + fn)
    rl = rels('ppt/slides/_rels/%s.rels' % fn)
    acc = []
    walk(root.find('./p:cSld/p:spTree', NS), lambda x, y, w, h: (x, y, w, h), acc)
    shapes = []
    for el, tf in acc:
        nv = el.find('.//p:cNvPr', NS)
        xf = el.find('.//a:xfrm', NS)
        box = None
        if xf is not None and xf.find('a:off', NS) is not None:
            o, e = xf.find('a:off', NS), xf.find('a:ext', NS)
            x, y, w, h = tf(int(o.get('x')), int(o.get('y')), int(e.get('cx')), int(e.get('cy')))
            box = [x / EMU_PT, y / EMU_PT, w / EMU_PT, h / EMU_PT]
        d = {'name': nv.get('name'), 'box': box, 'alt': nv.get('descr'), 'links': []}
        for h in el.iter(A + 'hlinkClick'):
            rid = h.get(R + 'id')
            if rid and h.get('action', '').endswith('hlinksldjump'):
                d['links'].append(file2n[os.path.basename(rl[rid][1])])
        if el.tag == P + 'sp':
            d['kind'] = 'sp'
            t = para_text(el)
            d['text'] = t if t.strip() else None
            f = el.find('./p:spPr/a:solidFill/a:srgbClr', NS)
            d['fill'] = f.get('val') if f is not None else None
        else:
            d['kind'] = 'pic'
            d['media'] = os.path.basename(rl[el.find('.//a:blip', NS).get(R + 'embed')][1])
            sr = el.find('.//a:srcRect', NS)
            d['crop'] = {k: int(v) for k, v in sr.attrib.items()} if sr is not None and sr.attrib else None
        shapes.append(d)
    return shapes


SL = {n: load_slide(n) for n in range(1, 161)}
used_slides = set()


def title(n):
    used_slides.add(n)
    s = [d for d in SL[n] if d['name'] == 'TextBox 9']
    return s[0]['text'] if s else None


def by_name(n, name):
    r = [d for d in SL[n] if d['name'] == name and d.get('text')]
    return r[0]['text'] if r else None


def button(n, label):
    for d in SL[n]:
        if d['links'] and d.get('text') and d['text'].strip().upper() == label:
            return d['links'][0]
    return None


def tiles(n):
    return [d for d in SL[n] if d['links'] and d.get('text') and d['name'].startswith('Rectangle')
            and d['text'].strip().upper() not in ('MENU', 'END')]


# ---------------------------------------------------------------- images
image_defs = {}      # (media, crop tuple) -> filename
image_meta = {}      # filename -> dict
image_usage = {}     # filename -> list of usage strings
VIDEO = {'image9.gif'}


def convert(media, crop):
    if crop and max(crop.values()) < 500:   # <0.5% is a rounding artefact, not a real crop
        crop = None
    key = (media, tuple(sorted(crop.items())) if crop else None)
    if key in image_defs:
        return image_defs[key]
    stem = os.path.splitext(media)[0]
    if crop:
        k = 1 + sum(1 for kk in image_defs if kk[0] == media and kk[1])
        stem = '%s-c%d' % (stem, k)
    src = z.open('ppt/media/' + media)
    if media in VIDEO:
        tmp = os.path.join(out, '_tmp_' + media)
        open(tmp, 'wb').write(src.read())
        im = Image.open(tmp)
        w, h = im.size
        webm, mp4 = stem + '.webm', stem + '.mp4'
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', tmp, '-an', '-c:v', 'libvpx-vp9',
                        '-b:v', '0', '-crf', '36', '-pix_fmt', 'yuv420p', os.path.join(assets, webm)], check=True)
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', tmp, '-an', '-c:v', 'libx264',
                        '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
                        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', os.path.join(assets, mp4)], check=True)
        im.seek(0)
        poster = stem + '-poster.webp'
        im.convert('RGB').save(os.path.join(assets, poster), 'WEBP', quality=WEBP_Q)
        os.remove(tmp)
        meta = {'video': {'webm': 'assets/' + webm, 'mp4': 'assets/' + mp4, 'poster': 'assets/' + poster},
                'w': w, 'h': h}
        fname = webm
    else:
        im = Image.open(src)
        im.load()
        if crop:
            W, H = im.size
            l, t = W * crop.get('l', 0) / 100000, H * crop.get('t', 0) / 100000
            r, b = W * (1 - crop.get('r', 0) / 100000), H * (1 - crop.get('b', 0) / 100000)
            im = im.crop((round(l), round(t), round(r), round(b)))
        if max(im.size) > MAX_W:  # cap the longest side, so width is always <= 1600 too
            k = MAX_W / max(im.size)
            im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
        has_alpha = im.mode in ('RGBA', 'LA', 'P') and ('transparency' in im.info or im.mode in ('RGBA', 'LA'))
        if has_alpha and im.mode == 'RGBA' and im.getchannel('A').getextrema()[0] == 255:
            has_alpha = False  # fully opaque: drop the alpha channel
        im = im.convert('RGBA' if has_alpha else 'RGB')
        fname = stem + '.webp'
        dest = os.path.join(assets, fname)
        im.save(dest, 'WEBP', quality=WEBP_Q, method=6)
        if os.path.getsize(dest) > 250_000:  # big photos: trade a little quality for size
            im.save(dest, 'WEBP', quality=62, method=6)
        meta = {'src': 'assets/' + fname, 'w': im.width, 'h': im.height}
    image_defs[key] = fname
    image_meta[fname] = meta
    return fname


def images_for(n, usage):
    pics = sorted([d for d in SL[n] if d['kind'] == 'pic'], key=lambda d: (round(d['box'][0]), d['box'][1]))
    res = []
    for d in pics:
        f = convert(d['media'], d['crop'])
        entry = dict(image_meta[f])
        entry['file'] = f
        if d['alt']:
            entry['source'] = d['alt']
        entry['deckMedia'] = d['media'] + (' (cropped)' if d['crop'] else '')
        image_usage.setdefault(f, []).append(usage)
        res.append((entry, d))
    return res


def overlays_for(n, pics):
    """Short text shapes (e.g. the 1-6 badges on the family tree) sitting on a picture."""
    out_ = []
    for entry, pd in pics:
        px, py, pw, ph = pd['box']
        for d in SL[n]:
            if d['kind'] == 'sp' and d.get('text') and not d['links'] and len(d['text'].strip()) <= 3 \
                    and d['name'].startswith('Rectangle'):
                x, y, w, h = d['box']
                cx, cy = x + w / 2, y + h / 2
                if px <= cx <= px + pw and py <= cy <= py + ph:
                    out_.append({'text': d['text'].strip(), 'x': round((x - px) / pw * 100, 2),
                                 'y': round((y - py) / ph * 100, 2), 'w': round(w / pw * 100, 2),
                                 'h': round(h / ph * 100, 2)})
    return out_


PLACEHOLDER = re.compile(r'\s*GOES HERE$', re.I)
fixes = []


def clean_label(n, text):
    if text and PLACEHOLDER.search(text):
        new = PLACEHOLDER.sub('', text).strip()
        fixes.append('slide %d: placeholder label %r -> %r' % (n, text, new))
        return new
    return text


def clue_and_answer(clue_n, answer_n, ctx, points, content_name=None):
    """Build the common clue dict from a clue slide + answer slide."""
    ct, at = title(clue_n), title(answer_n)
    assert at == ct + ' - Answer', (clue_n, answer_n, ct, at)
    assert button(answer_n, 'BACK TO BOARD'), answer_n
    label = clean_label(clue_n, by_name(clue_n, 'TextBox 12'))
    prompt = by_name(clue_n, 'TextBox 13')
    a_label = by_name(answer_n, 'TextBox 12')
    a_text = by_name(answer_n, 'TextBox 13')
    if a_label and a_label.upper().startswith('CORRECT ANSWER:'):
        a_text = a_label.split(':', 1)[1].strip()
    cimgs = images_for(clue_n, ctx + ' / clue (slide %d)' % clue_n)
    aimgs = images_for(answer_n, ctx + ' / answer (slide %d)' % answer_n)
    c = {
        'points': points,
        'label': label,
        'prompt': prompt,
        'answer': a_text,
        'clueImages': [e for e, _ in cimgs],
        'answerImages': [e for e, _ in aimgs],
        'slides': {'clue': clue_n, 'answer': answer_n},
    }
    ov = overlays_for(clue_n, cimgs)
    if ov:
        c['overlays'] = ov
    return c


def pts(text):
    return int(re.search(r'(\d+)\s*(?:points|pts)', text).group(1))


# ---------------------------------------------------------------- rounds
menu = {t['links'][0]: t['text'] for t in tiles(3)}
menu_by_round = {}
for target, text in menu.items():
    m = re.match(r'ROUND (\d)\n(.*)', text)
    menu_by_round[int(m.group(1))] = (target, m.group(2))
title(3)


def round_intro(n):
    t = title(n)
    rules_parts = [d['text'] for d in SL[n] if d['name'] in ('TextBox 12', 'TextBox 13') and d.get('text')]
    sub = by_name(n, 'TextBox 11')
    return {'introTitle': sub, 'rules': '\n\n'.join(rules_parts) if rules_parts else None}, t


rounds = []

# ---- Round 1
target, rname = menu_by_round[1]
intro, _ = round_intro(target)
board = button(target, 'START ROUND')
title(board)
tl = tiles(board)
cols = sorted({round(d['box'][0]) for d in tl})
assert len(cols) == 5
r1 = {'id': 1, 'name': rname, 'type': 'board', **intro, 'categories': []}
for ci, cx in enumerate(cols):
    col_tiles = sorted([d for d in tl if round(d['box'][0]) == cx], key=lambda d: d['box'][1])
    head = sorted([d for d in SL[board] if d['kind'] == 'sp' and d.get('text') and not d['links']
                   and cx - 3 <= d['box'][0] <= cx + 10 and 120 <= d['box'][1] < 182 and d['name'].startswith('TextBox')],
                  key=lambda d: d['box'][1])
    fill = [d['fill'] for d in SL[board] if d['name'].startswith('Rectangle') and not d['links']
            and abs(d['box'][0] - cx) < 3 and 120 < d['box'][1] < 130 and d['fill']]
    cat = {'name': head[0]['text'], 'tagline': head[1]['text'] if len(head) > 1 else None,
           'color': '#' + fill[0] if fill else None, 'clues': []}
    assert len(col_tiles) == 6
    for ti, t in enumerate(col_tiles):
        cn = t['links'][0]
        an = button(cn, 'REVEAL ANSWER')
        assert button(cn, 'BACK TO BOARD') == board
        p = int(t['text'].strip())
        assert pts(title(cn)) == p, (cn, p)
        assert title(cn).startswith(cat['name'].replace('\n', ' ')), (cn, cat['name'])
        c = clue_and_answer(cn, an, 'R1 %s %d' % (cat['name'].replace('\n', ' '), p), p)
        c['id'] = 'r1-%d-%d' % (ci, p)
        cat['clues'].append(c)
    r1['categories'].append(cat)
rounds.append(r1)

# ---- Round 2 (emoji) and 3 (verses) and 5 (quiz): numbered tile boards
def numbered_round(rno, kind):
    target, rname = menu_by_round[rno]
    intro, _ = round_intro(target)
    board = button(target, 'START ROUND')
    title(board)
    r = {'id': rno, 'name': rname, 'type': 'tiles', 'kind': kind, **intro, 'boardPrompt': by_name(board, 'TextBox 11'),
         'clues': []}
    ts = sorted(tiles(board), key=lambda d: (round(d['box'][1]), d['box'][0]))
    for i, t in enumerate(ts, 1):
        m = re.match(r'(\w+) (\d+)\n(\d+) pts', t['text'])
        assert int(m.group(2)) == i, t['text']
        cn = t['links'][0]
        an = button(cn, 'REVEAL ANSWER')
        assert button(cn, 'BACK TO BOARD') == board
        p = int(m.group(3))
        assert pts(title(cn)) == p
        ctx = 'R%d #%d' % (rno, i)
        if kind == 'emoji':
            at, ct = title(an), title(cn)
            assert at == ct + ' - Answer'
            emoji = [d for d in SL[cn] if d['name'].startswith('Rectangle') and d.get('text') and not d['links']]
            assert len(emoji) == 1
            c = {'points': p, 'label': None, 'prompt': emoji[0]['text'], 'answer': by_name(an, 'TextBox 13'),
                 'clueImages': [], 'answerImages': [], 'slides': {'clue': cn, 'answer': an}}
            assert not any(d['kind'] == 'pic' for d in SL[cn] + SL[an])
        elif kind == 'verse':
            c = clue_and_answer(cn, an, ctx, p)
            verse = [d for d in SL[cn] if d['name'].startswith('Rectangle') and d.get('text') and not d['links']]
            assert len(verse) == 1
            c['prompt'] = verse[0]['text']
            c['label'] = c['label'] or 'SECOND VERSE'
        else:
            c = clue_and_answer(cn, an, ctx, p)
        c['id'] = 'r%d-%d' % (rno, i)
        c['number'] = i
        r['clues'].append(c)
    return r


rounds.append(numbered_round(2, 'emoji'))
rounds.append(numbered_round(3, 'verse'))

# ---- Round 4 (timer)
target, rname = menu_by_round[4]
intro, _ = round_intro(target)
tstart = button(target, 'START 30 SEC TIMER')
countdown = [n for n in range(111, 141)]
vals = [int(by_name(n, 'TextBox 11')) for n in countdown]
assert vals == list(range(30, 0, -1)), vals
for n in countdown:
    title(n)
final = 141
title(final)
rounds.append({'id': 4, 'name': rname, 'type': 'timer', **intro, 'seconds': 30,
               'unitLabel': by_name(111, 'TextBox 12'), 'endText': by_name(final, 'TextBox 11'),
               'slides': {'start': tstart, 'countdown': [111, 140], 'end': final}})

# ---- Round 5
rounds.append(numbered_round(5, 'quiz'))

# ---- Front matter / end
title(1); title(2); title(160)
host_pics = images_for(2, 'Host notes')
host = {'kicker': by_name(2, 'TextBox 8'), 'title': by_name(2, 'TextBox 9'), 'text': by_name(2, 'TextBox 11'),
        'images': [e for e, _ in host_pics]}
title_img = images_for(1, 'Title screen')[0][0]
quiz = {
    'title': by_name(1, 'TextBox 9'),
    'startLabel': [d['text'] for d in SL[1] if d['links']][0],
    'titleImage': title_img,
    'hostNotes': host,
    'passPoints': 10,
    'rounds': rounds,
    'end': {'kicker': by_name(160, 'TextBox 8'), 'title': by_name(160, 'TextBox 9'), 'text': by_name(160, 'TextBox 11')},
}

# coverage: every slide must be accounted for, so nothing in the deck is silently dropped
for r in rounds:
    for c in ([c for cat in r.get('categories', []) for c in cat['clues']] + r.get('clues', [])):
        used_slides.update(c['slides'].values())
for n in (4, 66, 92, 110, 142):
    used_slides.add(n)
for n in (5, 67, 93, 143):
    used_slides.add(n)
used_slides.add(3)
missing = sorted(set(range(1, 161)) - used_slides)
assert not missing, missing

json.dump(quiz, open(os.path.join(out, 'quiz.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

# ---------------------------------------------------------------- image sources report
SRC = re.compile(r'IMDb|Wikipedia|Prime Video|Britannica|Amazon\.com|Facebook|\br/|Peakpx|Spotify|Times of India|'
                 r'Filmfare|Koimoi|HuffPost|Vogue|Twitter|Indian Express|Foundation|MemsaabStory|Fan Club|'
                 r'on Make a GIF|\| .*Blog|Tennis News|Television News|Hindi Movie News|#\w+|\s\|\s|'
                 r'RVCJ|Pepsi', re.I)
sources = {}


def collect(entries):
    for e in entries:
        if e.get('source'):
            sources.setdefault(e['file'], set()).add(e['source'])


for r in rounds:
    for c in ([c for cat in r.get('categories', []) for c in cat['clues']] + r.get('clues', [])):
        collect(c['clueImages']); collect(c['answerImages'])
collect(host['images']); collect([title_img])
with open(os.path.join(out, 'docs', 'image-sources.md'), 'w', encoding='utf-8') as fh:
    fh.write('# Image files with a source name in their alt text\n\n')
    fh.write('Generated by `tools/extract.py` from the deck\'s alt text. These look like screenshots or\n'
             'scraped images (IMDb, Wikipedia, Reddit, news sites, shops). Review the licensing before\n'
             'sharing the site publicly.\n\n| Asset | Used in | Original alt text (source) |\n|---|---|---|\n')
    other = []
    for f in sorted(sources, key=lambda s: (int(re.search(r'image(\d+)', s).group(1)), s)):
        txt = ' / '.join(sorted(sources[f]))
        used = '; '.join(sorted(set(image_usage[f])))[:300]
        row = '| `%s` | %s | %s |\n' % (f, used.replace('|', '/'), txt.replace('|', '/'))
        if any(SRC.search(s) for s in sources[f]):
            fh.write(row)
        else:
            other.append(row)
    if other:
        fh.write('\n## Alt text present but no obvious source name\n\n| Asset | Used in | Alt text |\n|---|---|---|\n')
        fh.writelines(other)
    noalt = sorted(set(image_meta) - set(sources), key=lambda s: (int(re.search(r'image(\d+)', s).group(1)), s))
    fh.write('\n## No alt text in the deck\n\n' + ', '.join('`%s`' % f for f in noalt) + '\n')

print('rounds:', [(r['id'], len(r['clues']) if 'clues' in r else sum(len(c['clues']) for c in r.get('categories', []))) for r in rounds])
print('images:', len(image_meta))
for f in fixes:
    print('FIX', f)
