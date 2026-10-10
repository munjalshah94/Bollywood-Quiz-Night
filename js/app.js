/* Bollywood Quiz Night — static quiz app. No framework, no build step.
   Content lives in quiz.json (generated from the original PowerPoint by tools/extract.py). */
(function () {
  'use strict';

  var STORE_KEY = 'bollywood-quiz-night:v1';
  var MAX_TEAMS = 6;
  var TEAM_COLORS = ['#6e1e3b', '#0f6f75', '#d94f70', '#6b4fa0', '#c2410c', '#1c2632'];
  var KIND_NAME = { emoji: 'Emoji Movie', verse: 'Second Verse Song', quiz: 'Quiz Question' };

  var $screen = document.getElementById('screen');
  var $topbar = document.getElementById('topbar');
  var $crumb = document.getElementById('crumb');
  var $sb = document.getElementById('scoreboard');
  var $dlg = document.getElementById('dlg');
  var $help = document.getElementById('help');

  var quiz = null;
  var index = {};      // clue id -> { round, clue, cat, label }
  var state = null;
  var timer = { cd: null, api: null, audio: null };   // cd = the countdown of the screen that is showing

  /* ---------------------------------------------------------------- helpers */
  function el(tag, props) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
        else if (k === 'style') node.style.cssText = v;
        else node.setAttribute(k, v === true ? '' : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function trimEnd(s) { return String(s).replace(/\s+$/, ''); }
  
  function toast(msg) {
    var old = document.querySelector('.toast');
    if (old) old.remove();
    var t = el('div', { class: 'toast', role: 'status', text: msg });
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2600);
  }

  /* Yes/No style dialog. opts: ok (label), cancel (label), okClass (button colour), focusOk (focus the OK button, not Cancel). */
  function confirmDialog(title, text, okLabel, opts) {
    opts = opts || {};
    var ok = document.getElementById('dlg-ok'), cancel = document.getElementById('dlg-cancel');
    document.getElementById('dlg-title').textContent = title;
    document.getElementById('dlg-text').textContent = text;
    ok.textContent = okLabel || 'OK';
    ok.className = 'btn ' + (opts.okClass || 'btn-danger');
    cancel.textContent = opts.cancel || 'Cancel';
    return new Promise(function (resolve) {
      $dlg.addEventListener('close', function onClose() {
        $dlg.removeEventListener('close', onClose);
        resolve($dlg.returnValue === 'ok');
      });
      $dlg.returnValue = 'cancel';
      if ($dlg.showModal) {
        $dlg.showModal();
        if (opts.focusOk) ok.focus();
      } else resolve(window.confirm(text));
    });
  }

  /* ---------------------------------------------------------------- state */
  function freshState(prev) {
    var teams = [];
    for (var i = 0; i < MAX_TEAMS; i++) {
      teams.push({ name: prev && prev.teams[i] ? prev.teams[i].name : 'Team ' + (i + 1), score: 0 });
    }
    return {
      v: 1, n: prev ? prev.n : 4, teams: teams, used: {}, turn: 0, run: null,
      step: 'auto', sbOpen: prev ? prev.sbOpen : window.innerWidth >= 760, sound: prev ? prev.sound : true,
      charades: freshCharades(prev && prev.charades)
    };
  }

  /* Charades deck + turn state. Titles are kept by name, so editing the list never breaks a saved game.
     order = the deck, shuffled once per game; used = guessed; skipped = the back of the deck; cur = the card on screen. */
  var CH_PHASES = ['idle', 'pick', 'ready', 'play', 'result', 'summary'];
  function freshCharades(prev) {
    return { filter: prev && ['all', 'easy', 'mh'].indexOf(prev.filter) >= 0 ? prev.filter : 'all',
      order: [], used: [], skipped: [], skipShuffled: false, cycle: 1, last: null,
      phase: 'idle', team: -1, tally: 0, cur: null, expired: false, endAt: 0, left: 0, running: false, turns: {} };
  }
  function cleanCharades(c) {
    var base = freshCharades(c);
    if (!c || typeof c !== 'object') return base;
    var strs = function (a) { return Array.isArray(a) ? a.filter(function (x) { return typeof x === 'string'; }) : []; };
    base.order = strs(c.order); base.used = strs(c.used); base.skipped = strs(c.skipped);
    base.skipShuffled = !!c.skipShuffled; base.cycle = Math.max(1, c.cycle | 0 || 1);
    base.last = typeof c.last === 'string' ? c.last : null;
    base.phase = CH_PHASES.indexOf(c.phase) >= 0 ? c.phase : 'idle';
    base.team = Number.isInteger(c.team) ? c.team : -1;
    base.tally = Math.max(0, c.tally | 0); base.cur = typeof c.cur === 'string' ? c.cur : null;
    base.expired = !!c.expired; base.endAt = Number(c.endAt) || 0; base.left = Math.max(0, Number(c.left) || 0); base.running = !!c.running;
    if (c.turns && typeof c.turns === 'object') {
      Object.keys(c.turns).forEach(function (k) {
        var t = c.turns[k] || {};
        base.turns[k] = { tally: Math.max(0, t.tally | 0), added: !!t.added, applied: Number(t.applied) || 0 };
      });
    }
    return base;
  }

  function loadState() {
    var s = null;
    try { s = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { s = null; }
    if (!s || s.v !== 1 || !Array.isArray(s.teams)) return freshState();
    var base = freshState();
    s.n = Math.min(MAX_TEAMS, Math.max(2, parseInt(s.n, 10) || 4));
    for (var i = 0; i < MAX_TEAMS; i++) {
      var t = s.teams[i] || {};
      base.teams[i] = {
        name: typeof t.name === 'string' ? t.name : base.teams[i].name,
        score: isFinite(t.score) ? Number(t.score) : 0
      };
    }
    base.n = s.n;
    base.used = s.used && typeof s.used === 'object' ? s.used : {};
    base.turn = (s.turn | 0) % base.n;
    base.run = s.run && typeof s.run === 'object' ? s.run : null;
    base.step = ['auto', '1', '10', '50', '100'].indexOf(String(s.step)) >= 0 ? String(s.step) : 'auto';
    base.sbOpen = s.sbOpen !== false;
    base.sound = s.sound !== false;
    base.charades = cleanCharades(s.charades);
    return base;
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* private mode etc. */ }
  }

  /* ---------------------------------------------------------------- data */
  function clueTitle(info) {
    var c = info.clue;
    if (info.cat) return info.cat.name.replace(/\n/g, ' ') + ' · ' + c.points + ' points';
    return KIND_NAME[info.round.kind] + ' ' + pad2(c.number) + ' · ' + c.points + ' points';
  }

  function buildIndex() {
    quiz.rounds.forEach(function (r) {
      if (r.categories) {
        r.categories.forEach(function (cat) {
          cat.clues.forEach(function (c) { index[c.id] = { round: r, cat: cat, clue: c }; });
        });
      } else if (r.clues) {
        r.clues.forEach(function (c) { index[c.id] = { round: r, clue: c }; });
      }
    });
  }

  function roundClues(r) {
    return r.categories ? [].concat.apply([], r.categories.map(function (c) { return c.clues; })) : (r.clues || []);
  }

  function roundById(id) {
    return quiz.rounds.filter(function (r) { return r.id === id; })[0];
  }

  /* ---------------------------------------------------------------- routing */
  function parseHash() {
    var parts = (location.hash || '').replace(/^#\/?/, '').split('/');
    return { name: parts[0] || 'title', arg: parts[1] ? decodeURIComponent(parts[1]) : null };
  }
  function go(hash) {
    if (location.hash === hash) render(); else location.hash = hash;
  }
  function currentClueInfo() {
    var r = parseHash();
    return (r.name === 'clue' || r.name === 'answer') ? index[r.arg] : null;
  }

  /* ---------------------------------------------------------------- scoring */
  function runFor(info) {
    var wasUsed = !!state.used[info.clue.id];
    if (!state.run || state.run.id !== info.clue.id) {
      state.run = { id: info.clue.id, passes: 0, hints: 0, asker: state.turn, advance: !wasUsed };
    }
    return state.run;
  }
  function answeringIndex() {
    var r = parseHash();
    if (r.name !== 'clue' && r.name !== 'answer') return -1;
    return state.run && state.run.id === r.arg ? (state.run.asker + state.run.passes) % state.n : -1;
  }
  /* ---- hints: revealed one at a time, optionally costing a share of the clue's points ---- */
  var hintUI = null;   // set by the clue screen so the H key can reach it
  function hintCfg() { return quiz.hints || { enabled: false, penaltyPercent: 0 }; }
  function clueHints(c) { return hintCfg().enabled && Array.isArray(c.hints) ? c.hints.filter(Boolean) : []; }
  function hintCost(c) { var pct = Number(hintCfg().penaltyPercent) || 0; return Math.max(0, Math.round(c.points * pct / 100 / 5) * 5); }
  function runOf(info) { return state.run && state.run.id === info.clue.id ? state.run : null; }
  function hintsUsed(info) { var run = runOf(info); return run ? Math.min(run.hints | 0, clueHints(info.clue).length) : 0; }
  /* Nearest ten, halves round up: 85 -> 90, 75 -> 80, 65 -> 70. */
  function roundTo10(x) { return Math.max(0, Math.floor(x / 10 + 0.5) * 10); }
  /* What the answering team earns now.
     Lap 1: points + 10 per pass - hint cost.
     Lap 2 (everyone failed lap 1): half of the lap-1 value (nearest ten), + 10 per pass since, - cost of hints revealed since. Never below 0. */
  function clueValue(info) {
    var run = runOf(info), cost = hintCost(info.clue), used = hintsUsed(info);
    if (run && run.r2) {
      return Math.max(0, run.r2.value + 10 * (run.passes - run.r2.from) - (used - run.r2.hintsAt) * cost);
    }
    return Math.max(0, info.clue.points + 10 * (run ? run.passes : 0) - used * cost);
  }
  /* Where the clue is in the passing cycle: 'lap1', 'ready-lap2' (every team has had a go, round 2 can start),
     'lap2' or 'done' (both laps used up). */
  function passState(info) {
    var run = info && runOf(info);
    if (!run) return 'lap1';
    if (!run.r2) return run.passes >= state.n - 1 ? 'ready-lap2' : 'lap1';
    return run.passes - run.r2.from >= state.n - 1 ? 'done' : 'lap2';
  }
  function passLabel(st) {
    return st === 'ready-lap2' ? 'Round 2 \u00b7 half points' : st === 'done' ? 'No passes left' : 'Pass \u21aa +10';
  }
  function passTitle(st) {
    return st === 'ready-lap2' ? 'Nobody got it: go round again for half points' :
      st === 'done' ? 'Both rounds of passing are used up' : 'Pass the question to the next team (+10 bonus)';
  }
  /* Button or H: ask "Are you sure?" first. Only Yes shows the hint; No (or Esc) leaves it hidden. */
  var hintAsking = false;
  function revealHint() {
    var ui = hintUI;
    if (!ui || parseHash().name !== 'clue' || hintAsking || $dlg.open) return;
    var question = ui.question();
    if (!question) return;   // no more hints
    hintAsking = true;
    confirmDialog('Are you sure?', question, 'Yes', { cancel: 'No', okClass: 'btn-teal', focusOk: true }).then(function (yes) {
      hintAsking = false;
      if (yes && hintUI === ui && parseHash().name === 'clue') ui.reveal();
    });
  }

  function stepValue() {
    if (state.step !== 'auto') return Number(state.step);
    var info = currentClueInfo();
    if (info) return clueValue(info);
    return 10;
  }
  function adjust(i, sign) {
    state.teams[i].score += sign * stepValue();
    save();
    renderScoreboard();
  }
  var passAsking = false;
  function passClue() {
    var info = currentClueInfo();
    if (!info || parseHash().name !== 'clue') return toast('Pass is only available while a clue is open.');
    if (passAsking || $dlg.open) return;
    var run = runFor(info), st = passState(info);
    if (st === 'done') return toast('No passes left: both rounds are used up.');
    if (st === 'ready-lap2') {
      // every team has had a go: offer a second lap at half points
      var was = clueValue(info), half = roundTo10(was / 2);
      passAsking = true;
      confirmDialog('Nobody got it?', 'Everyone has had a go. Go round again for ' + half + ' points (half of ' + was + ')?', 'Yes',
        { cancel: 'No', okClass: 'btn-teal', focusOk: true }).then(function (yes) {
        passAsking = false;
        if (!yes || parseHash().name !== 'clue' || !state.run || state.run.id !== info.clue.id || state.run.r2) return;
        state.run.passes += 1;   // steps round to the team that asked first
        state.run.r2 = { value: half, was: was, from: state.run.passes, hintsAt: hintsUsed(info) };
        save();
        toast('Round 2: ' + state.teams[answeringIndex()].name + ' is up for ' + half + ' (half of ' + was + ')');
        render();
      });
      return;
    }
    run.passes += 1;
    save();
    toast('Passed to ' + state.teams[answeringIndex()].name + ' \u2014 clue now worth ' + clueValue(info));
    render();
  }
  function backToBoard() {
    var r = parseHash();
    var info = index[r.arg];
    if (!info) return go('#/menu');
    if (state.run && state.run.id === info.clue.id) {
      if (state.run.advance) state.turn = (state.run.asker + 1) % state.n;
      state.run = null;
      save();
    }
    go('#/board/' + info.round.id);
  }

  /* ---------------------------------------------------------------- scoreboard */
  function renderScoreboard() {
    var route = parseHash().name;
    var chPhase = route === 'charades' ? state.charades.phase : '';
    if (route === 'title' || chPhase === 'ready' || chPhase === 'play') { $sb.hidden = true; document.documentElement.style.setProperty('--sb-h', '0px'); return; }
    $sb.hidden = false;
    $sb.className = state.sbOpen ? '' : 'collapsed';
    var answering = answeringIndex();
    var info = currentClueInfo();
    var val = stepValue();
    var canPass = route === 'clue';
    var passSt = canPass ? passState(info) : 'lap1';

    var stepSel = el('select', {
      id: 'step', 'aria-label': 'Points per tap',
      onchange: function (e) { state.step = e.target.value; save(); renderScoreboard(); }
    });
    [['auto', info ? 'Clue value' : '10'], ['1', '1'], ['10', '10'], ['50', '50'], ['100', '100']].forEach(function (o) {
      var opt = el('option', { value: o[0], text: o[1] });
      if (state.step === o[0]) opt.selected = true;
      stepSel.appendChild(opt);
    });

    var nSel = el('select', {
      id: 'nteams', 'aria-label': 'Number of teams',
      onchange: function (e) { state.n = parseInt(e.target.value, 10); state.turn %= state.n; save(); render(); }
    });
    for (var n = 2; n <= MAX_TEAMS; n++) {
      var o = el('option', { value: n, text: String(n) });
      if (n === state.n) o.selected = true;
      nSel.appendChild(o);
    }

    var mini = el('div', { class: 'sb-mini', 'aria-hidden': 'true' });
    for (var m = 0; m < state.n; m++) {
      mini.appendChild(el('span', { style: 'background:' + TEAM_COLORS[m], text: (state.teams[m].name || 'Team ' + (m + 1)) + ' ' + state.teams[m].score }));
    }
    var bar = el('div', { class: 'sb-bar' },
      el('div', { class: 'sb-tools sb-head' },
        el('span', { class: 'sb-title', text: 'Scoreboard' }),
        el('button', { type: 'button', class: 'btn btn-gold btn-sm sb-toggle', 'aria-expanded': String(state.sbOpen),
          onclick: function () { state.sbOpen = !state.sbOpen; save(); renderScoreboard(); } },
          state.sbOpen ? 'Hide' : 'Show scores'),
        mini),
      el('div', { class: 'sb-tools sb-full' },
        el('label', null, 'Teams ', nSel),
        el('label', null, 'Tap = ±', stepSel),
        el('button', { type: 'button', class: 'btn btn-coral btn-sm', id: 'btn-pass', disabled: !canPass || passSt === 'done',
          title: passTitle(passSt), onclick: passClue }, passLabel(passSt)),
        el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: askReset }, 'Reset game')));

    var teams = el('div', { class: 'sb-teams', style: '--n:' + state.n });
    for (var i = 0; i < state.n; i++) {
      (function (i) {
        var t = state.teams[i];
        var cls = 'team' + (i === answering ? ' is-answering' : (answering < 0 && i === state.turn && route === 'board' ? ' is-turn' : ''));
        var name = el('input', {
          class: 'tname', type: 'text', value: t.name, maxlength: 24, 'aria-label': 'Team ' + (i + 1) + ' name', placeholder: 'Team ' + (i + 1),
          oninput: function (e) { state.teams[i].name = e.target.value; save(); },
          onkeydown: function (e) { if (e.key === 'Enter' || e.key === 'Escape') e.target.blur(); }
        });
        var score = el('input', {
          class: 'tscore', type: 'number', inputmode: 'numeric', value: String(t.score), 'aria-label': t.name + ' score',
          onchange: function (e) {
            var v = parseInt(e.target.value, 10);
            state.teams[i].score = isFinite(v) ? v : 0;
            e.target.value = String(state.teams[i].score);
            save();
          },
          onkeydown: function (e) { if (e.key === 'Enter' || e.key === 'Escape') e.target.blur(); }
        });
        var card = el('div', { class: cls, style: '--tcol:' + TEAM_COLORS[i] },
          name,
          el('div', { class: 'trow' },
            el('button', { type: 'button', class: 'sbtn minus', 'aria-label': 'Subtract ' + val + ' from team ' + (i + 1),
              onclick: function () { adjust(i, -1); } }, '−' + val),
            score,
            el('button', { type: 'button', class: 'sbtn plus', 'aria-label': 'Add ' + val + ' to team ' + (i + 1),
              onclick: function () { adjust(i, 1); } }, '+' + val)));
        teams.appendChild(card);
      })(i);
    }

    $sb.replaceChildren(bar, teams);
    document.documentElement.style.setProperty('--sb-h', $sb.offsetHeight + 'px');
  }

  function askReset() {
    confirmDialog('Reset game?', 'All scores go back to 0 and every tile becomes available again. Team names and the number of teams are kept.', 'Reset game')
      .then(function (ok) {
        if (!ok) return;
        state = freshState(state);
        save();
        toast('Game reset.');
        go('#/menu');
        render();
      });
  }

  /* ---------------------------------------------------------------- media */
  function figure(img, alt, overlays) {
    var inner;
    if (img.video) {
      inner = el('video', {
        autoplay: true, loop: true, muted: true, playsinline: true, poster: img.video.poster, width: img.w, height: img.h, 'aria-label': alt
      },
        el('source', { src: img.video.webm, type: 'video/webm' }),
        el('source', { src: img.video.mp4, type: 'video/mp4' }));
      inner.muted = true; // attribute alone isn't enough in some browsers
    } else {
      inner = el('img', { src: img.src, alt: alt, width: img.w, height: img.h, decoding: 'async' });
    }
    var fig = el('figure', { class: 'fig', style: 'margin:0' }, inner);
    (overlays || []).forEach(function (o) {
      fig.appendChild(el('span', {
        class: 'badge', text: o.text,
        style: 'left:' + o.x + '%;top:' + o.y + '%;width:' + o.w + '%;height:' + o.h + '%'
      }));
    });
    return fig;
  }

  /* Clue images always get a neutral alt ("Clue image"): the deck's alt text is the source page title and can give the answer away.
     Answer images may use it, because they only ever exist in the DOM on the answer view. */
  function imagesBlock(list, role, overlays, solo, descriptive) {
    if (!list || !list.length) return null;
    var box = el('div', { class: 'imgs' + (solo ? ' solo' : '') });
    list.forEach(function (img, i) {
      var alt = role + (list.length > 1 ? ' ' + (i + 1) : '');
      if (descriptive && img.source) alt = img.source;
      box.appendChild(figure(img, alt, overlays));
    });
    return box;
  }

  function preloadAnswer(info) {
    (info.clue.answerImages || []).forEach(function (img) {
      var src = img.src || (img.video && img.video.poster);
      if (src) { var i = new Image(); i.src = src; }
    });
  }

  /* ---------------------------------------------------------------- screens */
  function setCrumb(kicker, title) {
    if (!kicker && !title) { $topbar.hidden = true; return; }
    $topbar.hidden = false;
    $crumb.replaceChildren(el('span', { class: 'kicker', text: kicker || '' }), el('span', { class: 'title', text: title || '' }));
  }

  function mount(node) {
    node.classList.add('screen-in');
    $screen.replaceChildren(node);
    window.scrollTo(0, 0);
  }

  /* The "?" controls guide: a modal dialog over the page (no navigation, the URL never changes). */
  function openHelp() {
    if (!$help || $help.open || document.querySelector('dialog[open]')) return;
    if ($help.showModal) $help.showModal(); else $help.setAttribute('open', '');
  }
  function anyDialogOpen() { return !!document.querySelector('dialog[open]'); }

  function screenTitle() {
    setCrumb();
    document.title = quiz.title;
    var used = Object.keys(state.used).length;
    var scored = state.teams.slice(0, state.n).some(function (t) { return t.score; });
    var bg = quiz.titleImage.src;
    var node = el('section', { class: 'title-screen', style: 'background-image:url("' + bg + '")' },
      el('button', { type: 'button', class: 'help-btn', id: 'btn-help', onclick: openHelp,
        'aria-label': 'How to play: controls', 'aria-haspopup': 'dialog', title: 'How to play: controls (?)' }, '?'),
      el('div', { class: 'title-inner' },
        el('h1', { text: quiz.title }),
        el('p', { class: 'sub', text: 'Five rounds of filmi fun' + (used || scored ? ' · game in progress' : '') }),
        el('div', { class: 'actions' },
          el('button', { type: 'button', class: 'btn btn-lg', id: 'btn-start', onclick: function () { go('#/menu'); } },
            used || scored ? 'Continue the show' : quiz.startLabel)),
        el('div', { class: 'title-links' },
          el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: function () { go('#/host'); } }, 'Host notes'),
          (used || scored) ? el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: askReset }, 'Reset game') : null)));
    mount(node);
  }

  function screenMenu() {
    setCrumb('Main navigation', 'Round menu');
    document.title = 'Round menu · ' + quiz.title;
    var grid = el('div', { class: 'menu-grid' });
    quiz.rounds.forEach(function (r) {
      var clues = roundClues(r);
      var done = clues.filter(function (c) { return state.used[c.id]; }).length;
      var prog = clues.length ? done + ' / ' + clues.length + ' played' : '30-second timer';
      var pct = clues.length ? Math.round(done / clues.length * 100) : 0;
      grid.appendChild(el('button', { type: 'button', class: 'round-card rc' + r.id, onclick: function () { go('#/round/' + r.id); } },
        el('span', { class: 'num', text: 'ROUND ' + r.id }),
        el('span', { class: 'name', text: r.name }),
        clues.length ? el('span', { class: 'bar' }, el('i', { style: 'width:' + pct + '%' })) : null,
        el('span', { class: 'prog', text: prog })));
    });
    var node = el('section', null,
      grid,
      el('div', { class: 'menu-extra' },
        el('button', { type: 'button', class: 'btn btn-teal', onclick: function () { go('#/host'); } }, 'Host notes'),
        el('button', { type: 'button', class: 'btn btn-gold', onclick: function () { go('#/end'); } }, 'Finish game'),
        el('button', { type: 'button', class: 'btn btn-ghost', onclick: function () { go('#/title'); } }, 'Title screen')));
    mount(node);
  }

  function screenHost() {
    var h = quiz.hostNotes;
    setCrumb(h.kicker, h.title);
    document.title = h.title + ' · ' + quiz.title;
    var qr = h.images && h.images[0];
    var node = el('section', { class: 'host' },
      el('div', { class: 'card txt', text: h.text }),
      qr ? el('div', { class: 'qr' },
        el('img', { src: qr.src, width: qr.w, height: qr.h, alt: 'QR code for buzzin.live' }),
        el('a', { href: 'https://buzzin.live/', target: '_blank', rel: 'noopener noreferrer', text: 'buzzin.live' })) : null,
      el('div', { class: 'actions', style: 'flex-basis:100%' },
        el('button', { type: 'button', class: 'btn btn-teal', onclick: function () { go('#/menu'); } }, 'Round menu')));
    mount(node);
  }

  function screenIntro(r) {
    setCrumb('Round intro', 'Round ' + r.id);
    document.title = 'Round ' + r.id + ' · ' + quiz.title;
    var rules = r.rules ? trimEnd(r.rules) : '';
    var rulesNode = null;
    if (rules) {
      var lines = rules.split('\n');
      var heading = /^rules:?$/i.test(lines[0].trim()) ? lines.shift() : null;
      rulesNode = el('div', { class: 'card rules' },
        heading ? el('span', { class: 'rules-title', text: heading }) : null,
        document.createTextNode(lines.join('\n')));
    }
    var cards = r.type === 'timer' && quiz.charades;
    var start = cards
      ? el('button', { type: 'button', class: 'btn btn-lg btn-pink', id: 'btn-startround', onclick: startCharades },
        state.charades.phase === 'idle' ? 'Start charades' : 'Continue charades')
      : r.type === 'timer'
        ? el('button', { type: 'button', class: 'btn btn-lg btn-pink', id: 'btn-startround', onclick: function () { go('#/timer'); } }, 'Start ' + r.seconds + ' sec timer')
        : el('button', { type: 'button', class: 'btn btn-lg btn-teal', id: 'btn-startround', onclick: function () { go('#/board/' + r.id); } }, 'Start round');
    var node = el('section', { class: 'intro' },
      el('div', { class: 'big-num', text: String(r.id) }),
      el('h2', { text: r.introTitle || r.name }),
      rulesNode,
      cards ? el('p', { class: 'ch-pp', text: quiz.charades.pointsPerTitle + ' points for every title the team guesses · ' + quiz.charades.secondsPerTurn + ' seconds per turn' }) : null,
      cards ? charadesIntroControls() : null,
      el('div', { class: 'actions' },
        start,
        el('button', { type: 'button', class: 'btn btn-ghost btn-lg', onclick: function () { go('#/menu'); } }, 'Menu')));
    mount(node);
  }

  function tile(info, label, extra) {
    var c = info.clue;
    var used = !!state.used[c.id];
    var b = el('button', {
      type: 'button', class: 'tile' + (used ? ' used' : '') + (extra ? ' ' + extra : ''), 'data-id': c.id,
      'aria-label': label + (used ? ' (used)' : ''), onclick: function () { go('#/clue/' + c.id); }
    });
    return b;
  }

  function screenBoard(r) {
    setCrumb('Round ' + r.id, r.name + ' board');
    document.title = r.name + ' · ' + quiz.title;
    var wrap = el('section', { class: 'board-wrap' });
    var chip = el('span', { class: 'turn-chip', text: 'Picking: ' + state.teams[state.turn].name });
    var done = roundClues(r).filter(function (c) { return state.used[c.id]; }).length;
    wrap.appendChild(el('div', { class: 'board-head' },
      chip,
      el('span', null,
        el('span', { class: 'turn-chip', text: done + ' / ' + roundClues(r).length + ' played' }), ' ',
        el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: function () { go('#/round/' + r.id); } }, 'Round rules'))));
    if (r.boardPrompt) wrap.appendChild(el('p', { class: 'board-note', text: r.boardPrompt }));

    if (r.categories) {
      var grid = el('div', { class: 'board1' });
      r.categories.forEach(function (cat) {
        var col = el('div', { class: 'cat' },
          el('div', { class: 'cat-head', style: 'background:' + (cat.color || 'var(--maroon)') },
            el('b', { text: cat.name }), cat.tagline ? el('small', { text: cat.tagline }) : null));
        cat.clues.forEach(function (c) {
          var t = tile({ clue: c }, cat.name.replace(/\n/g, ' ') + ' ' + c.points + ' points');
          t.style.setProperty('--tc', cat.color || 'var(--maroon)');
          t.textContent = String(c.points);
          col.appendChild(t);
        });
        grid.appendChild(col);
      });
      wrap.appendChild(grid);
    } else {
      var g2 = el('div', { class: 'board2' + (r.clues.length === 8 ? ' cols-4' : '') });
      r.clues.forEach(function (c) {
        var t = tile({ clue: c }, KIND_NAME[r.kind] + ' ' + c.number + ', ' + c.points + ' points', 'tc-' + r.id);
        t.appendChild(el('span', { class: 'tnum', text: (r.kind === 'emoji' ? 'MOVIE ' : r.kind === 'verse' ? 'SONG ' : 'QUESTION ') + pad2(c.number) }));
        t.appendChild(el('span', { class: 'tpts', text: c.points + ' pts' }));
        g2.appendChild(t);
      });
      wrap.appendChild(g2);
    }
    mount(wrap);
  }

  function textClass(info, text) {
    var k = info.round.kind;
    if (k === 'emoji') return 'emoji';
    if (k === 'verse') return 'verse';
    var n = text.length;
    return n > 330 ? 't-sm' : n > 150 ? 't-md' : '';
  }

  function screenClue(info) {
    var c = info.clue, r = info.round;
    var run = runFor(info); // must run before the tile is marked used: it records whether this is a first play
    state.used[c.id] = true;
    save();
    preloadAnswer(info);
    setCrumb('Round ' + r.id + ' · ' + r.name, clueTitle(info));
    document.title = clueTitle(info) + ' · ' + quiz.title;

    var prompt = c.prompt ? trimEnd(c.prompt) : '';
    var hasImgs = c.clueImages && c.clueImages.length;
    var nImg = (c.clueImages || []).length;
    var txt = prompt ? el('div', { class: 'clue-text ' + textClass(info, prompt), text: prompt }) : null;
    if (txt && r.kind === 'verse') {
      var vl = prompt.split('\n');
      txt.style.setProperty('--lines', String(vl.length));
      if (vl.length >= 10) {
        // Long verse: two blocks split at the stanza break that balances them best, shown side by side while a hint is open.
        // The two blocks add up to exactly the original text.
        var split = Math.ceil(vl.length / 2), best = Infinity;
        vl.forEach(function (ln, i) {
          if (ln.trim() === '' && i + 1 < vl.length && Math.abs((i + 1) - (vl.length - i - 1)) < best) { best = Math.abs((i + 1) - (vl.length - i - 1)); split = i + 1; }
        });
        txt.textContent = '';
        txt.classList.add('cols');
        txt.appendChild(el('span', { class: 'vcol', text: vl.slice(0, split).join('\n') + '\n' }));
        txt.appendChild(el('span', { class: 'vcol', text: vl.slice(split).join('\n') }));
        txt.style.setProperty('--rows', String(Math.max(split, vl.length - split)));
      }
    }
    var body = el('div', { class: 'clue-body' + (prompt && (nImg > 1 || (nImg && prompt.length > 150)) ? ' stack' : '') },
      txt,
      imagesBlock(c.clueImages, 'Clue image', c.overlays, !prompt));
    var card = el('div', { class: 'card clue-card' + (r.id % 2 === 0 ? ' teal' : '') },
      c.label ? el('div', { class: 'clue-label', text: c.label }) : null,
      body);
    if (!prompt && !hasImgs) card.appendChild(el('div', { class: 'clue-text', text: '—' }));

    // hints stay hidden until the Hint button (or H) is used
    var hints = clueHints(c);
    var hintBtn = null, hintBox = null;
    if (hints.length) {
      var cost = hintCost(c);
      var hintCount = el('div', { class: 'hint-count' });
      var hintList = el('ol', { class: 'hint-list' });
      hintBox = el('div', { class: 'hint-box', 'aria-live': 'polite', hidden: true }, hintCount, hintList);
      hintBtn = el('button', { type: 'button', class: 'btn btn-lg btn-gold', id: 'btn-hint', onclick: revealHint,
        title: 'Reveal the next hint (H)' + (cost ? ' \u2014 costs ' + cost + ' points if the clue is awarded' : '') });
      card.appendChild(hintBox);
    }

    var chip = runChip(info);
    var node = el('section', { class: 'clue' }, card, chip,
      el('div', { class: 'actions' },
        el('button', { type: 'button', class: 'btn btn-lg', id: 'btn-reveal', onclick: function () { go('#/answer/' + c.id); } }, 'Reveal answer'),
        hintBtn,
        el('button', { type: 'button', class: 'btn btn-lg btn-coral', id: 'btn-pass-clue', onclick: passClue,
          disabled: passState(info) === 'done', title: passTitle(passState(info)) }, passLabel(passState(info))),
        el('button', { type: 'button', class: 'btn btn-lg btn-teal', onclick: backToBoard }, 'Back to board'),
        run.advance ? el('button', { type: 'button', class: 'btn btn-sm btn-ghost', id: 'btn-unuse',
          title: 'Opened by mistake? Put this tile back on the board.',
          onclick: function () { delete state.used[c.id]; state.run = null; save(); toast('Tile put back on the board.'); go('#/board/' + r.id); } },
          'Mark unused') : null));
    mount(node);

    if (hints.length) {
      var paint = function () {
        var n = hintsUsed(info), total = hints.length, cost = hintCost(c);
        hintList.replaceChildren();
        hints.slice(0, n).forEach(function (h, i) {
          hintList.appendChild(el('li', null, el('b', { text: 'Hint ' + (i + 1) + ': ' }), document.createTextNode(h)));
        });
        hintBox.hidden = n === 0;
        hintCount.textContent = n ? 'Hint ' + n + ' of ' + total : '';
        hintBtn.disabled = n >= total;
        hintBtn.textContent = n >= total ? 'No more hints' : 'Hint' + (cost ? ' (\u2212' + cost + ')' : '');
        node.classList.toggle('hints-open', n > 0);
        if (chip && chip.chip) chip.chip.textContent = chipText(info);
      };
      hintUI = {
        question: function () {
          var n = hintsUsed(info);
          if (n >= hints.length) return '';
          var cost = hintCost(c);
          return 'Show hint ' + (n + 1) + ' of ' + hints.length + '?' + (cost ? ' It costs ' + cost + ' points if the clue is awarded.' : '');
        },
        reveal: function () {
          var run = runOf(info);
          if (!run || (run.hints | 0) >= hints.length) return;
          run.hints = (run.hints | 0) + 1;
          save();
          paint();
          renderScoreboard();   // the + buttons show the net value when hints cost points
        }
      };
      paint();
    }
  }

  function chipText(info) {
    var run = runOf(info);
    if (!run) return '';
    var who = state.teams[(run.asker + run.passes) % state.n].name;
    var used = hintsUsed(info), cost = hintCost(info.clue);
    var notes = [];
    if (run.r2) {
      notes.push('halved from ' + run.r2.was);
      if (run.passes > run.r2.from) notes.push('+' + (10 * (run.passes - run.r2.from)) + ' pass bonus');
      if (used > run.r2.hintsAt) notes.push('\u2212' + (cost * (used - run.r2.hintsAt)) + ' for hints');
    } else {
      if (run.passes) notes.push('+' + (10 * run.passes) + ' pass bonus');
      if (cost && used) notes.push('\u2212' + (cost * used) + ' for ' + used + (used === 1 ? ' hint' : ' hints'));
    }
    return 'Answering: ' + who + ' \u00b7 ' + (run.r2 ? 'round 2 \u00b7 ' : '') + 'worth ' + clueValue(info) + (notes.length ? ' (' + notes.join(', ') + ')' : '');
  }

  function runChip(info) {
    if (!runOf(info)) return null;
    var span = el('span', { class: 'run-chip', text: chipText(info) });
    var wrap = el('div', { style: 'text-align:center;margin-top:.8rem' }, span);
    wrap.chip = span;
    return wrap;
  }

  function screenAnswer(info) {
    var c = info.clue, r = info.round;
    var run = runFor(info);
    state.used[c.id] = true;
    save();
    setCrumb('Round ' + r.id + ' · ' + r.name, clueTitle(info) + ' · answer');
    document.title = 'Answer · ' + clueTitle(info) + ' · ' + quiz.title;
    var ans = c.answer ? trimEnd(c.answer) : '';
    var nAns = (c.answerImages || []).length;
    var body = el('div', { class: 'clue-body' + (ans && (nAns > 1 || (nAns && ans.length > 90)) ? ' stack' : '') },
      ans ? el('div', { class: 'clue-text answer' + (ans.length > 70 ? ' long' : ''), text: ans }) : null,
      imagesBlock(c.answerImages, 'Answer image', null, !ans, true));
    var card = el('div', { class: 'card clue-card' + (r.id % 2 === 0 ? ' teal' : '') },
      el('div', { class: 'clue-label', text: 'Correct answer' }), body);
    var node = el('section', { class: 'clue' }, card, runChip(info),
      el('div', { class: 'actions' },
        el('button', { type: 'button', class: 'btn btn-lg btn-teal', id: 'btn-back', onclick: backToBoard }, 'Back to board')));
    mount(node);
  }

  /* ---------------------------------------------------------------- timer */
  /* One real countdown, shared by the quick timer and every charades turn (never one screen per second).
     It runs off a wall-clock end time, not a count of ticks, so it stays right when the tab is in the background,
     when a phone sleeps, or after a refresh. Pause remembers what is left; resume sets a new end time. */
  function makeCountdown(seconds, h) {
    h = h || {};
    var cd = { mode: 'idle', total: seconds * 1000, left: seconds * 1000, endAt: 0, handle: 0 };
    function halt() { if (cd.handle) { clearInterval(cd.handle); cd.handle = 0; } }
    function spin() { halt(); cd.handle = setInterval(cd.tick, 100); }
    cd.tick = function () {
      if (cd.mode !== 'run') return;
      var left = cd.endAt - Date.now();
      if (left <= 0) { cd.left = 0; cd.mode = 'done'; halt(); if (h.onDone) h.onDone(); }
      else if (h.onTick) h.onTick(left);
    };
    cd.start = function () {
      cd.left = cd.total; cd.endAt = Date.now() + cd.total; cd.mode = 'run'; spin();
      if (h.onStart) h.onStart(); if (h.onTick) h.onTick(cd.left);
    };
    cd.pause = function () {
      if (cd.mode !== 'run') return;
      cd.left = Math.max(0, cd.endAt - Date.now()); cd.mode = 'pause'; halt();
      if (h.onPause) h.onPause(); if (h.onTick) h.onTick(cd.left);
    };
    cd.resume = function () {
      if (cd.mode !== 'pause') return;
      cd.endAt = Date.now() + cd.left; cd.mode = 'run'; spin();
      if (h.onStart) h.onStart(); if (h.onTick) h.onTick(cd.left);
    };
    cd.reset = function () { halt(); cd.mode = 'idle'; cd.left = cd.total; };
    cd.setPaused = function (leftMs) { halt(); cd.mode = 'pause'; cd.left = leftMs; if (h.onTick) h.onTick(leftMs); };
    cd.stop = halt;
    return cd;
  }

  function beep(freq, ms, when) {
    if (!state.sound) return;
    try {
      var ctx = timer.audio || (timer.audio = new (window.AudioContext || window.webkitAudioContext)());
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'square'; o.frequency.value = freq;
      var t0 = ctx.currentTime + (when || 0);
      g.gain.setValueAtTime(.0001, t0);
      g.gain.exponentialRampToValueAtTime(.25, t0 + .01);
      g.gain.exponentialRampToValueAtTime(.0001, t0 + ms / 1000);
      o.connect(g); g.connect(ctx.destination);
      o.start(t0); o.stop(t0 + ms / 1000 + .02);
    } catch (e) { /* audio is optional */ }
  }
  // Browsers only allow sound after a tap, so every button that starts a clock calls this first.
  function primeAudio() {
    if (!state.sound) return;
    try {
      var ctx = timer.audio || (timer.audio = new (window.AudioContext || window.webkitAudioContext)());
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
    } catch (e) { /* audio is optional */ }
  }

  function stopTimer() { if (timer.cd) { timer.cd.stop(); timer.cd = null; } }
  // A hidden tab throttles timers, but the countdown compares clocks, so just catch up the moment the tab is back.
  document.addEventListener('visibilitychange', function () { if (!document.hidden && timer.cd && timer.cd.handle) timer.cd.tick(); });

  function soundButton() {
    var b = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', id: 'btn-sound',
      onclick: function () { state.sound = !state.sound; save(); b.textContent = state.sound ? 'Sound: on' : 'Sound: off'; if (state.sound) primeAudio(); } },
      state.sound ? 'Sound: on' : 'Sound: off');
    return b;
  }

  /* The quick timer (#/timer): just the clock, for groups that use paper cards. */
  function screenTimer() {
    var r = roundById(4);
    var total = quiz.charades ? quiz.charades.secondsPerTurn : r.seconds;
    stopTimer();
    setCrumb('Round 4', 'Charades timer');
    document.title = 'Charades timer · ' + quiz.title;

    var digits = el('div', { class: 'digits', id: 'digits', role: 'timer', 'aria-live': 'off', text: String(total) });
    var unit = el('div', { class: 'unit', id: 'unit', text: r.unitLabel || 'seconds remaining' });
    var fill = el('i');
    var meter = el('div', { class: 'meter', 'aria-hidden': 'true' }, fill);
    var startBtn = el('button', { type: 'button', class: 'btn btn-lg btn-pink', id: 'btn-timer-start' }, 'Start');
    var pauseBtn = el('button', { type: 'button', class: 'btn btn-lg btn-navy', id: 'btn-timer-pause', disabled: true }, 'Pause');
    var restartBtn = el('button', { type: 'button', class: 'btn btn-lg btn-gold', id: 'btn-timer-restart' }, 'Restart');
    var box = el('section', { class: 'timer', id: 'timer-box' },
      digits, unit, meter,
      el('div', { class: 'actions' },
        startBtn, pauseBtn, restartBtn,
        el('button', { type: 'button', class: 'btn btn-lg btn-teal', onclick: function () { go('#/menu'); } }, 'Round menu')),
      soundButton());

    var lastSecs = total;
    function paint(ms) {
      var secs = Math.max(0, Math.ceil(ms / 1000));
      fill.style.transform = 'scaleX(' + Math.max(0, Math.min(1, ms / (total * 1000))) + ')';
      digits.textContent = String(secs);
      box.classList.toggle('low', cd.mode === 'run' && secs <= 5);
      if (secs !== lastSecs && cd.mode === 'run' && ms <= 5000) beep(520, 70, 0);   // tick over the last five seconds
      lastSecs = secs;
    }
    function finish() {
      box.classList.remove('low');
      box.classList.add('done');
      digits.textContent = r.endText || 'TIME!';
      unit.hidden = true;
      fill.style.transform = 'scaleX(0)';
      startBtn.disabled = true; startBtn.textContent = 'Start';
      pauseBtn.disabled = true; pauseBtn.textContent = 'Pause';
      beep(880, 220, 0); beep(880, 220, .3); beep(1175, 600, .6);
    }
    var cd = makeCountdown(total, { onTick: paint, onDone: finish });
    timer.cd = cd;
    function idleLook() {
      box.classList.remove('low', 'done');
      unit.hidden = false;
      startBtn.disabled = false; startBtn.textContent = 'Start';
      pauseBtn.disabled = true; pauseBtn.textContent = 'Pause';
      lastSecs = total;
      digits.textContent = String(total); fill.style.transform = 'scaleX(1)';
    }
    function start() {
      if (cd.mode === 'run' || cd.mode === 'pause') return;
      cd.reset(); idleLook(); primeAudio();
      startBtn.disabled = true; startBtn.textContent = 'Running…'; pauseBtn.disabled = false;
      beep(660, 120, 0);
      cd.start();
    }
    function togglePause() {
      if (cd.mode === 'run') { cd.pause(); pauseBtn.textContent = 'Resume'; startBtn.textContent = 'Paused'; }
      else if (cd.mode === 'pause') { primeAudio(); cd.resume(); pauseBtn.textContent = 'Pause'; startBtn.textContent = 'Running…'; }
    }
    function restart() { cd.reset(); idleLook(); start(); }
    startBtn.addEventListener('click', start);
    pauseBtn.addEventListener('click', togglePause);
    restartBtn.addEventListener('click', restart);
    // Space on this screen: start, then pause / resume; after TIME! it starts a new countdown.
    timer.api = {
      space: function () { if (cd.mode === 'idle') start(); else if (cd.mode === 'done') restart(); else togglePause(); },
      restart: restart
    };
    paint(total * 1000);
    mount(box);
  }

  /* ---------------------------------------------------------------- charades cards */
  function chCfg() { return quiz.charades || { pointsPerTitle: 10, secondsPerTurn: 30, titles: [] }; }
  function chNames() { return chCfg().titles.map(function (t) { return t.title; }); }
  function chLevel(title) {
    var f = chCfg().titles.filter(function (t) { return t.title === title; })[0];
    return f ? f.difficulty : 'medium';
  }
  function chMatches(title) {
    var f = state.charades.filter, d = chLevel(title);
    return f === 'all' || (f === 'easy' && d === 'easy') || (f === 'mh' && d !== 'easy');
  }
  function chTeamName(i) { return (state.teams[i] && state.teams[i].name) || 'Team ' + (i + 1); }
  function shuffle(a) {
    var b = a.slice();
    for (var i = b.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), t = b[i]; b[i] = b[j]; b[j] = t; }
    return b;
  }

  /* Keep the saved deck in step with the title list (a title may have been edited or added since). */
  function chSync() {
    var ch = state.charades, names = chNames(), ok = {}, inOrder = {};
    names.forEach(function (n) { ok[n] = true; });
    ch.order = ch.order.filter(function (n) { return ok[n]; });
    ch.used = ch.used.filter(function (n) { return ok[n]; });
    ch.skipped = ch.skipped.filter(function (n) { return ok[n]; });
    if (ch.cur && !ok[ch.cur]) ch.cur = null;
    ch.order.forEach(function (n) { inOrder[n] = true; });
    var missing = names.filter(function (n) { return !inOrder[n]; });
    if (missing.length) ch.order = ch.order.concat(shuffle(missing));   // first call of a game: the whole deck, shuffled once
  }

  /* Next card. Order: cards not seen yet; then the skipped ones (reshuffled once, they sit at the back of the deck);
     when everything has been used, reshuffle the whole deck and start a new pass. Nothing repeats before that. */
  function chDraw() {
    var ch = state.charades, pick = null, seen = {};
    chSync();
    ch.used.concat(ch.skipped).forEach(function (n) { seen[n] = true; });
    if (ch.cur) seen[ch.cur] = true;
    for (var i = 0; i < ch.order.length && !pick; i++) {
      if (!seen[ch.order[i]] && chMatches(ch.order[i])) pick = ch.order[i];
    }
    if (!pick && ch.skipped.some(chMatches)) {
      if (!ch.skipShuffled) {
        ch.skipped = shuffle(ch.skipped);
        ch.skipShuffled = true;
        if (ch.skipped.length > 1 && ch.skipped[0] === ch.last) ch.skipped.push(ch.skipped.shift());   // not the card just skipped
      }
      pick = ch.skipped.filter(chMatches)[0];
      ch.skipped.splice(ch.skipped.indexOf(pick), 1);
    }
    if (!pick) {
      ch.order = shuffle(chNames());
      ch.used = []; ch.skipped = []; ch.skipShuffled = false; ch.cycle += 1;
      var pool = ch.order.filter(chMatches);
      pick = pool.filter(function (n) { return n !== ch.last; })[0] || pool[0];
    }
    ch.cur = pick || null;
    save();
    return ch.cur;
  }
  function chGot() {
    var ch = state.charades;
    if (!ch.cur) return;
    ch.skipped = ch.skipped.filter(function (n) { return n !== ch.cur; });
    ch.used.push(ch.cur); ch.tally += 1; ch.last = ch.cur; ch.cur = null;
    chDraw();
  }
  function chSkip() {
    var ch = state.charades;
    if (!ch.cur) return;
    ch.skipped = ch.skipped.filter(function (n) { return n !== ch.cur; }).concat(ch.cur);   // the back of the deck, not out of the game
    ch.last = ch.cur; ch.cur = null;
    chDraw();
  }
  function chPoints(tally) { return tally * chCfg().pointsPerTitle; }

  /* The turn is over (time ran out, or the host ended it). A card still on screen goes to the back of the deck. */
  function chFinishTurn(expired) {
    var ch = state.charades;
    if (ch.cur) { ch.skipped = ch.skipped.filter(function (n) { return n !== ch.cur; }).concat(ch.cur); ch.last = ch.cur; ch.cur = null; }
    ch.phase = 'result'; ch.expired = !!expired; ch.running = false; ch.left = 0; ch.endAt = 0;
    var t = ch.turns[ch.team] || { tally: 0, added: false, applied: 0 };
    t.tally = ch.tally; ch.turns[ch.team] = t;
    save();
  }
  /* Called before every render: a turn is only "running" while its screen is showing. If the page was refreshed or the host
     went to another screen, the turn comes back paused with the time that was left, and the card hidden. */
  function chSettle() {
    var ch = state.charades;
    if (ch.phase !== 'play' || !ch.running) return;
    var left = ch.endAt - Date.now();
    if (left <= 0) chFinishTurn(true);
    else { ch.running = false; ch.left = left; }
    save();
  }

  function chApplyEdit(team) {   // keep the scoreboard in step when a tally is edited after it was added
    var ch = state.charades, t = ch.turns[team];
    if (!t || !t.added) return;
    var pts = chPoints(t.tally);
    state.teams[team].score += pts - t.applied;
    t.applied = pts;
  }
  function chAddScore(team) {
    var t = state.charades.turns[team];
    if (!t || t.added) return;
    t.added = true; t.applied = chPoints(t.tally);
    state.teams[team].score += t.applied;
  }
  function chDoneTeams() {
    var ch = state.charades, out = [];
    for (var i = 0; i < state.n; i++) if (ch.turns[i]) out.push(i);
    return out;
  }

  function startCharades() {
    var ch = state.charades;
    if (ch.phase === 'idle') { ch.phase = 'pick'; ch.turns = {}; ch.team = -1; ch.tally = 0; ch.cur = null; }
    save();
    go('#/charades');
  }
  function askResetDeck() {
    confirmDialog('Reset charades deck?', 'Every title goes back into the deck and the deck is reshuffled. Scores already added stay as they are.', 'Reset deck')
      .then(function (ok) {
        if (!ok) return;
        var ch = state.charades;
        ch.order = []; ch.used = []; ch.skipped = []; ch.skipShuffled = false; ch.cycle = 1; ch.last = null; ch.cur = null;
        save();
        toast('Charades deck reset.');
        render();
      });
  }

  /* Round 4 intro extras: difficulty filter, deck status, quick timer, print, reset. */
  function charadesIntroControls() {
    var ch = state.charades, titles = chCfg().titles, n = { all: titles.length, easy: 0, mh: 0 };
    titles.forEach(function (t) { if (t.difficulty === 'easy') n.easy++; else n.mh++; });
    var status = el('p', { class: 'ch-status', id: 'ch-status' });
    function paintStatus() {
      status.textContent = 'Deck: ' + titles.length + ' cards · ' + ch.used.length + ' guessed · ' + ch.skipped.length + ' skipped' +
        (ch.cycle > 1 ? ' · pass ' + ch.cycle : '');
    }
    var group = el('fieldset', { class: 'ch-filter' }, el('legend', { text: 'Difficulty' }));
    [['all', 'All (' + n.all + ')'], ['easy', 'Easy only (' + n.easy + ')'], ['mh', 'Medium and Hard (' + n.mh + ')']].forEach(function (o) {
      var input = el('input', { type: 'radio', name: 'chfilter', value: o[0], onchange: function () { ch.filter = o[0]; save(); } });
      if (ch.filter === o[0]) input.checked = true;
      group.appendChild(el('label', null, input, el('span', { text: o[1] })));
    });
    paintStatus();
    return el('div', { class: 'ch-intro' }, group, status,
      el('div', { class: 'ch-intro-links' },
        el('button', { type: 'button', class: 'btn btn-ghost btn-sm', id: 'btn-quicktimer', onclick: function () { go('#/timer'); } }, 'Quick timer (no cards)'),
        el('a', { class: 'btn btn-ghost btn-sm', id: 'link-print', href: 'print.html', target: '_blank', rel: 'noopener' }, 'Print cards'),
        el('button', { type: 'button', class: 'btn btn-ghost btn-sm', id: 'btn-reset-deck', onclick: askResetDeck }, 'Reset charades deck')));
  }

  /* ---- the turn: pick -> ready -> play -> result -> (next team) -> summary ---- */
  function screenCharades() {
    var ch = state.charades;
    document.title = 'Charades · ' + quiz.title;   // never a card title, and no card ever goes in the URL
    if (ch.phase === 'idle') { ch.phase = 'pick'; ch.turns = {}; ch.team = -1; save(); }
    drawCharades(false);
  }

  function drawCharades(autostart) {
    var ch = state.charades;
    if (ch.phase !== 'play') stopTimer();
    switch (ch.phase) {
      case 'pick': drawPick(); break;
      case 'ready': drawReady(); break;
      case 'play': drawPlay(autostart); break;
      case 'result': drawResult(); break;
      default: drawSummary();
    }
    renderScoreboard();
  }

  function drawPick() {
    var ch = state.charades;
    setCrumb('Round 4 · Charades', 'Which team is acting?');
    var next = -1;
    for (var k = 0; k < state.n && next < 0; k++) if (!ch.turns[k]) next = k;
    var grid = el('div', { class: 'ch-picker' });
    for (var i = 0; i < state.n; i++) {
      (function (i) {
        var t = ch.turns[i];
        var b = el('button', { type: 'button', class: 'ch-teambtn' + (i === next ? ' next' : ''), id: 'pick-' + i,
          style: '--tcol:' + TEAM_COLORS[i], disabled: !!t,
          onclick: function () { ch.team = i; ch.tally = 0; ch.cur = null; ch.expired = false; ch.phase = 'ready'; save(); drawCharades(); } },
          el('span', { class: 'n', text: chTeamName(i) }),
          el('span', { class: 's', text: t ? '✓ ' + t.tally + ' guessed · ' + chPoints(t.tally) + ' pts' : (i === next ? 'Up next' : 'Tap to act') }));
        grid.appendChild(b);
      })(i);
    }
    mount(el('section', { class: 'ch-wrap' },
      el('h2', { class: 'ch-h', text: 'Which team is acting?' }), grid,
      el('div', { class: 'actions' },
        chDoneTeams().length ? el('button', { type: 'button', class: 'btn btn-gold', id: 'btn-finish-charades',
          onclick: function () { ch.phase = 'summary'; save(); drawCharades(); } }, 'Finish charades') : null,
        el('button', { type: 'button', class: 'btn btn-ghost', onclick: function () { go('#/round/4'); } }, 'Back'))));
  }

  function drawReady() {
    var ch = state.charades;
    setCrumb();   // no top bar: this screen is for the actor
    mount(el('section', { class: 'ch-wrap ch-ready' },
      el('div', { class: 'ch-teamname', id: 'ch-team', style: '--tcol:' + TEAM_COLORS[ch.team], text: chTeamName(ch.team) }),
      el('p', { class: 'ch-lookaway', text: 'Actor, take the device. Everyone else look away.' }),
      el('div', { class: 'actions' },
        el('button', { type: 'button', class: 'btn btn-lg btn-pink ch-big', id: 'btn-show-card', onclick: showFirstCard }, 'Show first card')),
      el('div', { class: 'actions' },
        el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: function () { ch.phase = 'pick'; ch.team = -1; save(); drawCharades(); } }, 'Pick a different team'))));
  }
  function showFirstCard() {
    var ch = state.charades;
    if (ch.phase !== 'ready') return;
    primeAudio();
    ch.tally = 0; ch.cur = null; chDraw();
    ch.phase = 'play'; ch.running = false; ch.left = chCfg().secondsPerTurn * 1000;
    save();
    drawCharades(true);
  }

  function drawPlay(autostart) {
    var ch = state.charades, total = chCfg().secondsPerTurn;
    setCrumb();
    if (!ch.cur) chDraw();   // e.g. the deck was reset while a turn was paused
    var digits = el('div', { class: 'digits', id: 'digits', role: 'timer', 'aria-live': 'off', text: String(total) });
    var fill = el('i'), meter = el('div', { class: 'meter', 'aria-hidden': 'true' }, fill);
    var cardEl = el('div', { class: 'ch-card', id: 'ch-card', 'aria-live': 'off' });
    var tallyEl = el('span', { id: 'ch-tally', text: String(ch.tally) });
    var gotBtn = el('button', { type: 'button', class: 'btn btn-lg btn-teal ch-act', id: 'btn-got', title: 'Got it (G)' }, 'Got it');
    var skipBtn = el('button', { type: 'button', class: 'btn btn-lg btn-coral ch-act', id: 'btn-skip', title: 'Skip (S)' }, 'Skip');
    var pauseBtn = el('button', { type: 'button', class: 'btn btn-gold', id: 'btn-pause', title: 'Pause / resume (Space)' }, 'Pause');
    var endBtn = el('button', { type: 'button', class: 'btn btn-navy', id: 'btn-end-turn' }, 'End turn');
    var box = el('section', { class: 'ch-play' },
      el('div', { class: 'ch-top' },
        el('span', { class: 'ch-who', style: '--tcol:' + TEAM_COLORS[ch.team], text: chTeamName(ch.team) }),
        el('span', { class: 'ch-count' }, 'Guessed: ', tallyEl),
        soundButton()),
      el('div', { class: 'ch-clock' }, digits, meter),
      cardEl,
      el('div', { class: 'ch-actions' }, gotBtn, skipBtn),
      el('div', { class: 'ch-actions2' }, pauseBtn, endBtn));

    function paintCard() {
      var paused = cd.mode !== 'run';
      cardEl.classList.toggle('paused', paused);
      cardEl.classList.toggle('long', !paused && !!ch.cur && ch.cur.length > 16);
      cardEl.classList.toggle('short', !paused && !!ch.cur && ch.cur.length <= 7);   // short titles can be even bigger
      cardEl.textContent = paused ? 'Paused' : (ch.cur || '');
      // size by the longest word, so a long word is shrunk to fit and is never broken across two lines
      cardEl.style.setProperty('--wl', String(Math.max.apply(null, (ch.cur || 'x').split(/\s+/).map(function (w) { return w.length; }))));
      gotBtn.disabled = skipBtn.disabled = paused;
      pauseBtn.textContent = paused ? 'Resume' : 'Pause';
      tallyEl.textContent = String(ch.tally);
    }
    function paintTime(ms) {
      var secs = Math.max(0, Math.ceil(ms / 1000));
      digits.textContent = String(secs);
      fill.style.transform = 'scaleX(' + Math.max(0, Math.min(1, ms / (total * 1000))) + ')';
      box.classList.toggle('low', cd.mode === 'run' && secs <= 5);   // red and pulsing for the last five seconds
    }
    var cd = makeCountdown(total, {
      onStart: function () { ch.endAt = cd.endAt; ch.running = true; save(); },
      onPause: function () { ch.running = false; ch.left = cd.left; ch.endAt = 0; save(); },
      onTick: paintTime,
      onDone: function () { beep(880, 450, 0); chFinishTurn(true); drawCharades(); }
    });
    timer.cd = cd;
    timer.api = { space: chPauseToggle, got: chGotUI, skip: chSkipUI };

    function chPauseToggle() {
      if (cd.mode === 'run') { cd.pause(); paintCard(); }
      else if (cd.mode === 'pause') { primeAudio(); cd.resume(); paintCard(); }
    }
    function chGotUI() { if (cd.mode !== 'run') return; chGot(); paintCard(); }
    function chSkipUI() { if (cd.mode !== 'run') return; chSkip(); paintCard(); }
    gotBtn.addEventListener('click', chGotUI);
    skipBtn.addEventListener('click', chSkipUI);
    pauseBtn.addEventListener('click', chPauseToggle);
    endBtn.addEventListener('click', function () {
      var wasRunning = cd.mode === 'run';
      if (wasRunning) { cd.pause(); paintCard(); }
      confirmDialog('End this turn?', 'The turn stops now. ' + ch.tally + (ch.tally === 1 ? ' title' : ' titles') + ' guessed so far.', 'End turn', { cancel: 'Keep going', okClass: 'btn-navy', focusOk: false })
        .then(function (yes) {
          if (yes) { cd.stop(); chFinishTurn(false); drawCharades(); }
          else if (wasRunning && timer.cd === cd) { cd.resume(); paintCard(); }
        });
    });

    mount(box);
    if (autostart) { cd.start(); paintCard(); }
    else { cd.setPaused(Math.max(1, ch.left)); paintCard(); }   // restored after a refresh or a visit elsewhere: paused, card hidden
  }

  function drawResult() {
    var ch = state.charades, t = ch.turns[ch.team];
    setCrumb('Round 4 · Charades', chTeamName(ch.team));
    var pp = chCfg().pointsPerTitle;
    var tallyEl = el('div', { class: 'ch-tally', id: 'ch-result-tally', text: String(ch.tally) });
    var ptsEl = el('div', { class: 'ch-pts', id: 'ch-result-points' });
    var addBtn = el('button', { type: 'button', class: 'btn btn-lg btn-teal', id: 'btn-add-score' });
    function paint() {
      tallyEl.textContent = String(ch.tally);
      ptsEl.textContent = '= ' + chPoints(ch.tally) + ' points (' + ch.tally + ' × ' + pp + ')';
      addBtn.disabled = !!t.added;
      addBtn.textContent = t.added ? 'Added ✓ (' + t.applied + ')' : 'Add to score';
      minus.disabled = ch.tally <= 0;
    }
    function edit(d) {
      ch.tally = Math.max(0, ch.tally + d); t.tally = ch.tally;
      chApplyEdit(ch.team);
      save(); paint(); renderScoreboard();
    }
    var minus = el('button', { type: 'button', class: 'btn btn-ghost ch-pm', id: 'btn-tally-minus', 'aria-label': 'Remove one from the tally', onclick: function () { edit(-1); } }, '−');
    var plus = el('button', { type: 'button', class: 'btn btn-ghost ch-pm', id: 'btn-tally-plus', 'aria-label': 'Add one to the tally', onclick: function () { edit(1); } }, '+');
    addBtn.addEventListener('click', function () { chAddScore(ch.team); save(); paint(); renderScoreboard(); });
    function next() {
      ch.tally = 0; ch.team = -1; ch.expired = false;
      ch.phase = chDoneTeams().length >= state.n ? 'summary' : 'pick';
      save(); drawCharades();
    }
    mount(el('section', { class: 'ch-wrap ch-result' },
      el('div', { class: 'ch-time', id: 'ch-time', text: ch.expired ? 'TIME!' : 'TURN ENDED' }),
      el('div', { class: 'ch-who ch-who-lg', style: '--tcol:' + TEAM_COLORS[ch.team], text: chTeamName(ch.team) }),
      el('div', { class: 'ch-editrow' }, minus, el('div', { class: 'ch-tallybox' }, tallyEl, el('div', { class: 'ch-cap', text: ch.tally === 1 ? 'title guessed' : 'titles guessed' })), plus),
      el('div', { class: 'ch-editlabel', text: 'Edit tally' }),
      ptsEl,
      el('div', { class: 'actions' },
        addBtn,
        el('button', { type: 'button', class: 'btn btn-lg', id: 'btn-next-team', onclick: function () {
          if (t.added) return next();
          confirmDialog('Points not added yet', 'Add ' + chPoints(ch.tally) + ' points to ' + chTeamName(ch.team) + ' first?', 'Add and continue', { cancel: 'Skip them', okClass: 'btn-teal', focusOk: true })
            .then(function (yes) { if (yes) { chAddScore(ch.team); save(); } next(); });
        } }, 'Next team'))));
    paint();
  }

  function drawSummary() {
    var ch = state.charades, pp = chCfg().pointsPerTitle;
    setCrumb('Round 4 · Charades', 'Charades summary');
    var body = el('tbody');
    var done = chDoneTeams(), total = 0, pending = false;
    for (var i = 0; i < state.n; i++) {
      var t = ch.turns[i];
      if (t) { total += chPoints(t.tally); if (!t.added) pending = true; }
      body.appendChild(el('tr', null,
        el('th', { scope: 'row', style: '--tcol:' + TEAM_COLORS[i], text: chTeamName(i) }),
        el('td', { text: t ? String(t.tally) : '—' }),
        el('td', { class: 'pts', text: t ? String(chPoints(t.tally)) : '—' }),
        el('td', { text: t ? (t.added ? 'on the scoreboard' : 'not added') : 'did not play' })));
    }
    var addAll = el('button', { type: 'button', class: 'btn btn-teal', id: 'btn-add-all', disabled: !pending,
      onclick: function () { done.forEach(chAddScore); save(); drawCharades(); } }, 'Add all to scoreboard');
    mount(el('section', { class: 'ch-wrap ch-summary' },
      el('h2', { class: 'ch-h', text: 'Charades summary' }),
      el('div', { class: 'card' }, el('table', { class: 'ch-table' },
        el('thead', null, el('tr', null, el('th', { text: 'Team' }), el('th', { text: 'Titles' }), el('th', { text: 'Points (×' + pp + ')' }), el('th', { text: '' }))), body)),
      el('p', { class: 'ch-total', text: 'Charades points handed out: ' + total }),
      el('div', { class: 'actions' },
        addAll,
        el('button', { type: 'button', class: 'btn btn-lg btn-teal', id: 'btn-charades-menu', onclick: function () {
          ch.turns = {}; ch.phase = 'idle'; ch.team = -1; ch.tally = 0; ch.expired = false; save(); go('#/menu');
        } }, 'Back to Round Menu'))));
  }

  /* ---------------------------------------------------------------- end screen */
  function screenEnd() {
    setCrumb('End', quiz.end.title);
    document.title = quiz.end.title + ' · ' + quiz.title;
    var teams = state.teams.slice(0, state.n).map(function (t, i) { return { name: t.name || 'Team ' + (i + 1), score: t.score, i: i }; });
    teams.sort(function (a, b) { return b.score - a.score; });
    var top = teams[0].score;
    var winners = teams.filter(function (t) { return t.score === top; });
    var allTied = teams.length > 1 && winners.length === teams.length;
    var list = el('ol', { class: 'podium' });
    teams.forEach(function (t) {
      var isWin = t.score === top && !allTied;
      list.appendChild(el('li', { class: isWin ? 'win' : '' },
        el('span', { text: (isWin ? '★ ' : '') + t.name }),
        el('span', { class: 'pts', text: String(t.score) })));
    });
    var headline = allTied ? 'It’s all tied at ' + top + '!' :
      winners.length === 1 ? winners[0].name + ' wins!' : 'It’s a tie: ' + winners.map(function (w) { return w.name; }).join(' & ');
    var node = el('section', { class: 'end' },
      el('h2', { text: quiz.end.title }),
      el('div', { class: 'card' },
        el('h3', { style: 'font-size:1.6rem;margin-bottom:1rem;color:var(--maroon)', text: top > 0 || teams.length ? headline : '' }),
        list),
      el('div', { class: 'thanks', text: quiz.end.text }),
      el('div', { class: 'actions' },
        el('button', { type: 'button', class: 'btn btn-teal', onclick: function () { go('#/menu'); } }, 'Back to menu'),
        el('button', { type: 'button', class: 'btn btn-ghost', onclick: askReset }, 'Reset game')));
    mount(node);
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) confetti();
  }

  function confetti() {
    var box = el('div', { class: 'confetti', 'aria-hidden': 'true' });
    var cols = ['#e95f5c', '#f2b84b', '#0f6f75', '#d94f70', '#b9a7d8', '#9bc9b7'];
    for (var i = 0; i < 60; i++) {
      box.appendChild(el('i', { style: 'left:' + Math.random() * 100 + '%;background:' + cols[i % cols.length] +
        ';animation-duration:' + (2.5 + Math.random() * 3) + 's;animation-delay:' + Math.random() * 1.5 + 's' }));
    }
    document.body.appendChild(box);
    setTimeout(function () { box.remove(); }, 7500);
  }

  /* ---------------------------------------------------------------- render */
  function render() {
    if (!quiz || !state) return;   // a hash change can arrive before quiz.json has loaded
    stopTimer();
    chSettle();   // a charades turn only runs while its screen is showing
    hintUI = null;
    var old = document.querySelector('.confetti');
    if (old) old.remove();
    var r = parseHash();
    // Leaving a clue by any route (Back, Esc, M, Menu, browser Back) finishes it: the next team picks.
    if (state.run && !((r.name === 'clue' || r.name === 'answer') && r.arg === state.run.id)) {
      if (state.run.advance) state.turn = (state.run.asker + 1) % state.n;
      state.run = null;
      save();
    }
    var info;
    switch (r.name) {
      case 'menu': screenMenu(); break;
      case 'host': screenHost(); break;
      case 'round': var rr = roundById(parseInt(r.arg, 10)); rr ? screenIntro(rr) : screenMenu(); break;
      case 'board': var rb = roundById(parseInt(r.arg, 10)); rb && rb.type === 'timer' ? (quiz.charades ? go('#/round/' + rb.id) : screenTimer()) : rb ? screenBoard(rb) : screenMenu(); break;
      case 'clue': info = index[r.arg]; info ? screenClue(info) : screenMenu(); break;
      case 'answer': info = index[r.arg]; info ? screenAnswer(info) : screenMenu(); break;
      case 'timer': screenTimer(); break;
      case 'charades': screenCharades(); break;
      case 'end': screenEnd(); break;
      default: screenTitle();
    }
    renderScoreboard();
    $screen.focus({ preventScroll: true });
  }

  /* ---------------------------------------------------------------- keyboard */
  function goBack() {
    var r = parseHash();
    switch (r.name) {
      case 'clue': case 'answer': return backToBoard();
      case 'charades': return go('#/round/4');
      case 'board': case 'round': case 'timer': case 'host': case 'end': return go('#/menu');
      case 'menu': return go('#/title');
    }
  }

  document.addEventListener('keydown', function (e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (anyDialogOpen()) return;   // a dialog is in front: keys must not act on the page behind it
    var tag = (e.target && e.target.tagName) || '';
    var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (typing) return;
    var r = parseHash();
    var key = e.key;

    if (key === '?' && r.name === 'title') { e.preventDefault(); return openHelp(); }
    if (key === 'Escape') { e.preventDefault(); return goBack(); }
    if (key === 'm' || key === 'M') { if (r.name !== 'title') { e.preventDefault(); go('#/menu'); } return; }
    if (key === ' ' || key === 'Enter' || key === 'Spacebar') {
      if (r.name === 'clue') { e.preventDefault(); return go('#/answer/' + r.arg); }
      if (r.name === 'timer' && timer.api) { e.preventDefault(); return timer.api.space(); }
      if (r.name === 'charades') {   // Space = start / pause (Enter keeps its normal button behaviour)
        if (key === 'Enter') return;
        e.preventDefault();
        var cph = state.charades.phase;
        if (cph === 'ready') return showFirstCard();
        if (cph === 'play' && timer.api) return timer.api.space();
        return;
      }
      if (r.name === 'title') { if (tag !== 'BUTTON') { e.preventDefault(); go('#/menu'); } return; }
      if (r.name === 'round' && tag !== 'BUTTON') {
        e.preventDefault();
        var rd = roundById(parseInt(r.arg, 10));
        return go(rd && rd.type === 'timer' ? '#/timer' : '#/board/' + r.arg);
      }
      return;
    }
    if ((key === 'h' || key === 'H') && r.name === 'clue') { e.preventDefault(); return revealHint(); }
    if ((key === 'r' || key === 'R') && r.name === 'timer' && timer.api) { e.preventDefault(); return timer.api.restart(); }
    if (r.name === 'charades' && state.charades.phase === 'play' && timer.api) {   // host shortcuts on a laptop
      if (key === 'g' || key === 'G') { e.preventDefault(); return timer.api.got(); }
      if (key === 's' || key === 'S') { e.preventDefault(); return timer.api.skip(); }
    }
  });
  // Stop Space on a focused button from also firing a click after we've handled it.
  document.addEventListener('keyup', function (e) {
    if ((e.key === ' ' || e.key === 'Spacebar') && ['clue', 'timer', 'charades'].indexOf(parseHash().name) >= 0 &&
      e.target && e.target.tagName === 'BUTTON' && !e.target.closest('dialog')) e.preventDefault();
  });

  document.getElementById('btn-menu').addEventListener('click', function () { go('#/menu'); });
  if ($help) {
    var closeHelp = function () { $help.close(); };
    document.getElementById('help-close').addEventListener('click', closeHelp);
    document.getElementById('help-x').addEventListener('click', closeHelp);
    // a click outside the box (on the dimmed backdrop) closes it too
    $help.addEventListener('click', function (e) {
      var r = $help.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeHelp();
    });
    $help.addEventListener('close', function () {
      var b = document.getElementById('btn-help');
      if (b) b.focus();   // give focus back to the ? button
    });
  }
  window.addEventListener('hashchange', render);
  window.addEventListener('resize', function () { document.documentElement.style.setProperty('--sb-h', $sb.offsetHeight + 'px'); });
  // Keep two open tabs from silently overwriting each other's scores.
  window.addEventListener('storage', function (e) { if (e.key === STORE_KEY) { state = loadState(); render(); } });

  /* ---------------------------------------------------------------- boot */
  fetch('quiz.json').then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }).then(function (data) {
    quiz = data;
    buildIndex();
    state = loadState();
    render();
  }).catch(function (err) {
    $screen.replaceChildren(el('div', { class: 'card', style: 'max-width:40rem;margin:2rem auto' },
      el('h2', { text: 'Could not load the quiz' }),
      el('p', { text: 'quiz.json failed to load (' + err.message + '). If you opened index.html straight from disk, serve the folder instead, e.g. "python3 -m http.server" and visit http://localhost:8000/.' })));
  });
})();
