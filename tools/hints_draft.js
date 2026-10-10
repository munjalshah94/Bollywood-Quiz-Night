#!/usr/bin/env node
/* Read / merge the human-reviewed hint draft (hints_draft.md).

   Draft format, one block per clue (anything else in the file is ignored):

     ### r1-1-10 · Pehchan Kaun? · 10 pts
     - **Answer:** ...
     - **Hint 1:** text   (or an em dash for "no hint")
     - **Hint 2:** text

   Usage:  node tools/hints_draft.js merge [hints_draft.md] [quiz.json]
   The merge replaces the `hints` array of every clue that has a block in the draft. */
'use strict';
const fs = require('fs');
const path = require('path');

function parseDraft(file) {
  const out = {};
  let id = null;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach(function (line, n) {
    let m = line.match(/^###\s+(r\d+-[\d-]+)\b/);
    if (m) { id = m[1]; if (out[id]) throw new Error(file + ':' + (n + 1) + ' duplicate block for ' + id); out[id] = [null, null]; return; }
    if (/^#{1,2}\s/.test(line)) { id = null; return; }
    m = line.match(/^\s*[-*]\s+\*\*Hint\s*([12]):\*\*\s*(.*?)\s*$/);
    if (m && id) {
      const text = m[2].trim();
      out[id][Number(m[1]) - 1] = (text === '' || /^[—–-]+$/.test(text)) ? '' : text;
    }
  });
  Object.keys(out).forEach(function (k) {
    const h = out[k];
    const a = h[0] || '', b = h[1] || '';
    if (b && !a) throw new Error(k + ': Hint 2 is set but Hint 1 is empty');
    out[k] = [a, b].filter(Boolean);
  });
  return out;
}

function allClues(quiz) {
  const res = [];
  quiz.rounds.forEach(function (r) {
    (r.categories || []).forEach(function (cat) { cat.clues.forEach(function (c) { res.push({ round: r, cat: cat, clue: c }); }); });
    (r.clues || []).forEach(function (c) { res.push({ round: r, cat: null, clue: c }); });
  });
  return res;
}

function applyDraft(quiz, draft) {
  const byId = {};
  allClues(quiz).forEach(function (x) { byId[x.clue.id] = x.clue; });
  Object.keys(draft).forEach(function (id) {
    if (!byId[id]) throw new Error('draft has a block for unknown clue ' + id);
    byId[id].hints = draft[id].slice();
  });
  return quiz;
}

module.exports = { parseDraft: parseDraft, applyDraft: applyDraft, allClues: allClues };

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd !== 'merge') { console.error('usage: node tools/hints_draft.js merge [hints_draft.md] [quiz.json]'); process.exit(2); }
  const root = path.join(__dirname, '..');
  const draftFile = process.argv[3] || path.join(root, 'hints_draft.md');
  const quizFile = process.argv[4] || path.join(root, 'quiz.json');
  const quiz = JSON.parse(fs.readFileSync(quizFile, 'utf8'));
  const draft = parseDraft(draftFile);
  applyDraft(quiz, draft);
  fs.writeFileSync(quizFile, JSON.stringify(quiz, null, 1) + '\n');
  const withHints = Object.keys(draft).filter(function (k) { return draft[k].length; });
  console.log('merged ' + Object.keys(draft).length + ' blocks; ' + withHints.length + ' clues now have hints (' +
    withHints.reduce(function (n, k) { return n + draft[k].length; }, 0) + ' hints) -> ' + quizFile);
}
