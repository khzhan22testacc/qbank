'use strict';

/* ============================================================
   QBank — offline question bank for personal study
   Questions: one or more bank files loaded in Settings
              (the bundled questions.json sample is used until you add one)
   Progress:  IndexedDB on the device (export/import as JSON)
   ============================================================ */

const APP_VERSION = '0.5.0';
const SECONDS_PER_Q = 90;                    // timed mode budget per question
const SRS_DAYS = [3, 7, 14, 30, 60, 120];    // review intervals after consecutive correct answers
const DAY_MS = 86400000;
const SAMPLE_ID = 'sample';
const POOLS = [
  ['unused', 'Unused'],
  ['all', 'All'],
  ['incorrect', 'Incorrect'],
  ['flagged', 'Flagged'],
  ['due', 'Due'],
];
// Optional per-question feedback, exported to improve question generation
const FEEDBACK_TYPES = [
  ['incorrect', 'Incorrect question'],
  ['not_relevant', 'Not clinically relevant'],
  ['too_long', 'Too long'],
  ['other', 'Other'],
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
    delMany: (store, keys) => run(store, 'readwrite', s => { keys.forEach(k => s.delete(k)); }),
  };
})();

/* ---------------- State ---------------- */

const state = {
  banks: [],               // banks loaded from files: [{ id, title, version, questions, skipped, addedAt }]
  sample: null,            // bundled sample bank (used only when no banks are loaded)
  questions: [],           // flat list of questions from the active banks
  byKey: new Map(),        // question key ("bankId::questionId") -> question
  bankTitles: new Map(),   // bankId -> title
  progress: new Map(),     // question key -> progress record
  feedback: new Map(),     // question key -> { key, types: [...], note, updatedAt }
  session: null,           // current or last block
  view: 'home',
  home: { mode: 'tutor', pool: 'unused', systems: new Set(), sources: new Set(), count: 10 },
  timerId: null,
};

const $app = document.getElementById('app');

/* ---------------- Helpers ---------------- */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Escaped text -> paragraphs, with http(s) links made tappable
const linkify = html => html.replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g,
  url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
const rich = t => String(t ?? '').trim().split(/\n{2,}/).filter(Boolean)
  .map(p => `<p>${linkify(esc(p)).replace(/\n/g, '<br>')}</p>`).join('');
const safeUrl = u => /^https?:\/\//i.test(String(u || '')) ? String(u) : '';
const pct = (n, d) => (d ? Math.round((100 * n) / d) + '%' : '—');
const mmss = sec => { sec = Math.max(0, Math.round(sec)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
const slug = s => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const keyOf = (bankId, qid) => `${bankId}::${qid}`;

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

function fmtReference(src) {
  if (!src) return '';
  if (typeof src === 'string') return src;
  return [src.book, src.chapter && `Ch. ${src.chapter}`, src.section, src.page && `p. ${src.page}`].filter(Boolean).join(' · ');
}

/* ---------------- Question banks ---------------- */

// Turns a bank file into the app's internal format.
// The bank's id comes from its "id" field, else its title, else the file name,
// so re-loading an updated file with the same id replaces it and keeps progress.
function normalizeBank(raw, fileName, forcedId) {
  const list = Array.isArray(raw) ? raw : raw && raw.questions;
  if (!Array.isArray(list)) throw new Error('No "questions" array found.');
  const meta = Array.isArray(raw) ? {} : raw;
  const baseName = String(fileName || '').replace(/\.json$/i, '');
  const title = String(meta.title || baseName || 'Question bank');
  const id = forcedId || slug(meta.id) || slug(meta.title) || slug(baseName) || `bank-${Date.now()}`;

  const seen = new Set();
  const questions = [];
  let skipped = 0;
  for (const q of list) {
    const qid = q && q.id != null ? String(q.id) : '';
    if (!qid || !q.stem || !Array.isArray(q.options) || q.options.length < 2 || seen.has(qid)) { skipped++; continue; }
    const options = q.options.map((o, i) => (typeof o === 'string'
      ? { label: String.fromCharCode(65 + i), text: o, explanation: '' }
      : { label: String(o.label || String.fromCharCode(65 + i)), text: o.text ?? '', explanation: o.explanation ?? '' }));
    const answer = String(q.answer ?? '');
    if (!options.some(o => o.label === answer)) { skipped++; continue; }
    seen.add(qid);
    questions.push({
      key: keyOf(id, qid),
      id: qid,
      bankId: id,
      system: q.system || 'General',
      topic: q.topic || '',
      stem: q.stem,
      lead: q.lead || '',
      options,
      answer,
      explanation: q.explanation || '',
      source: q.source || null,
      references: (Array.isArray(q.references) ? q.references : [])
        .filter(r => r && safeUrl(r.url))
        .map(r => ({ title: String(r.title || r.url), url: safeUrl(r.url), supports: String(r.supports || '') })),
      tags: Array.isArray(q.tags) ? q.tags : [],
    });
  }
  if (!questions.length) throw new Error('No valid questions found.');
  return { id, title, version: String(meta.version || ''), questions, skipped, addedAt: Date.now() };
}

const activeBanks = () => (state.banks.length ? state.banks : state.sample ? [state.sample] : []);
const usingSample = () => !state.banks.length;

function rebuildIndex() {
  const banks = activeBanks();
  state.questions = banks.flatMap(b => b.questions);
  state.byKey = new Map(state.questions.map(q => [q.key, q]));
  state.bankTitles = new Map(banks.map(b => [b.id, b.title]));
  // Forget filters that point at banks/systems that no longer exist
  for (const id of [...state.home.sources]) if (!state.bankTitles.has(id)) state.home.sources.delete(id);
  const systems = new Set(state.questions.map(q => q.system));
  for (const s of [...state.home.systems]) if (!systems.has(s)) state.home.systems.delete(s);
  // Drop an unfinished block whose questions are gone
  const s = state.session;
  if (s && !s.ids.every(k => state.byKey.has(k))) state.session = null;
}

async function loadBanks() {
  let banks = (await DB.get('meta', 'banks')) || [];

  // Version 0.1 stored a single loaded bank under "customBank": convert it
  const legacy = await DB.get('meta', 'customBank');
  if (legacy) {
    try {
      const converted = normalizeBank(legacy, legacy.title);
      if (!banks.some(b => b.id === converted.id)) banks.push(converted);
    } catch { /* ignore a broken legacy bank */ }
    await DB.put('meta', banks, 'banks');
    await DB.del('meta', 'customBank');
  }
  state.banks = banks;

  try {
    const res = await fetch('./questions.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('Could not load questions.json');
    state.sample = normalizeBank(await res.json(), 'Sample questions', SAMPLE_ID);
  } catch (err) {
    state.sample = null;
    if (!banks.length) throw err;
  }
}

const saveBanks = () => DB.put('meta', state.banks, 'banks');

const systemsList = () => [...new Set(state.questions.map(q => q.system))].sort((a, b) => a.localeCompare(b));

/* ---------------- Progress + spaced repetition ---------------- */

// Progress from version 0.1 was keyed by bare question id; re-key it to "bankId::id"
async function migrateProgressKeys(records) {
  const allBanks = [...state.banks, ...(state.sample ? [state.sample] : [])];
  const out = [];
  const oldKeys = [];
  for (const p of records) {
    if (String(p.id).includes('::')) { out.push(p); continue; }
    const bank = allBanks.find(b => b.questions.some(q => q.id === String(p.id)));
    if (!bank) { out.push(p); continue; }
    oldKeys.push(p.id);
    out.push({ ...p, id: keyOf(bank.id, p.id) });
  }
  if (oldKeys.length) {
    await DB.delMany('progress', oldKeys);
    await DB.putMany('progress', out.filter(p => String(p.id).includes('::')));
  }
  return out;
}

function progressFor(key) {
  let p = state.progress.get(key);
  if (!p) {
    p = { id: key, attempts: 0, correct: 0, flagged: false, step: -1, due: 0, lastResult: null, lastSeen: 0, history: [] };
    state.progress.set(key, p);
  }
  return p;
}

async function recordAnswer(key, choice, ok) {
  const p = progressFor(key);
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
  const p = state.progress.get(q.key);
  switch (pool) {
    case 'all': return true;
    case 'unused': return !p || !p.attempts;
    case 'incorrect': return !!p && p.lastResult === 'incorrect';
    case 'flagged': return !!p && p.flagged;
    case 'due': return !!p && p.attempts > 0 && p.due <= now;
    default: return true;
  }
}

const matchesSource = q => !state.home.sources.size || state.home.sources.has(q.bankId);
const matchesSystem = q => !state.home.systems.size || state.home.systems.has(q.system);

function candidates() {
  const now = Date.now();
  return state.questions.filter(q => inPool(q, state.home.pool, now) && matchesSource(q) && matchesSystem(q));
}

function summarize(qs) {
  const now = Date.now();
  let used = 0, latestCorrect = 0, due = 0, flagged = 0;
  for (const q of qs) {
    const p = state.progress.get(q.key);
    if (!p) continue;
    if (p.flagged) flagged++;
    if (p.attempts) {
      used++;
      if (p.lastResult === 'correct') latestCorrect++;
      if (p.due <= now) due++;
    }
  }
  return { total: qs.length, used, latestCorrect, due, flagged };
}

/* ---------------- Persistence ---------------- */

const saveHome = () => DB.put('meta', {
  ...state.home,
  systems: [...state.home.systems],
  sources: [...state.home.sources],
}, 'home').catch(() => {});
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

function chip(action, value, label, count, on) {
  return `<button class="chip ${on ? 'on' : ''}" data-action="${action}" data-v="${esc(value)}">${esc(label)}${count == null ? '' : `<span class="ct">${count}</span>`}</button>`;
}

function viewHome() {
  const st = summarize(state.questions);
  const h = state.home;
  const now = Date.now();
  const s = state.session;
  const banks = activeBanks();

  const poolCounts = Object.fromEntries(POOLS.map(([k]) => [k,
    state.questions.filter(q => inPool(q, k, now) && matchesSource(q) && matchesSystem(q)).length]));

  const sourceChips = banks.map(b => chip('src', b.id, b.title,
    b.questions.filter(q => inPool(q, h.pool, now) && matchesSystem(q)).length, h.sources.has(b.id))).join('');

  const sysChips = systemsList().map(sys => chip('sys', sys, sys,
    state.questions.filter(q => q.system === sys && inPool(q, h.pool, now) && matchesSource(q)).length, h.systems.has(sys))).join('');

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

  const sampleNote = usingSample()
    ? `<section class="card"><p class="small muted">You're seeing the built-in sample questions. Add your own bank files in Settings ⚙️ and the samples will be hidden.</p></section>`
    : '';

  return `
    <header class="top">
      <h1>QBank</h1>
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
    ${sampleNote}

    <section class="card">
      <h2>Mode</h2>
      <div class="seg">
        <button class="${h.mode === 'tutor' ? 'on' : ''}" data-action="mode" data-v="tutor">Tutor</button>
        <button class="${h.mode === 'timed' ? 'on' : ''}" data-action="mode" data-v="timed">Timed</button>
      </div>
      <p class="small muted" style="margin-top:8px">${h.mode === 'tutor'
        ? 'Tap an answer to lock it in and see the explanation.'
        : `${SECONDS_PER_Q} seconds per question, explanations at the end.`}</p>

      <h2>Questions</h2>
      <div class="chips">
        ${POOLS.map(([k, label]) => chip('pool', k, label, poolCounts[k], h.pool === k)).join('')}
      </div>

      ${banks.length > 1 ? `
      <h2>Sources</h2>
      <div class="chips">
        ${chip('src', '*', 'All sources', null, !h.sources.size)}
        ${sourceChips}
      </div>` : ''}

      <h2>Systems</h2>
      <div class="chips">
        ${chip('sys', '*', 'All systems', null, !h.systems.size)}
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
        ${avail ? 'Start block' : 'No questions match'}
      </button>
    </section>`;
}

function viewQuiz() {
  const s = state.session;
  const n = s.ids.length;
  const key = s.ids[s.idx];
  const q = state.byKey.get(key);
  const chosen = s.answers[key];
  const feedback = s.finished || (s.mode === 'tutor' && s.submitted[key]);
  const flagged = !!(state.progress.get(key) || {}).flagged;

  // Options are shown in this block's shuffled order and lettered A, B, C... by position.
  // Answers are still stored by the option's original label, so progress/feedback stay consistent.
  const shown = optionOrder(s, q);
  const letterOf = lbl => String.fromCharCode(65 + shown.findIndex(o => o.label === lbl));

  const opts = shown.map((o, i) => {
    let cls = 'opt';
    if (chosen === o.label) cls += ' selected';
    if (feedback) {
      if (o.label === q.answer) cls += ' correct';
      else if (chosen === o.label) cls += ' wrong';
      else cls += ' dim';
    }
    const exp = feedback && o.explanation ? `<div class="opt-exp">${rich(o.explanation)}</div>` : '';
    return `<button class="${cls}" data-action="choose" data-label="${esc(o.label)}" ${feedback ? 'disabled' : ''}>
        <span class="lbl">${String.fromCharCode(65 + i)}</span><span class="txt">${esc(o.text)}</span>
      </button>${exp}`;
  }).join('');

  // Topic, system and source are hidden until the question is answered (no spoilers)
  let after = '';
  if (feedback) {
    const correctText = q.options.find(o => o.label === q.answer).text;
    let verdict;
    const ansLetter = letterOf(q.answer);
    if (!chosen) verdict = `<div class="verdict skip">Not answered · Answer: ${ansLetter}. ${esc(correctText)}</div>`;
    else if (chosen === q.answer) verdict = `<div class="verdict ok">Correct</div>`;
    else verdict = `<div class="verdict bad">Incorrect · Answer: ${ansLetter}. ${esc(correctText)}</div>`;
    const ref = fmtReference(q.source);
    after = `
      ${verdict}
      <div class="qinfo">
        <div><span class="muted">Source</span> <b>${esc(state.bankTitles.get(q.bankId) || q.bankId)}</b></div>
        <div class="muted">${esc(q.system)}${q.topic ? ' · ' + esc(q.topic) : ''}</div>
      </div>
      <section class="card exp">
        <h3>Explanation</h3>
        ${rich(q.explanation) || '<p class="muted">No explanation provided.</p>'}
        ${(q.references || []).length ? `
          <div class="refs">
            <div class="refs-h">Outside sources</div>
            <ol>${q.references.map(r => `<li><a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a>${r.supports ? `<span class="muted"> · ${esc(r.supports)}</span>` : ''}</li>`).join('')}</ol>
          </div>` : ''}
        ${ref ? `<div class="src">Reference: ${esc(ref)}</div>` : ''}
      </section>
      ${feedbackBox(key)}`;
  }

  const isLast = s.idx === n - 1;
  let primary;
  if (s.finished) {
    primary = !isLast
      ? `<button class="btn primary" data-action="next">Next</button>`
      : `<button class="btn primary" data-action="go" data-view="results">Results</button>`;
  } else if (s.mode === 'tutor') {
    const label = isLast ? 'Finish block' : 'Next';
    const action = isLast ? 'finish' : 'next';
    primary = `<button class="btn ${feedback ? 'primary' : ''}" data-action="${action}">${feedback ? label : (isLast ? 'Finish block' : 'Skip')}</button>`;
  } else {
    primary = !isLast
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

    <div class="stem">${rich(q.stem)}</div>
    ${q.lead ? `<div class="lead">${esc(q.lead)}</div>` : ''}
    <div class="opts">${opts}</div>
    ${after}

    <nav class="bar">
      <button class="btn" data-action="prev" ${s.idx === 0 ? 'disabled' : ''}>Prev</button>
      ${primary}
    </nav>`;
}

function feedbackBox(key) {
  const fb = state.feedback.get(key);
  const types = new Set(fb ? fb.types : []);
  const showNote = types.size > 0 || (fb && fb.note);
  return `
    <section class="card fb">
      <h2>Feedback (optional)</h2>
      <div class="chips">
        ${FEEDBACK_TYPES.map(([k, label]) => chip('fbType', k, label, null, types.has(k))).join('')}
      </div>
      ${showNote ? `<textarea class="fb-note" data-fb-note rows="2" placeholder="${types.has('other') ? 'What was the problem?' : 'Add a note (optional)'}">${esc(fb ? fb.note : '')}</textarea>` : ''}
    </section>`;
}

async function saveFeedback(key, change) {
  const q = state.byKey.get(key);
  const cur = state.feedback.get(key) || { key, types: [], note: '' };
  const next = { ...cur, ...change, key, bankId: q.bankId, questionId: q.id, updatedAt: Date.now() };
  if (!next.types.length && !next.note.trim()) state.feedback.delete(key);
  else state.feedback.set(key, next);
  await DB.put('meta', [...state.feedback.values()], 'feedback').catch(() => {});
}

function viewResults() {
  const s = state.session;
  let correct = 0, skipped = 0;
  const rows = s.ids.map((key, i) => {
    const q = state.byKey.get(key);
    const a = s.answers[key];
    let status = 'skip', mark = '–';
    if (a) {
      if (a === q.answer) { status = 'ok'; mark = '✓'; correct++; } else { status = 'bad'; mark = '✗'; }
    } else skipped++;
    return `<button class="row" data-action="review" data-i="${i}">
        <span class="mark ${status}">${mark}</span>
        <span class="row-txt"><b>Q${i + 1}</b> · ${esc(q.system)}${q.topic ? ' · ' + esc(q.topic) : ''}
          <span class="small muted row-src">${esc(state.bankTitles.get(q.bankId) || '')}</span></span>
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

function statsTable(title, groups) {
  const rows = groups.map(([name, qs]) => ({ name, ...summarize(qs) }));
  rows.sort((a, b) => {
    if (!a.used !== !b.used) return a.used ? -1 : 1;
    return (a.used ? a.latestCorrect / a.used : 0) - (b.used ? b.latestCorrect / b.used : 0);
  });
  return `
    <section class="card">
      <h2>${esc(title)}</h2>
      <table>
        <thead><tr><th></th><th>Used</th><th>Correct</th><th>Due</th></tr></thead>
        <tbody>
          ${rows.map(r => `<tr><td>${esc(r.name)}</td><td>${r.used}/${r.total}</td><td>${pct(r.latestCorrect, r.used)}</td><td>${r.due}</td></tr>`).join('')}
        </tbody>
      </table>
    </section>`;
}

function viewStats() {
  const st = summarize(state.questions);
  const banks = activeBanks();
  const bySystem = systemsList().map(sys => [sys, state.questions.filter(q => q.system === sys)]);
  const bySource = banks.map(b => [b.title, b.questions]);

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
    ${statsTable('By system (weakest first)', bySystem)}
    ${banks.length > 1 ? statsTable('By source (weakest first)', bySource) : ''}`;
}

function viewSettings() {
  const bankRows = state.banks.length
    ? state.banks.map(b => `
        <div class="bank-row">
          <div class="bank-txt">
            <b>${esc(b.title)}</b>
            <div class="small muted">${b.questions.length} questions${b.version ? ` · v${esc(b.version)}` : ''}</div>
          </div>
          <button class="btn danger small-btn" data-action="removeBank" data-v="${esc(b.id)}">Remove</button>
        </div>`).join('')
    : `<p class="muted small">No banks loaded yet. The ${state.sample ? state.sample.questions.length : 0} built-in sample questions are shown until you add one.</p>`;

  return `
    <header class="top">
      <button class="link-btn" data-action="go" data-view="home">‹ Home</button>
      <span class="center">Settings</span>
      <span style="width:48px"></span>
    </header>

    <section class="card">
      <h2>Question banks</h2>
      ${bankRows}
      <div class="btn-col" style="margin-top:14px">
        <label class="btn primary">Add question bank files<input type="file" data-file="bank" multiple hidden></label>
      </div>
      <p class="small muted" style="margin-top:10px">You can select several files at once (e.g. one per textbook). Loading a file with the same bank name as one already here replaces it and keeps your progress. Banks are stored on this phone and work offline.</p>
    </section>

    ${feedbackSettings()}

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

function feedbackSettings() {
  const all = [...state.feedback.values()];
  const counts = FEEDBACK_TYPES.map(([k, label]) => [label, all.filter(f => f.types.includes(k)).length]);
  const notesOnly = all.filter(f => !f.types.length).length;
  return `
    <section class="card">
      <h2>Question feedback</h2>
      ${all.length ? `
        ${counts.map(([label, n]) => `<div class="kv"><span>${esc(label)}</span><span>${n}</span></div>`).join('')}
        ${notesOnly ? `<div class="kv"><span>Note only</span><span>${notesOnly}</span></div>` : ''}
        <div class="kv"><span><b>Questions with feedback</b></span><span><b>${all.length}</b></span></div>`
      : '<p class="small muted">No feedback yet. After answering a question you can tag it as incorrect, not clinically relevant, too long, or other.</p>'}
      <div class="btn-col" style="margin-top:14px">
        <button class="btn" data-action="exportFeedback" ${all.length ? '' : 'disabled'}>Export feedback file</button>
        <button class="btn danger" data-action="clearFeedback" ${all.length ? '' : 'disabled'}>Clear feedback</button>
      </div>
      <p class="small muted" style="margin-top:10px">The export includes each question's full text, your tags and notes, and how you answered it, so it can be used to fix or regenerate questions.</p>
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

// The options of q in the order fixed for this block (falls back to the written order)
function optionOrder(s, q) {
  const order = s.order && s.order[q.key];
  if (!Array.isArray(order) || order.length !== q.options.length) return q.options;
  const byLabel = new Map(q.options.map(o => [o.label, o]));
  const out = order.map(l => byLabel.get(l)).filter(Boolean);
  return out.length === q.options.length ? out : q.options;
}

async function startBlock() {
  const pool = candidates();
  if (!pool.length) return toast('No questions match these filters');
  const n = Math.min(state.home.count, pool.length);
  const ids = shuffle(pool.map(q => q.key)).slice(0, n);
  // New random option order for every question in every new block
  const order = Object.fromEntries(ids.map(k => [k, shuffle(state.byKey.get(k).options.map(o => o.label))]));
  state.session = {
    id: Date.now(),
    mode: state.home.mode,
    ids,
    order,
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
    for (const key of s.ids) {
      const a = s.answers[key];
      if (a) await recordAnswer(key, a, a === state.byKey.get(key).answer);
    }
  }
  s.finished = true;
  s.idx = 0;
  await saveSession();
  go('results');
}

/* ---------------- File import / export ---------------- */

async function importBankFiles(files) {
  const added = [], replaced = [], failed = [];
  let skipped = 0;
  for (const file of files) {
    try {
      const bank = normalizeBank(JSON.parse(await file.text()), file.name);
      skipped += bank.skipped;
      const i = state.banks.findIndex(b => b.id === bank.id);
      if (i >= 0) { state.banks[i] = bank; replaced.push(bank.title); }
      else { state.banks.push(bank); added.push(bank.title); }
    } catch (err) {
      failed.push(`${file.name} (${err.message})`);
    }
  }
  if (added.length || replaced.length) {
    await saveBanks();
    rebuildIndex();
    await saveSession();
    saveHome();
    render();
  }
  const parts = [];
  if (added.length) parts.push(`Added ${added.join(', ')}`);
  if (replaced.length) parts.push(`Updated ${replaced.join(', ')}`);
  if (skipped) parts.push(`${skipped} invalid questions skipped`);
  if (failed.length) parts.push(`Could not load ${failed.join('; ')}`);
  toast(parts.join(' · ') || 'Nothing loaded', failed.length ? 6000 : 3500);
}

async function importProgress(data) {
  const list = data && Array.isArray(data.progress) ? data.progress : null;
  if (!list) throw new Error('Not a QBank progress file');
  const valid = list.filter(p => p && p.id != null && typeof p.attempts === 'number');
  if (!confirm(`Replace current progress with ${valid.length} records from this file?`)) return;
  await DB.clear('progress');
  await DB.putMany('progress', valid);
  const migrated = await migrateProgressKeys(valid);
  state.progress = new Map(migrated.map(p => [String(p.id), p]));
  if (Array.isArray(data.feedback)) {
    state.feedback = new Map(data.feedback.filter(f => f && f.key).map(f => [f.key, f]));
    await DB.put('meta', [...state.feedback.values()], 'feedback');
  }
  render();
  toast('Progress imported');
}

async function exportProgress() {
  await shareJson(`qbank-progress-${new Date().toISOString().slice(0, 10)}.json`, {
    app: 'qbank',
    type: 'progress',
    format: 3,
    exportedAt: new Date().toISOString(),
    banks: state.banks.map(b => ({ id: b.id, title: b.title, version: b.version })),
    progress: [...state.progress.values()],
    feedback: [...state.feedback.values()],
  });
}

// One record per question with feedback: everything the generator needs to fix or replace it
async function exportFeedback() {
  const bankMeta = new Map([...state.banks, ...(state.sample ? [state.sample] : [])].map(b => [b.id, b]));
  const labels = Object.fromEntries(FEEDBACK_TYPES);
  const items = [...state.feedback.values()].map(fb => {
    const bank = bankMeta.get(fb.bankId);
    const q = bank && bank.questions.find(x => x.id === fb.questionId);
    const p = state.progress.get(fb.key);
    const last = p && p.history.length ? p.history[p.history.length - 1] : null;
    return {
      bank_id: fb.bankId,
      bank_title: bank ? bank.title : null,
      bank_version: bank ? bank.version : null,
      question_id: fb.questionId,
      feedback: fb.types,
      feedback_labels: fb.types.map(t => labels[t] || t),
      note: fb.note || '',
      feedback_at: new Date(fb.updatedAt).toISOString(),
      my_performance: p ? {
        attempts: p.attempts,
        correct: p.correct,
        last_choice: last ? last.c : null,
        last_correct: last ? last.ok : null,
      } : null,
      question: q ? {
        system: q.system, topic: q.topic, stem: q.stem, lead: q.lead,
        options: q.options, answer: q.answer, explanation: q.explanation,
        source: q.source, tags: q.tags,
      } : null,   // null if that bank has since been removed from the phone
    };
  });
  const summary = Object.fromEntries(FEEDBACK_TYPES.map(([k]) => [k, items.filter(i => i.feedback.includes(k)).length]));
  await shareJson(`qbank-feedback-${new Date().toISOString().slice(0, 10)}.json`, {
    app: 'qbank',
    type: 'feedback',
    format: 1,
    exportedAt: new Date().toISOString(),
    feedback_types: labels,
    summary: { questions: items.length, ...summary },
    items,
  }, true);
}

async function shareJson(name, payload, pretty = false) {
  const blob = new Blob([JSON.stringify(payload, null, pretty ? 2 : 0)], { type: 'application/json' });
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

function toggleIn(set, v) {
  if (v === '*') set.clear();
  else if (set.has(v)) set.delete(v);
  else set.add(v);
}

const actions = {
  go: el => go(el.dataset.view),

  mode: el => { state.home.mode = el.dataset.v; saveHome(); render(); },
  pool: el => { state.home.pool = el.dataset.v; saveHome(); render(); },
  sys: el => { toggleIn(state.home.systems, el.dataset.v); saveHome(); render(); },
  src: el => { toggleIn(state.home.sources, el.dataset.v); saveHome(); render(); },
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
    if (!confirm('Discard this block? Answers already given in tutor mode stay recorded.')) return;
    state.session = null;
    await saveSession();
    render();
  },

  // Tutor mode: the first tap is the answer. Timed mode: tap selects and can be changed.
  choose: async el => {
    const s = state.session;
    const key = s.ids[s.idx];
    if (s.finished || (s.mode === 'tutor' && s.submitted[key])) return;
    const label = el.dataset.label;
    s.answers[key] = label;
    if (s.mode === 'tutor') {
      s.submitted[key] = true;
      await recordAnswer(key, label, label === state.byKey.get(key).answer);
    }
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
    const unanswered = s.ids.filter(k => !s.answers[k]).length;
    if (s.mode === 'timed' && !confirm(unanswered ? `End block with ${unanswered} unanswered?` : 'End block and see results?')) return;
    if (s.mode === 'tutor' && unanswered && !confirm(`Finish with ${unanswered} skipped?`)) return;
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

  fbType: async el => {
    const key = state.session.ids[state.session.idx];
    const fb = state.feedback.get(key);
    const types = new Set(fb ? fb.types : []);
    if (types.has(el.dataset.v)) types.delete(el.dataset.v); else types.add(el.dataset.v);
    const note = document.querySelector('[data-fb-note]');
    await saveFeedback(key, { types: FEEDBACK_TYPES.map(([k]) => k).filter(k => types.has(k)), note: note ? note.value : (fb ? fb.note : '') });
    go('quiz', { keepScroll: true });
    if (el.dataset.v === 'other' && types.has('other')) {
      const ta = document.querySelector('[data-fb-note]');
      if (ta) ta.focus({ preventScroll: true });
    }
  },
  exportFeedback,
  clearFeedback: async () => {
    if (!confirm('Clear all question feedback on this phone? Export it first if you still need it.')) return;
    state.feedback = new Map();
    await DB.del('meta', 'feedback');
    render();
    toast('Feedback cleared');
  },

  removeBank: async el => {
    const bank = state.banks.find(b => b.id === el.dataset.v);
    if (!bank) return;
    if (!confirm(`Remove "${bank.title}" from this phone? Your progress on it is kept and comes back if you load the file again.`)) return;
    state.banks = state.banks.filter(b => b.id !== bank.id);
    await saveBanks();
    rebuildIndex();
    await saveSession();
    saveHome();
    render();
    toast(`Removed ${bank.title}`);
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
  const files = input.files ? [...input.files] : [];
  if (!kind || !files.length) return;
  input.value = '';
  try {
    if (kind === 'bank') await importBankFiles(files);
    else await importProgress(JSON.parse(await files[0].text()));
  } catch (err) {
    toast('Could not load file: ' + err.message, 4000);
  }
});

// Feedback note: saved as you type (no button needed)
let noteTimer;
$app.addEventListener('input', e => {
  if (!e.target.matches('[data-fb-note]') || !state.session) return;
  const key = state.session.ids[state.session.idx];
  const value = e.target.value;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    const fb = state.feedback.get(key);
    saveFeedback(key, { types: fb ? fb.types : [], note: value });
  }, 400);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveSession();
});

/* ---------------- Startup ---------------- */

async function init() {
  try {
    const [prog, sess, home, feedback] = await Promise.all([
      DB.getAll('progress'),
      DB.get('meta', 'session'),
      DB.get('meta', 'home'),
      DB.get('meta', 'feedback'),
    ]);
    (feedback || []).forEach(f => state.feedback.set(f.key, f));
    if (home) {
      state.home = {
        ...state.home,
        ...home,
        systems: new Set(home.systems || []),
        sources: new Set(home.sources || []),
      };
    }
    await loadBanks();
    const migrated = await migrateProgressKeys(prog || []);
    migrated.forEach(p => state.progress.set(String(p.id), p));
    if (sess && Array.isArray(sess.ids)) state.session = sess;
    rebuildIndex();
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
