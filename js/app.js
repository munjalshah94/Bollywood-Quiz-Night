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

  var quiz = null;
  var index = {};      // clue id -> { round, clue, cat, label }
  var state = null;
  var timer = { mode: 'idle', end: 0, handle: 0, audio: null };

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
      step: 'auto', sbOpen: prev ? prev.sbOpen : window.innerWidth >= 760, sound: prev ? prev.sound : true
    };
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
    if (route === 'title') { $sb.hidden = true; document.documentElement.style.setProperty('--sb-h', '0px'); return; }
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

  function screenTitle() {
    setCrumb();
    document.title = quiz.title;
    var used = Object.keys(state.used).length;
    var scored = state.teams.slice(0, state.n).some(function (t) { return t.score; });
    var bg = quiz.titleImage.src;
    var node = el('section', { class: 'title-screen', style: 'background-image:url("' + bg + '")' },
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
    var start = r.type === 'timer'
      ? el('button', { type: 'button', class: 'btn btn-lg btn-pink', id: 'btn-startround', onclick: function () { go('#/timer'); } }, 'Start ' + r.seconds + ' sec timer')
      : el('button', { type: 'button', class: 'btn btn-lg btn-teal', id: 'btn-startround', onclick: function () { go('#/board/' + r.id); } }, 'Start round');
    var node = el('section', { class: 'intro' },
      el('div', { class: 'big-num', text: String(r.id) }),
      el('h2', { text: r.introTitle || r.name }),
      rulesNode,
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
  function beep(freq, ms, when) {
    if (!state.sound) return;
    try {
      var ctx = timer.audio || (timer.audio = new (window.AudioContext || window.webkitAudioContext)());
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

  function stopTimer() { if (timer.handle) { clearInterval(timer.handle); timer.handle = 0; } }

  function screenTimer() {
    var r = roundById(4);
    var total = r.seconds;
    stopTimer();
    timer.mode = 'idle';
    setCrumb('Round 4', 'Charades timer');
    document.title = 'Charades timer · ' + quiz.title;

    var digits = el('div', { class: 'digits', id: 'digits', role: 'timer', 'aria-live': 'off', text: String(total) });
    var unit = el('div', { class: 'unit', id: 'unit', text: r.unitLabel || 'seconds remaining' });
    var fill = el('i');
    var meter = el('div', { class: 'meter', 'aria-hidden': 'true' }, fill);
    var startBtn = el('button', { type: 'button', class: 'btn btn-lg btn-pink', id: 'btn-timer-start' }, 'Start');
    var restartBtn = el('button', { type: 'button', class: 'btn btn-lg btn-gold', id: 'btn-timer-restart' }, 'Restart');
    var soundBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', id: 'btn-sound',
      onclick: function () { state.sound = !state.sound; save(); soundBtn.textContent = state.sound ? 'Sound: on' : 'Sound: off'; } },
      state.sound ? 'Sound: on' : 'Sound: off');
    var box = el('section', { class: 'timer', id: 'timer-box' },
      el('div', { class: 'timer-rules', text: r.rules ? trimEnd(r.rules).split('\n')[0] : '' }),
      digits, unit, meter,
      el('div', { class: 'actions' },
        startBtn, restartBtn,
        el('button', { type: 'button', class: 'btn btn-lg btn-teal', onclick: function () { go('#/menu'); } }, 'Round menu')),
      soundBtn);

    function paint(remainingMs) {
      var secs = Math.max(0, Math.ceil(remainingMs / 1000));
      fill.style.transform = 'scaleX(' + Math.max(0, Math.min(1, remainingMs / (total * 1000))) + ')';
      if (timer.mode === 'done') return;
      digits.textContent = String(secs);
      box.classList.toggle('low', timer.mode === 'run' && secs <= 5);
    }
    function reset() {
      stopTimer();
      timer.mode = 'idle';
      box.classList.remove('low', 'done');
      digits.textContent = String(total);
      unit.hidden = false;
      startBtn.disabled = false;
      startBtn.textContent = 'Start';
      paint(total * 1000);
    }
    function finish() {
      stopTimer();
      timer.mode = 'done';
      box.classList.remove('low');
      box.classList.add('done');
      digits.textContent = r.endText || 'TIME!';
      unit.hidden = true;
      fill.style.transform = 'scaleX(0)';
      startBtn.disabled = true;
      startBtn.textContent = 'Start';
      beep(880, 220, 0); beep(880, 220, .3); beep(1175, 600, .6);
    }
    function start() {
      if (timer.mode === 'run') return;
      reset();
      timer.mode = 'run';
      startBtn.disabled = true;
      startBtn.textContent = 'Running…';
      timer.end = performance.now() + total * 1000;
      beep(660, 120, 0);
      timer.handle = setInterval(function () {
        var left = timer.end - performance.now();
        if (left <= 0) return finish();
        var before = digits.textContent;
        paint(left);
        if (digits.textContent !== before && left <= 5000) beep(520, 70, 0);
      }, 100);
    }
    startBtn.addEventListener('click', start);
    restartBtn.addEventListener('click', function () { reset(); start(); });
    timer.api = { start: start, reset: reset };
    paint(total * 1000);
    mount(box);
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
      case 'board': var rb = roundById(parseInt(r.arg, 10)); rb && rb.type === 'timer' ? screenTimer() : rb ? screenBoard(rb) : screenMenu(); break;
      case 'clue': info = index[r.arg]; info ? screenClue(info) : screenMenu(); break;
      case 'answer': info = index[r.arg]; info ? screenAnswer(info) : screenMenu(); break;
      case 'timer': screenTimer(); break;
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
      case 'board': case 'round': case 'timer': case 'host': case 'end': return go('#/menu');
      case 'menu': return go('#/title');
    }
  }

  document.addEventListener('keydown', function (e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if ($dlg.open) return;
    var tag = (e.target && e.target.tagName) || '';
    var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (typing) return;
    var r = parseHash();
    var key = e.key;

    if (key === 'Escape') { e.preventDefault(); return goBack(); }
    if (key === 'm' || key === 'M') { if (r.name !== 'title') { e.preventDefault(); go('#/menu'); } return; }
    if (key === ' ' || key === 'Enter' || key === 'Spacebar') {
      if (r.name === 'clue') { e.preventDefault(); return go('#/answer/' + r.arg); }
      if (r.name === 'timer' && timer.api) {
        e.preventDefault();
        if (timer.mode === 'idle') timer.api.start();
        else if (timer.mode === 'done') { timer.api.reset(); timer.api.start(); }
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
    if ((key === 'r' || key === 'R') && r.name === 'timer' && timer.api) { e.preventDefault(); timer.api.reset(); timer.api.start(); }
  });
  // Stop Space on a focused button from also firing a click after we've handled it.
  document.addEventListener('keyup', function (e) {
    if ((e.key === ' ' || e.key === 'Spacebar') && ['clue', 'timer'].indexOf(parseHash().name) >= 0 &&
      e.target && e.target.tagName === 'BUTTON' && !$dlg.contains(e.target)) e.preventDefault();
  });

  document.getElementById('btn-menu').addEventListener('click', function () { go('#/menu'); });
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
