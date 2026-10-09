# Structure of the original deck

Source: `Bollywood_Quiz_5_Round_Template.pptx` — 160 slides, 71 media files (21 MB).
Read directly from the slide XML and the per-slide `.rels` files.

## Interactivity

- All 434 links are slide jumps (`hlinksldjump`). There are no macros, no animations, no audio or video.
- Slides 111–140 carry a slide *transition* set to auto-advance after 1 second. That is how the
  30-second timer works in PowerPoint. The web app uses a real countdown instead.
- The deck has one notes file (on slide 1) and it is empty.
- Slides 1 (title), 2 (host notes) and 160 (end) have no inbound links; 112–141 are reached only by auto-advance.

## Slide map

| Slides | Content |
|---|---|
| 1 | Title (full-slide art, "START THE SHOW") |
| 2 | Host notes: game flow text + "SCAN ME" QR code (decodes to `https://buzzin.live/`) |
| 3 | Round menu |
| 4 / 5 | Round 1 intro with rules / 5 × 6 board |
| 6–65 | Round 1: 30 clue slides, each followed by its answer slide |
| 66 / 67 | Round 2 intro / board of 12 tiles |
| 68–91 | Round 2: 12 emoji clues + answers, 50 pts each |
| 92 / 93 | Round 3 intro / board of 8 tiles |
| 94–109 | Round 3: 8 second-verse clues + answers, 75 pts each (text only, no images) |
| 110 | Round 4 rules |
| 111–140 | Timer: 30, 29 … 1 (auto-advancing) |
| 141 | "TIME!" with Replay / Round menu |
| 142 / 143 | Round 5 intro / board of 8 tiles |
| 144–159 | Round 5: 8 quiz questions + answers, 100 pts each |
| 160 | "WINNER! Thank You!" |

Round 1 categories (points 10 / 20 / 40 / 60 / 100 / 150): Badly Explained Blockbusters,
Pehchan Kaun?, Minimal Masala, Filmi Fauna, Jodi No. 1.

## How the mapping was verified

`tools/extract.py` follows each board tile to its clue slide and each clue's REVEAL ANSWER link to its
answer slide, then asserts that the answer slide's title is the clue title plus " - Answer", that
the points on the tile match the points in the title, and that every slide 1–160 is accounted for.
Images are taken from each slide's own `.rels`, never by file number.

Crops that the deck applies to pictures (24 of them) are baked into the exported files. Several clue
images are cropped to hide a movie title, and the baby-collage photo is reused with a different crop per clue.
