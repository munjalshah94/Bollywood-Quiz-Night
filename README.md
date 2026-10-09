# Bollywood Quiz Night

A fun game for Bollywood based questions for your party.

A static web app version of the five-round quiz deck. Plain HTML, CSS and JavaScript: no framework, no build step.
Built for a projector (big text, scales up to 4K) and works on a phone.

## Rounds

1. **Lights, Camera, Confusion**: board of 5 categories × 6 clues (10 / 20 / 40 / 60 / 100 / 150)
2. **Emoji Movies**: 12 emoji clues, 50 each
3. **Second Verse Songs**: 8 verses, 75 each
4. **Charades Timer**: real 30-second countdown
5. **Quiz Questions**: 8 questions, 100 each

## Using it

- Pick a round from the menu, open a tile, **Reveal answer**, then **Back to board**. Used tiles turn grey.
- **Scoreboard** (bottom): 2–6 teams, editable names, `+` / `−` buttons, and an editable score box.
  Outside a clue the buttons change the score by the "Tap = ±" step. Inside a clue they use the clue's value.
- **Pass**: the deck's rule is "questions pass from one team to another (+10 points for pass)". Pressing Pass hands the
  clue to the next team and adds 10 to what it is worth for each pass (so a 100-point clue passed once is worth 110).
  Award it with the answering team's `+` button.
- **Reset game** clears scores and tiles after a confirmation. Team names are kept.
- State (used tiles, scores, team names, team count) is saved in the browser's `localStorage`.

| Key | Action |
|---|---|
| Space / Enter | Reveal the answer (clue screen); start the timer (timer screen) |
| Esc | Back (answer/clue → board → menu → title) |
| M | Round menu |
| R | Restart the timer |

## Run locally

`quiz.json` is loaded with `fetch`, so serve the folder rather than opening the file directly:

```sh
python3 -m http.server 8000   # then visit http://localhost:8000/
```

## Layout

```
index.html        page shell
css/style.css     theme (colours taken from the deck)
js/app.js         the whole app
quiz.json         all content: rules, clues, answers, image references
assets/           optimised images (WebP) + the animated clip (WebM/MP4)
tools/extract.py  one-off script that rebuilt quiz.json and assets/ from the .pptx
docs/             deck structure notes, image source list
```

All paths are relative, so it works from any sub-path such as `username.github.io/<repo>/`.

## Regenerating content from the deck

Only needed if the .pptx changes. Needs Python 3, Pillow and ffmpeg:

```sh
python3 tools/extract.py path/to/Bollywood_Quiz_5_Round_Template.pptx .
```

## Things to know

- **Answers are in the page source.** This is a static site, so `quiz.json` contains every answer. Fine for a party; don't use it
  where people might peek.
- **Image sources.** Many pictures came from the web (IMDb, Wikipedia, Reddit, news sites, shops).
  See [`docs/image-sources.md`](docs/image-sources.md) and check licensing before sharing the site widely.
