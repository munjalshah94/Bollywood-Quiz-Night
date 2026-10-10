#!/usr/bin/env node
/* Rebuild the "charades" block in quiz.json from charades_titles.md, and check that no
   charades title is also an answer in another round.

   node sync_charades.js            check, then rewrite quiz.json (refuses to write if anything overlaps)
   node sync_charades.js --check    check only, never write
   node sync_charades.js --md FILE --quiz FILE   use other files

   Overlap rules (a title is rejected if either holds, for any answer in any round):
     1. the title appears inside the answer as whole words ("Lagaan" inside "Lagaan (2000)");
     2. the title is just a different spelling of the whole answer, or of the part of it outside / inside brackets
        ("Deewaar" vs "Deewar"). Spellings are folded by collapsing doubled letters. */
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const mdFile = opt('--md') || path.join(__dirname, 'charades_titles.md');
const quizFile = opt('--quiz') || path.join(__dirname, 'quiz.json');
const checkOnly = args.includes('--check');

const norm = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const fold = (s) => norm(s).replace(/(.)\1+/g, '$1');
const hasWords = (hay, needle) => needle !== '' && (' ' + hay + ' ').includes(' ' + needle + ' ');

function parseMd(text) {
  const out = { settings: {}, easy: [], medium: [], hard: [], reserve: [] };
  let section = null;
  text.split(/\r?\n/).forEach((line, i) => {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { section = h[1].toLowerCase().split(/\s+/)[0]; return; }
    const b = line.match(/^\s*[-*]\s+(.*?)\s*$/);
    if (!b || !section) return;
    const item = b[1].split(' — ')[0].trim();
    if (section === 'settings') {
      const m = item.match(/^(points per title|seconds per turn)\s*:\s*(\d+)$/i);
      if (m) out.settings[m[1].toLowerCase()] = parseInt(m[2], 10);
    } else if (['easy', 'medium', 'hard', 'reserve'].includes(section)) {
      if (item) out[section].push({ title: item, line: i + 1 });
    }
  });
  return out;
}

function allAnswers(quiz) {
  const res = [];
  quiz.rounds.forEach((r) => {
    const clues = [].concat(...(r.categories || []).map((c) => c.clues), r.clues || []);
    clues.forEach((c) => { if (c.answer) res.push({ id: c.id, round: r.id, answer: c.answer.replace(/\s+/g, ' ').trim() }); });
  });
  return res;
}

function overlaps(title, answers) {
  const T = norm(title), F = fold(title), hits = [];
  answers.forEach((a) => {
    const A = norm(a.answer);
    const parts = [a.answer, a.answer.replace(/\([^)]*\)/g, ' ')]
      .concat((a.answer.match(/\(([^)]*)\)/g) || []).map((p) => p.slice(1, -1)))
      .concat(a.answer.split(/[,&]/));
    if (hasWords(A, T)) hits.push({ ...a, why: 'appears inside the answer' });
    else if (parts.some((p) => fold(p) === F)) hits.push({ ...a, why: 'is a different spelling of the answer' });
  });
  return hits;
}

const md = parseMd(fs.readFileSync(mdFile, 'utf8'));
const quiz = JSON.parse(fs.readFileSync(quizFile, 'utf8'));
const answers = allAnswers(quiz);
const problems = [];

const pointsPerTitle = md.settings['points per title'], secondsPerTurn = md.settings['seconds per turn'];
if (!(pointsPerTitle > 0)) problems.push('Settings: "Points per title" is missing or not a number');
if (!(secondsPerTurn > 0)) problems.push('Settings: "Seconds per turn" is missing or not a number');

const titles = [];
const seen = new Map();
['easy', 'medium', 'hard'].forEach((d) => md[d].forEach((t) => {
  const key = norm(t.title);
  if (seen.has(key)) problems.push(`line ${t.line}: "${t.title}" is listed twice (also ${seen.get(key)})`);
  seen.set(key, `${d}, line ${t.line}`);
  titles.push({ title: t.title, difficulty: d });
  overlaps(t.title, answers).forEach((h) => problems.push(
    `line ${t.line}: "${t.title}" ${h.why} in Round ${h.round} (${h.id}): "${h.answer}"`));
}));
if (!titles.length) problems.push('no titles found in the Easy / Medium / Hard sections');

const warnings = [];
md.reserve.forEach((t) => overlaps(t.title, answers).forEach((h) => warnings.push(
  `reserve "${t.title}" would overlap Round ${h.round} (${h.id}): "${h.answer}", so it can't be used as a replacement`)));

const counts = { easy: 0, medium: 0, hard: 0 };
titles.forEach((t) => counts[t.difficulty]++);
console.log(`charades_titles.md: ${titles.length} titles (Easy ${counts.easy}, Medium ${counts.medium}, Hard ${counts.hard}); ` +
  `${answers.length} answers in the other rounds checked`);
warnings.forEach((w) => console.log('note: ' + w));

if (problems.length) {
  console.error('\nOVERLAP / PROBLEMS (' + problems.length + '):');
  problems.forEach((p) => console.error('  - ' + p));
  console.error('\nNothing was written. Fix charades_titles.md and run again.');
  process.exit(1);
}
console.log('overlap check: OK, no title matches or appears inside an answer in another round');
if (checkOnly) process.exit(0);

const block = { pointsPerTitle, secondsPerTurn, titles };
const next = { hints: quiz.hints, charades: block };
Object.keys(quiz).forEach((k) => { if (k !== 'hints' && k !== 'charades') next[k] = quiz[k]; });
if (!quiz.hints) delete next.hints;
const out = JSON.stringify(next, null, 1) + '\n';
if (fs.readFileSync(quizFile, 'utf8') === out) console.log('quiz.json is already in sync');
else { fs.writeFileSync(quizFile, out); console.log('quiz.json updated: charades block rebuilt from ' + path.basename(mdFile)); }
