#!/usr/bin/env node
/* Leak check for quiz hints. Fails (exit 1) if any hint could give the answer away.

   node check_hints.js                       check quiz.json
   node check_hints.js --draft hints_draft.md   check the draft laid over quiz.json (before merging)
   node check_hints.js --quiz other.json     check another file

   Fix failures by rewriting the hint, never by loosening this script. */
'use strict';
const fs = require('fs');
const path = require('path');
const lib = require('./tools/hints_draft.js');

const args = process.argv.slice(2);
function opt(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const quizFile = opt('--quiz') || path.join(__dirname, 'quiz.json');
const draftFile = opt('--draft');

const quiz = JSON.parse(fs.readFileSync(quizFile, 'utf8'));
if (draftFile) lib.applyDraft(quiz, lib.parseDraft(draftFile));

/* Clues that must have two hints (no text, or only an image / emoji / verse). Everything else gets at most one. */
function mustHaveTwo(id) {
  return /^r1-1-(10|20|40|100)$/.test(id) ||  // Pehchan Kaun? baby collages + family tree
    /^r1-2-/.test(id) ||                      // Minimal Masala posters
    id === 'r1-4-10' ||                       // Jodi No. 1, two photos
    /^r2-/.test(id) ||                        // emoji movies
    /^r3-/.test(id) ||                        // second verse songs
    id === 'r5-7' || id === 'r5-8';           // connect puzzles
}

const STOP = new Set(('the film films movie movies with from that this they them then than have will into over your what when where which while ' +
  'about also each more most some such very just like only well song songs were been being their there these those after before again does done ' +
  'made make many much must name near next once same should since still take than upon used uses using would').split(/\s+/));

function norm(s) { return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
function tokens(s) {
  return (norm(s).match(/[a-z]+/g) || []).filter(function (w) { return w.length >= 4 && !STOP.has(w); })
    .map(function (w) { return w.length > 4 ? w.replace(/s$/, '') : w; });
}
function wordCount(s) { return s.trim().split(/\s+/).filter(Boolean).length; }

const failures = [];
let clueCount = 0, hintCount = 0, withHints = 0;
function fail(id, msg) { failures.push(id + ': ' + msg); }

// config
const cfg = quiz.hints;
if (!cfg || typeof cfg.enabled !== 'boolean' || typeof cfg.penaltyPercent !== 'number' || cfg.penaltyPercent < 0 || cfg.penaltyPercent > 100) {
  fail('config', 'quiz.json needs "hints": { "enabled": boolean, "penaltyPercent": 0-100 }');
}

lib.allClues(quiz).forEach(function (x) {
  const c = x.clue, id = c.id;
  clueCount++;
  const hints = c.hints;
  if (!Array.isArray(hints)) return fail(id, 'missing "hints" array');
  if (hints.length > 2) fail(id, 'more than 2 hints');
  const want = mustHaveTwo(id) ? 2 : null;
  if (want && hints.length !== 2) fail(id, 'needs exactly 2 hints, has ' + hints.length);
  if (!want && hints.length > 1) fail(id, 'text-heavy clue may have at most 1 hint, has ' + hints.length);
  if (hints.length) withHints++;

  const answer = String(c.answer || '');
  const aTokens = tokens(answer);
  const years = answer.match(/(?:19|20)\d{2}/g) || [];
  const numbers = (answer.match(/\d+/g) || []).filter(function (n) { return n.length >= 2; });

  hints.forEach(function (h, i) {
    const tag = id + ' hint ' + (i + 1);
    hintCount++;
    if (typeof h !== 'string' || !h.trim()) return fail(tag, 'empty or non-string hint');
    if (wordCount(h) > 14) fail(tag, 'longer than 14 words (' + wordCount(h) + '): "' + h + '"');

    // 1. no answer word (>=4 letters, ignoring common words), also as prefix/substring of a longer word
    tokens(h).forEach(function (w) {
      aTokens.forEach(function (a) {
        if (w === a || (w.length >= 5 && a.length >= 5 && (w.indexOf(a) >= 0 || a.indexOf(w) >= 0))) {
          fail(tag, 'contains answer word "' + w + '" (answer: "' + answer.replace(/\s+/g, ' ') + '"): "' + h + '"');
        }
      });
    });
    // 2. no year, or other number, from the answer text (also catches "2000s" for a 2000 film, "1983" for "83")
    years.concat(numbers).filter(function (n, k, all) { return all.indexOf(n) === k; }).forEach(function (n) {
      if (h.indexOf(n) >= 0) fail(tag, 'contains number "' + n + '" from the answer: "' + h + '"');
    });
    // 3. no letter hints
    if (/\b(letters?|starts? with|begins? with|first letter|initials?|rhymes? with)\b/i.test(h)) fail(tag, 'letter/first-letter language: "' + h + '"');
    // 4. hint 1 must not state a word count
    if (i === 0 && /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)[ -]words?\b/i.test(h)) fail(tag, 'word count belongs in hint 2: "' + h + '"');
  });

  // emoji clues: hint 2 gives the number of words in the title
  if (/^r2-/.test(id) && hints[1] && !/\bwords?\b/i.test(hints[1])) fail(id + ' hint 2', 'emoji hint 2 must give the number of words in the title: "' + hints[1] + '"');
});

console.log('checked ' + clueCount + ' clues: ' + withHints + ' with hints, ' + hintCount + ' hints' + (draftFile ? ' (draft: ' + draftFile + ')' : ''));
if (failures.length) {
  console.error('\nFAILED (' + failures.length + '):');
  failures.forEach(function (f) { console.error('  - ' + f); });
  process.exit(1);
}
console.log('OK: no leaks found');
