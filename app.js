'use strict';

/* ============================================================
   QBank — offline question bank for personal study
   Questions: questions.json (bundled) or a file loaded in Settings
   Progress:  IndexedDB on the device (export/import as JSON)
   ============================================================ */

const APP_VERSION = '0.1.0';
const SECONDS_PER_Q = 90;                    // timed mode budget per question
const SRS_DAYS = [3, 7, 14, 30, 60, 120];    // review intervals after consecutive correct answers
const DAY_MS = 86400000;
const POOLS = [
  ['unused', 'Unused'],
  ['all', 'All'],
  ['incorrect', 'Incorrect'],
  ['flagged', 'Flagged'],
  ['due', 'Due'],
];

/* ---------------- IndexedDB ---------------- */

const DB = (() => {
  let dbPromise;
  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('qbank', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('progress')) db.createObjectStore('progress', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }
  async function run(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      let result;
      const req = fn(tx.objectStore(store));
      if (req) req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  return {
    get: (store, key) => run(store, 'readonly', s => s.get(key)),
    getAll: store => run(store, 'readonly', s => s.getAll()),
    put: (store, value, key) => run(store, 'readwrite', s => (key === undefined ? s.put(value) : s.put(value, key))),
    del: (store, key) => run(store, 'readwrite', s => s.delete(key)),
    clear: store => run(store, 'readwrite', s => s.clear()),
    putMany: (store, values) => run(store, 'readwrite', s => { values.forEach(v => s.put(v)); }),
  };
})();

/* ---------------- State ---------------- */

const state = {
  bank: null,              // { title, version, questions: [...] }
  bankSource: 'bundled',   // 'bundled' | 'imported'
  byId: new Map(),
  progress: new Map(),     // id -> progress record
  session: null,           // current or last block
  view: 'home',
  home: { mode: 'tutor', pool: 'unused', systems: new Set(), count: 10 },
  timerId: null,
};

const $app = document.getElementById('app');

/* ---------------- Helpers ---------------- */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rich = t => String(t ?? '').trim().split(/\n{2,}/).filter(Boolean)
  .map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
const pct = (n, d) => (d ? Math.round((100 * n) / d) + '%' : '—');
const mmss = sec => { sec = Math.max(0, Math.round(sec)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

let toastTimer;
function toast(msg, ms = 2600) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function fmtSource(src) {
  if (!src) return '';
  if (typeof src === 'string') return src;
  return [src.book, src.chapter && `Ch. ${src.chapter}`, src.section, src.page && `p. ${src.page}`].filter(Boolean).join(' · ');
}

/* ---------------- Question bank ---------------- */

function normalizeBank(raw) {
  const list = Array.isArray(raw) ? raw : raw && raw.questions;
  if (!Array.isArray(list)) throw new Error('No "questions" array found.');
  const seen = new Set();
  const questions = [];
  let skipped = 0;
  for (const q of list) {
    const id = q && q.id != null ? String(q.id) : '';
    if (!id || !q.stem || !Array.isArray(q.options) || q.options.length < 2 || seen.has(id)) { skipped++; continue; }
    const options = q.options.map((o, i) => (typeof o === 'string'
      ? { label: String.fromCharCode(65 + i), text: o, explanation: '' }
      : { label: String(o.label || String.fromCharCode(65 + i)), text: o.text ?? '', explanation: o.explanation ?? '' }));
    const answer = String(q.answer ?? '');
    if (!options.some(o => o.label === answer)) { skipped++; continue; }
    seen.add(id);
    questions.push({
      id,
      system: q.system || 'General',
      topic: q.topic || '',
      stem: q.stem,
      lead: q.lead || '',
      options,
      answer,
      explanation: q.explanation || '',
      source: q.source || null,
      tags: Array.isArray(q.tags) ? q.tags : [],
    });
  }
  if (!questions.length) throw new Error('No valid questions found.');
  return {
    title: (!Array.isArray(raw) && raw.title) || 'QBank',
    version: (!Array.isArray(raw) && raw.version) || '',
    questions,
    skipped,
  };
}

function setBank(bank, source) {
  state.bank = bank;
  state.bankSource = source;
  state.byId = new Map(bank.questions.map(q => [q.id, q]));
}

async function loadBank() {
  const custom = await DB.get('meta', 'customBank');
  if (custom) { setBank(custom, 'imported'); return; }
  const res = await fetch('./questions.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('Could not load questions.json');
  setBank(normalizeBank(await res.json()), 'bundled');
}

const systemsList = () => [...new Set(state.bank.questions.map(q => q.system))].sort((a, b) => a.localeCompare(b));

/* ---------------- Progress + spaced repetition ---------------- */

function progressFor(id) {
  let p = state.progress.get(id);
  if (!p) {
    p = { id, attempts: 0, correct: 0, flagged: false, step: -1, due: 0, lastResult: null, lastSeen: 0, history: [] };
    state.progress.set(id, p);
  }
  return p;
}

async function recordAnswer(id, choice, ok) {
  const p = progressFor(id);
  const now = Date.now();
  p.attempts += 1;
  if (ok) p.correct += 1;
  p.lastResult = ok ? 'correct' : 'incorrect';
  p.lastSeen = now;
  if (ok) {
    p.step = Math.min(p.step + 1, SRS_DAYS.length - 1);
    p.due = now + SRS_DAYS[p.step] * DAY_MS;
  } else {
    p.step = -1;
    p.due = now + DAY_MS;
  }
  p.history = [...p.history, { t: now, c: choice, ok }].slice(-20);
  await DB.put('progress', p);
}

function inPool(q, pool, now) {
  const p = state.progress.get(q.id);
  switch (pool) {
    case 'all': return true;
    case 'unused': return !p || !p.attempts;
    case 'incorrect': return !!p && p.lastResult === 'incorrect';
    case 'flagged': return !!p && p.flagged;
    case 'due': return !!p && p.attempts > 0 && p.due <= now;
    default: return true;
  }
}

function candidates() {
  const { pool, systems } = state.home;
  const now = Date.now();
  return state.bank.questions.filter(q => inPool(q, pool, now) && (!systems.size || systems.has(q.system)));
}

function overallStats() {
  const now = Date.now();
  let used = 0, latestCorrect = 0, due = 0, flagged = 0;
  for (const q of state.bank.questions) {
    const p = state.progress.get(q.id);
    if (!p) continue;
    if (p.flagged) flagged++;
    if (p.attempts) {
      used++;
      if (p.lastResult === 'correct') latestCorrect++;
      if (p.due <= now) due++;
    }
  }
  return { total: state.bank.questions.length, used, latestCorrect, due, flagged };
}

/* ---------------- Persistence ---------------- */

const saveHome = () => DB.put('meta', { ...state.home, systems: [...state.home.systems] }, 'home').catch(() => {});
const saveSession = () => (state.session ? DB.put('meta', state.session, 'session') : DB.del('meta', 'session')).catch(() => {});

/* ---------------- Navigation + timer ---------------- */

function go(view, { keepScroll = false } = {}) {
  stopTimer();
  state.view = view;
  render();
  if (!keepScroll) window.scrollTo(0, 0);
  const s = state.session;
  if (view === 'quiz' && s && s.mode === 'timed' && !s.finished) startTimer();
}

function startTimer() {
  stopTimer();
  let ticks = 0;
  state.timerId = setInterval(() => {
    const s = state.session;
    if (!s || s.finished) return stopTimer();
    s.remaining -= 1;
    ticks++;
    const el = document.getElementById('timer');
    if (el) {
      el.textContent = mmss(s.remaining);
      el.classList.toggle('low', s.remaining <= 60);
    }
    if (ticks % 5 === 0) saveSession();
    if (s.remaining <= 0) {
      stopTimer();
      toast('Time is up');
      finishBlock();
    }
  }, 1000);
}

function stopTimer() {
  if (state.timerId) clearInterval(state.timerId);
  state.timerId = null;
}

/* ---------------- Views ---------------- */

function render() {
  const views = { home: viewHome, quiz: viewQuiz, results: viewResults, stats: viewStats, settings: viewSettings };
  if ((state.view === 'quiz' || state.view === 'results') && !state.session) state.view = 'home';
  $app.innerHTML = (views[state.view] || viewHome)();
  if (state.view === 'settings') fillStorageInfo();
}

function viewHome() {
  const st = overallStats();
  const h = state.home;
  const now = Date.now();
  const s = state.session;

  const poolCounts = Object.fromEntries(POOLS.map(([k]) => [k, state.bank.questions.filter(q => inPool(q, k, now)).length]));
  const sysChips = systemsList().map(sys => {
    const n = state.bank.questions.filter(q => q.system === sys && inPool(q, h.pool, now)).length;
    return `<button class="chip ${h.systems.has(sys) ? 'on' : ''}" data-action="sys" data-v="${esc(sys)}">${esc(sys)}<span class="ct">${n}</span></button>`;
  }).join('');
  const avail = candidates().length;
  const count = Math.min(h.count, Math.max(avail, 1));

  let sessionCard = '';
  if (s && !s.finished) {
    const answered = Object.keys(s.answers).length;
    sessionCard = `
      <section class="card">
        <h2>Block in progress</h2>
        <p>${s.mode === 'timed' ? 'Timed' : 'Tutor'} · ${answered} of ${s.ids.length} answered${s.mode === 'timed' ? ` · ${mmss(s.remaining)} left` : ''}</p>
        <div class="btn-row"><button class="btn" data-action="discard">Discard</button><button class="btn primary" data-action="resume">Resume</button></div>
      </section>`;
  } else if (s && s.finished) {
    sessionCard = `
      <section class="card">
        <div class="btn-row"><button class="btn" data-action="go" data-view="results">Review last block</button></div>
      </section>`;
  }

  return `
    <header class="top">
      <h1>${esc(state.bank.title)}</h1>
      <div class="top-right">
        <button class="icon-btn" data-action="go" data-view="stats" aria-label="Performance">📊</button>
        <button class="icon-btn" data-action="go" data-view="settings" aria-label="Settings">⚙️</button>
      </div>
    </header>

    <section class="card">
      <div class="stat-grid">
        <div><div class="num">${st.used}/${st.total}</div><div class="lab">Used</div></div>
        <div><div class="num">${pct(st.latestCorrect, st.used)}</div><div class="lab">Correct</div></div>
        <div><div class="num">${st.due}</div><div class="lab">Due</div></div>
      </div>
    </section>

    ${sessionCard}

    <section class="card">
      <h2>Mode</h2>
      <div class="seg">
        <button class="${h.mode === 'tutor' ? 'on' : ''}" data-action="mode" data-v="tutor">Tutor</button>
        <button class="${h.mode === 'timed' ? 'on' : ''}" data-action="mode" data-v="timed">Timed</button>
      </div>
      <p class="small muted" style="margin-top:8px">${h.mode === 'tutor'
        ? 'Answer and explanation after each question.'
        : `${SECONDS_PER_Q} seconds per question, explanations at the end.`}</p>

      <h2>Questions</h2>
      <div class="chips">
        ${POOLS.map(([k, label]) => `<button class="chip ${h.pool === k ? 'on' : ''}" data-action="pool" data-v="${k}">${label}<span class="ct">${poolCounts[k]}</span></button>`).join('')}
      </div>

      <h2>Systems</h2>
      <div class="chips">
        <button class="chip ${h.systems.size ? '' : 'on'}" data-action="sys" data-v="*">All systems</button>
        ${sysChips}
      </div>

      <h2>Number of questions</h2>
      <div class="stepper">
        <button data-action="count" data-d="-1" aria-label="Fewer">−</button>
        <span class="val">${avail ? count : 0}</span>
        <button data-action="count" data-d="1" aria-label="More">+</button>
        <span class="small muted">of ${avail} available</span>
      </div>

      <button class="btn primary block" data-action="start" ${avail ? '' : 'disabled'}>
        ${avail ? `Start block` : 'No questions match'}
      </button>
    </section>`;
}

function viewQuiz() {
  const s = state.session;
  const n = s.ids.length;
  const id = s.ids[s.idx];
  const q = state.byId.get(id);
  const chosen = s.answers[id];
  const feedback = s.finished || (s.mode === 'tutor' && s.submitted[id]);
  const flagged = !!(state.progress.get(id) || {}).flagged;

  const opts = q.options.map(o => {
    let cls = 'opt';
    if (chosen === o.label) cls += ' selected';
    if (feedback) {
      if (o.label === q.answer) cls += ' correct';
      else if (chosen === o.label) cls += ' wrong';
      else cls += ' dim';
    }
    const exp = feedback && o.explanation ? `<div class="opt-exp">${rich(o.explanation)}</div>` : '';
    return `<button class="${cls}" data-action="choose" data-label="${esc(o.label)}" ${feedback ? 'disabled' : ''}>
        <span class="lbl">${esc(o.label)}</span><span class="txt">${esc(o.text)}</span>
      </button>${exp}`;
  }).join('');

  let verdict = '';
  let explanation = '';
  if (feedback) {
    const correctText = q.options.find(o => o.label === q.answer).text;
    if (!chosen) verdict = `<div class="verdict skip">Not answered · Answer: ${esc(q.answer)}. ${esc(correctText)}</div>`;
    else if (chosen === q.answer) verdict = `<div class="verdict ok">Correct</div>`;
    else verdict = `<div class="verdict bad">Incorrect · Answer: ${esc(q.answer)}. ${esc(correctText)}</div>`;
    const src = fmtSource(q.source);
    explanation = `
      <section class="card exp">
        <h3>Explanation</h3>
        ${rich(q.explanation) || '<p class="muted">No explanation provided.</p>'}
        ${src ? `<div class="src">Source: ${esc(src)}</div>` : ''}
      </section>`;
  }

  let primary;
  if (s.finished) {
    primary = s.idx < n - 1
      ? `<button class="btn primary" data-action="next">Next</button>`
      : `<button class="btn primary" data-action="go" data-view="results">Results</button>`;
  } else if (s.mode === 'tutor') {
    if (!feedback) primary = `<button class="btn primary" data-action="submit" ${chosen ? '' : 'disabled'}>Submit</button>`;
    else primary = s.idx < n - 1
      ? `<button class="btn primary" data-action="next">Next</button>`
      : `<button class="btn primary" data-action="finish">Finish block</button>`;
  } else {
    primary = s.idx < n - 1
      ? `<button class="btn primary" data-action="next">Next</button>`
      : `<button class="btn primary" data-action="finish">End block</button>`;
  }

  const timer = s.mode === 'timed' && !s.finished
    ? `<span id="timer" class="timer ${s.remaining <= 60 ? 'low' : ''}">${mmss(s.remaining)}</span>` : '';
  const endBtn = s.mode === 'timed' && !s.finished
    ? `<button class="link-btn" data-action="finish">End</button>` : '';

  return `
    <header class="top">
      <button class="link-btn" data-action="exit">‹ ${s.finished ? 'Results' : 'Home'}</button>
      <span class="center">${s.idx + 1} / ${n}</span>
      <div class="top-right">
        ${timer}
        <button class="icon-btn ${flagged ? 'on' : ''}" data-action="flag" aria-label="${flagged ? 'Unflag' : 'Flag'} question">${flagged ? '⚑' : '⚐'}</button>
        ${endBtn}
      </div>
    </header>
    <div class="progress"><div style="width:${((s.idx + 1) / n) * 100}%"></div></div>

    <div class="qmeta">${esc(q.system)}${q.topic ? ' · ' + esc(q.topic) : ''}</div>
    <div class="stem">${rich(q.stem)}</div>
    ${q.lead ? `<div class="lead">${esc(q.lead)}</div>` : ''}
    <div class="opts">${opts}</div>
    ${verdict}
    ${explanation}

    <nav class="bar">
      <button class="btn" data-action="prev" ${s.idx === 0 ? 'disabled' : ''}>Prev</button>
      ${primary}
    </nav>`;
}

function viewResults() {
  const s = state.session;
  let correct = 0, skipped = 0;
  const rows = s.ids.map((id, i) => {
    const q = state.byId.get(id);
    const a = s.answers[id];
    let status = 'skip', mark = '–';
    if (a) {
      if (a === q.answer) { status = 'ok'; mark = '✓'; correct++; } else { status = 'bad'; mark = '✗'; }
    } else skipped++;
    return `<button class="row" data-action="review" data-i="${i}">
        <span class="mark ${status}">${mark}</span>
        <span class="row-txt"><b>Q${i + 1}</b> · ${esc(q.system)}${q.topic ? ' · ' + esc(q.topic) : ''}</span>
        <span class="chev">›</span>
      </button>`;
  }).join('');
  const n = s.ids.length;

  return `
    <header class="top">
      <button class="link-btn" data-action="go" data-view="home">‹ Home</button>
      <span class="center">Results</span>
      <span style="width:48px"></span>
    </header>
    <section class="card score">
      <div class="big">${pct(correct, n)}</div>
      <p>${correct} of ${n} correct${skipped ? ` · ${skipped} unanswered` : ''}</p>
      <p class="small muted">${s.mode === 'timed' ? 'Timed' : 'Tutor'} block · tap any question to review</p>
    </section>
    <section class="card">${rows}</section>`;
}

function viewStats() {
  const st = overallStats();
  const now = Date.now();
  const rows = systemsList().map(sys => {
    const qs = state.bank.questions.filter(q => q.system === sys);
    let used = 0, ok = 0, due = 0;
    for (const q of qs) {
      const p = state.progress.get(q.id);
      if (p && p.attempts) {
        used++;
        if (p.lastResult === 'correct') ok++;
        if (p.due <= now) due++;
      }
    }
    return { sys, total: qs.length, used, ok, due };
  });
  // Weakest first (among systems with attempts), then unused systems
  rows.sort((a, b) => {
    if (!a.used !== !b.used) return a.used ? -1 : 1;
    return (a.used ? a.ok / a.used : 0) - (b.used ? b.ok / b.used : 0);
  });

  return `
    <header class="top">
      <button class="link-btn" data-action="go" data-view="home">‹ Home</button>
      <span class="center">Performance</span>
      <span style="width:48px"></span>
    </header>
    <section class="card">
      <div class="stat-grid">
        <div><div class="num">${pct(st.used, st.total)}</div><div class="lab">Bank used</div></div>
        <div><div class="num">${pct(st.latestCorrect, st.used)}</div><div class="lab">Correct</div></div>
        <div><div class="num">${st.flagged}</div><div class="lab">Flagged</div></div>
      </div>
      <p class="small muted" style="margin-top:12px">"Correct" uses your most recent attempt at each question.</p>
    </section>
    <section class="card">
      <h2>By system (weakest first)</h2>
      <table>
        <thead><tr><th>System</th><th>Used</th><th>Correct</th><th>Due</th></tr></thead>
        <tbody>
          ${rows.map(r => `<tr><td>${esc(r.sys)}</td><td>${r.used}/${r.total}</td><td>${pct(r.ok, r.used)}</td><td>${r.due}</td></tr>`).join('')}
        </tbody>
      </table>
    </section>`;
}

function viewSettings() {
  const b = state.bank;
  return `
    <header class="top">
      <button class="link-btn" data-action="go" data-view="home">‹ Home</button>
      <span class="center">Settings</span>
      <span style="width:48px"></span>
    </header>

    <section class="card">
      <h2>Question bank</h2>
      <div class="kv"><span>Name</span><span>${esc(b.title)}</span></div>
      <div class="kv"><span>Questions</span><span>${b.questions.length}</span></div>
      <div class="kv"><span>Version</span><span>${esc(b.version || '—')}</span></div>
      <div class="kv"><span>Source</span><span>${state.bankSource === 'imported' ? 'Loaded from file' : 'Bundled with app'}</span></div>
      <div class="btn-col" style="margin-top:14px">
        <label class="btn">Load question bank file<input type="file" data-file="bank" hidden></label>
        ${state.bankSource === 'imported' ? `<button class="btn" data-action="useBundled">Switch to bundled bank</button>` : ''}
      </div>
      <p class="small muted" style="margin-top:10px">A loaded file is stored on this phone and works offline. Progress is matched by question ID, so reloading an updated bank keeps your history.</p>
    </section>

    <section class="card">
      <h2>Progress backup</h2>
      <div class="btn-col">
        <button class="btn" data-action="exportProgress">Export progress</button>
        <label class="btn">Import progress<input type="file" data-file="progress" hidden></label>
        <button class="btn danger" data-action="resetProgress">Reset all progress</button>
      </div>
    </section>

    <section class="card">
      <h2>Storage</h2>
      <div class="kv"><span>Persistent storage</span><span id="persist">…</span></div>
      <div class="kv"><span>Space used</span><span id="usage">…</span></div>
      <div class="kv"><span>App version</span><span>${APP_VERSION}</span></div>
    </section>`;
}

async function fillStorageInfo() {
  const persistEl = document.getElementById('persist');
  const usageEl = document.getElementById('usage');
  try {
    const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null;
    if (persistEl) persistEl.textContent = persisted == null ? 'Unknown' : persisted ? 'On' : 'Not granted';
  } catch { if (persistEl) persistEl.textContent = 'Unknown'; }
  try {
    const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
    if (usageEl) usageEl.textContent = est && est.usage != null ? `${(est.usage / 1048576).toFixed(1)} MB` : 'Unknown';
  } catch { if (usageEl) usageEl.textContent = 'Unknown'; }
}

/* ---------------- Block lifecycle ---------------- */

async function startBlock() {
  const pool = candidates();
  if (!pool.length) return toast('No questions match these filters');
  const n = Math.min(state.home.count, pool.length);
  const ids = shuffle(pool.map(q => q.id)).slice(0, n);
  state.session = {
    id: Date.now(),
    mode: state.home.mode,
    ids,
    answers: {},
    submitted: {},
    idx: 0,
    finished: false,
    remaining: state.home.mode === 'timed' ? n * SECONDS_PER_Q : null,
    startedAt: Date.now(),
  };
  await saveSession();
  go('quiz');
}

async function finishBlock() {
  const s = state.session;
  if (!s || s.finished) return;
  stopTimer();
  if (s.mode === 'timed') {
    for (const id of s.ids) {
      const a = s.answers[id];
      if (a) await recordAnswer(id, a, a === state.byId.get(id).answer);
    }
  }
  s.finished = true;
  s.idx = 0;
  await saveSession();
  go('results');
}

/* ---------------- File import / export ---------------- */

async function importBank(data) {
  const bank = normalizeBank(data);
  await DB.put('meta', bank, 'customBank');
  if (state.session && !state.session.finished) {
    state.session = null;
    await saveSession();
  }
  setBank(bank, 'imported');
  render();
  toast(`Loaded ${bank.questions.length} questions${bank.skipped ? ` (${bank.skipped} skipped as invalid)` : ''}`);
}

async function importProgress(data) {
  const list = data && Array.isArray(data.progress) ? data.progress : null;
  if (!list) throw new Error('Not a QBank progress file');
  const valid = list.filter(p => p && p.id != null && typeof p.attempts === 'number');
  if (!confirm(`Replace current progress with ${valid.length} records from this file?`)) return;
  await DB.clear('progress');
  await DB.putMany('progress', valid);
  state.progress = new Map(valid.map(p => [String(p.id), p]));
  render();
  toast('Progress imported');
}

async function exportProgress() {
  const payload = {
    app: 'qbank',
    type: 'progress',
    format: 1,
    exportedAt: new Date().toISOString(),
    bankVersion: state.bank.version,
    progress: [...state.progress.values()],
  };
  const name = `qbank-progress-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  try {
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/* ---------------- Actions ---------------- */

const actions = {
  go: el => go(el.dataset.view),

  mode: el => { state.home.mode = el.dataset.v; saveHome(); render(); },
  pool: el => { state.home.pool = el.dataset.v; saveHome(); render(); },
  sys: el => {
    const v = el.dataset.v;
    const set = state.home.systems;
    if (v === '*') set.clear();
    else if (set.has(v)) set.delete(v);
    else set.add(v);
    saveHome();
    render();
  },
  count: el => {
    const avail = candidates().length;
    const cur = Math.min(state.home.count, avail);
    const up = Number(el.dataset.d) > 0;
    // Step by 1 up to 10, then by 5 (10, 15, 20...)
    let next;
    if (up) next = cur < 10 ? cur + 1 : Math.floor(cur / 5) * 5 + 5;
    else next = cur <= 10 ? cur - 1 : Math.ceil(cur / 5) * 5 - 5;
    state.home.count = Math.max(1, Math.min(avail || 1, next));
    saveHome();
    render();
  },
  start: startBlock,
  resume: () => go('quiz'),
  discard: async () => {
    if (!confirm('Discard this block? Answers already submitted in tutor mode stay recorded.')) return;
    state.session = null;
    await saveSession();
    render();
  },

  choose: el => {
    const s = state.session;
    const id = s.ids[s.idx];
    if (s.finished || (s.mode === 'tutor' && s.submitted[id])) return;
    s.answers[id] = el.dataset.label;
    saveSession();
    go('quiz', { keepScroll: true });
  },
  submit: async () => {
    const s = state.session;
    const id = s.ids[s.idx];
    const a = s.answers[id];
    if (!a || s.submitted[id]) return;
    s.submitted[id] = true;
    await recordAnswer(id, a, a === state.byId.get(id).answer);
    await saveSession();
    go('quiz', { keepScroll: true });
  },
  next: () => {
    const s = state.session;
    if (s.idx < s.ids.length - 1) { s.idx++; saveSession(); go('quiz'); }
  },
  prev: () => {
    const s = state.session;
    if (s.idx > 0) { s.idx--; saveSession(); go('quiz'); }
  },
  flag: async () => {
    const s = state.session;
    const p = progressFor(s.ids[s.idx]);
    p.flagged = !p.flagged;
    await DB.put('progress', p);
    go('quiz', { keepScroll: true });
    toast(p.flagged ? 'Flagged' : 'Flag removed', 1200);
  },
  finish: () => {
    const s = state.session;
    const unanswered = s.ids.filter(id => !s.answers[id]).length;
    if (s.mode === 'timed' && !confirm(unanswered ? `End block with ${unanswered} unanswered?` : 'End block and see results?')) return;
    finishBlock();
  },
  exit: () => {
    saveSession();
    go(state.session.finished ? 'results' : 'home');
  },
  review: el => {
    state.session.idx = Number(el.dataset.i);
    saveSession();
    go('quiz');
  },

  exportProgress,
  resetProgress: async () => {
    if (!confirm('Erase all answer history, flags and review schedules on this phone?')) return;
    if (!confirm('This cannot be undone. Consider exporting first. Erase anyway?')) return;
    await DB.clear('progress');
    state.progress = new Map();
    state.session = null;
    await saveSession();
    render();
    toast('Progress reset');
  },
  useBundled: async () => {
    if (!confirm('Switch back to the bundled question bank? The loaded file will be removed from this phone (your progress stays).')) return;
    await DB.del('meta', 'customBank');
    state.session = null;
    await saveSession();
    try { await loadBank(); render(); toast('Using bundled bank'); }
    catch (e) { toast('Could not load bundled bank: ' + e.message); }
  },
};

$app.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) fn(el);
});

$app.addEventListener('change', async e => {
  const input = e.target;
  const kind = input.dataset && input.dataset.file;
  const file = input.files && input.files[0];
  if (!kind || !file) return;
  input.value = '';
  try {
    const data = JSON.parse(await file.text());
    if (kind === 'bank') await importBank(data);
    else await importProgress(data);
  } catch (err) {
    toast('Could not load file: ' + err.message, 4000);
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveSession();
});

/* ---------------- Startup ---------------- */

async function init() {
  try {
    const [prog, sess, home] = await Promise.all([
      DB.getAll('progress'),
      DB.get('meta', 'session'),
      DB.get('meta', 'home'),
    ]);
    (prog || []).forEach(p => state.progress.set(p.id, p));
    if (home) state.home = { ...state.home, ...home, systems: new Set(home.systems || []) };
    await loadBank();
    if (sess && Array.isArray(sess.ids) && sess.ids.every(id => state.byId.has(id))) state.session = sess;
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    go('home');
  } catch (err) {
    $app.innerHTML = `<div class="card"><h1>Could not start</h1><p>${esc(err.message)}</p>
      <p class="muted small">Open the app once while online so it can cache everything for offline use.</p></div>`;
  }
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) toast('App updated. Close and reopen to use the new version.', 4000);
    hadController = true;
  });
}

init();
