// Ash's BPT Study Bank Flashcards — main app logic
// Offline-first PWA. No framework; vanilla ES modules.

const STORAGE_KEY = 'racp-flashcards-v1';
const APP_VERSION = '0.1.0';

// ---------- Storage ----------
const defaultState = () => ({
  version: APP_VERSION,
  settings: { sessionSize: 20, mode: 'smart' },
  // per-question progress keyed by question id
  progress: {
    /* id: {
         box: 1..5,
         dueAt: epoch-ms,
         lastShownAt: epoch-ms,
         seen: N,
         correct: N,
         wrong: N,
         lastResult: 'c' | 'w' | null
       } */
  },
  history: [], // recent answers: { id, correct, at }
});

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return { ...defaultState(), ...parsed, progress: parsed.progress || {} };
  } catch (e) {
    console.warn('Failed to load state, resetting', e);
    return defaultState();
  }
}
function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

// ---------- Spaced repetition (Leitner-style) ----------
const BOX_INTERVALS_MS = [
  0,                 // box 0 = unseen
  1 * 24 * 60 * 60 * 1000,   // box 1 -> 1 day
  2 * 24 * 60 * 60 * 1000,   // box 2 -> 2 days
  4 * 24 * 60 * 60 * 1000,   // box 3 -> 4 days
  8 * 24 * 60 * 60 * 1000,   // box 4 -> 8 days
  16 * 24 * 60 * 60 * 1000,  // box 5 -> 16 days
];

function recordAnswer(questionId, wasCorrect) {
  const now = Date.now();
  const p = state.progress[questionId] || {
    box: 0, dueAt: now, lastShownAt: 0, seen: 0, correct: 0, wrong: 0, lastResult: null,
  };
  p.seen++;
  p.lastShownAt = now;
  if (wasCorrect) {
    p.correct++;
    p.box = Math.min(5, (p.box || 0) + 1);
    p.lastResult = 'c';
  } else {
    p.wrong++;
    p.box = 1; // demote to box 1
    p.lastResult = 'w';
  }
  p.dueAt = now + BOX_INTERVALS_MS[p.box];
  state.progress[questionId] = p;
  state.history.push({ id: questionId, correct: wasCorrect, at: now });
  if (state.history.length > 500) state.history = state.history.slice(-500);
  saveState();
}

// Build today's session queue
function buildQueue(questions, mode, size, filters) {
  const now = Date.now();

  // Apply source and topic filters
  let filtered = questions;
  if (filters) {
    if (filters.sources && filters.sources.length > 0) {
      filtered = filtered.filter(q => filters.sources.includes(q.source));
    }
    if (filters.topics && filters.topics.length > 0) {
      filtered = filtered.filter(q => (q.topics || []).some(t => filters.topics.includes(t)));
    }
  }

  const withProgress = filtered.map(q => ({ q, p: state.progress[q.id] }));

  let pool;
  if (mode === 'wrong') {
    pool = withProgress.filter(x => x.p && x.p.wrong > 0);
    pool.sort((a, b) => (b.p.wrong - a.p.wrong) || (a.p.lastShownAt - b.p.lastShownAt));
  } else if (mode === 'seen') {
    pool = withProgress.filter(x => x.p && x.p.seen > 0);
    shuffle(pool);
  } else if (mode === 'new') {
    pool = withProgress.filter(x => !x.p);
    shuffle(pool);
  } else if (mode === 'random') {
    pool = withProgress.slice();
    shuffle(pool);
  } else {
    // smart: due items first (overdue > due), weighted toward wrong history, then new, then others
    const due = withProgress.filter(x => x.p && x.p.dueAt <= now);
    const newOnes = withProgress.filter(x => !x.p);
    const notDue = withProgress.filter(x => x.p && x.p.dueAt > now);
    due.sort((a, b) => score(b.p, now) - score(a.p, now));
    shuffle(newOnes);
    notDue.sort((a, b) => score(b.p, now) - score(a.p, now));
    pool = [...due, ...newOnes, ...notDue];
  }

  return pool.slice(0, size).map(x => x.q);
}

function score(p, now) {
  if (!p) return 0;
  const overdueMs = Math.max(0, now - p.dueAt);
  const overdueDays = overdueMs / (24 * 60 * 60 * 1000);
  const wrongWeight = (p.wrong || 0) * 3;
  const lowBoxWeight = (6 - (p.box || 1));
  return overdueDays + wrongWeight + lowBoxWeight;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------- Data load ----------
async function loadQuestions() {
  try {
    const res = await fetch('questions.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('bad response');
    const data = await res.json();
    return Array.isArray(data) ? data : (data.questions || []);
  } catch (e) {
    console.error('Could not load questions.json', e);
    return [];
  }
}

// ---------- UI router ----------
const appEl = document.getElementById('app');
const btnHome = document.getElementById('btn-home');
const btnStats = document.getElementById('btn-stats');
const btnLove = document.getElementById('btn-love');
const topTitle = document.getElementById('top-title');

function render(screen, data) {
  appEl.innerHTML = '';
  const tpl = document.getElementById(`tpl-${screen}`);
  if (!tpl) return;
  const node = tpl.content.cloneNode(true);
  appEl.appendChild(node);
  btnHome.hidden = (screen === 'home');
  // default title
  topTitle.textContent = {
    home: "Ash's BPT Study Bank",
    question: 'Session',
    summary: 'Session complete',
    stats: 'Stats',
    love: "Ash's BPT Study Bank",
    empty: "Ash's BPT Study Bank",
  }[screen] || "Ash's BPT Study Bank";
  if (screen === 'home') bindHome();
  else if (screen === 'question') bindQuestion(data);
  else if (screen === 'summary') bindSummary(data);
  else if (screen === 'stats') bindStats();
  else if (screen === 'love') bindLove();
}

btnHome.addEventListener('click', () => render('home'));
btnStats.addEventListener('click', () => render('stats'));
btnLove.addEventListener('click', () => render('love'));

// ---------- Home ----------
function bindHome() {
  const summaryEl = document.querySelector('#home-summary');
  const statsEl = document.querySelector('#home-stats');
  const sessionSizeEl = document.querySelector('#session-size');
  const sessionModeEl = document.querySelector('#session-mode');
  sessionSizeEl.value = String(state.settings.sessionSize);
  sessionModeEl.value = state.settings.mode;

  const total = questions.length;
  const seenIds = Object.keys(state.progress);
  const seen = seenIds.length;
  const dueNow = seenIds.filter(id => state.progress[id].dueAt <= Date.now()).length;
  const wrongOnes = seenIds.filter(id => state.progress[id].wrong > 0).length;

  summaryEl.textContent = total
    ? `${total} question${total === 1 ? '' : 's'} in bank · ${seen} seen · ${dueNow} due now`
    : 'No questions loaded. Add exam materials and rebuild the bank.';

  statsEl.innerHTML = '';
  statsEl.appendChild(stat('Total', total));
  statsEl.appendChild(stat('Seen', seen));
  statsEl.appendChild(stat('Due now', dueNow));
  statsEl.appendChild(stat('Got wrong', wrongOnes));

  // --- Source filter ---
  const allSources = [...new Set(questions.map(q => q.source))].sort();
  const selectedSources = state.settings.selectedSources || allSources.slice();
  buildFilterPanel('source', allSources, selectedSources);

  // --- Topic filter ---
  const TOPIC_ORDER = [
    'cardiology', 'immunology', 'general medicine', 'neurology', 'nephrology',
    'obstetric medicine', 'endocrinology', 'infectious diseases', 'respiratory',
    'gastroenterology', 'rheumatology', 'dermatology', 'haematology', 'oncology',
    'palliative care', 'pharmacology', 'genetics', 'geriatrics', 'psychiatry',
    'ICU', 'statistics', 'disability', 'other'
  ];
  const selectedTopics = state.settings.selectedTopics || TOPIC_ORDER.slice();
  buildFilterPanel('topic', TOPIC_ORDER, selectedTopics);

  document.querySelector('#btn-start').addEventListener('click', () => {
    state.settings.sessionSize = parseInt(sessionSizeEl.value, 10);
    state.settings.mode = sessionModeEl.value;
    state.settings.selectedSources = getFilterSelection('source');
    state.settings.selectedTopics = getFilterSelection('topic');
    saveState();
    const filters = {
      sources: state.settings.selectedSources.length < allSources.length ? state.settings.selectedSources : null,
      topics: state.settings.selectedTopics.length < TOPIC_ORDER.length ? state.settings.selectedTopics : null,
    };
    const queue = buildQueue(questions, state.settings.mode, state.settings.sessionSize, filters);
    if (queue.length === 0) {
      alert('No questions available for this mode/filter combination.');
      return;
    }
    startSession(queue);
  });

  document.querySelector('#btn-reset').addEventListener('click', () => {
    if (confirm('Reset ALL progress? This cannot be undone.')) {
      state = defaultState();
      saveState();
      render('home');
    }
  });

  document.querySelector('#btn-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `racp-progress-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
  const fileInput = document.querySelector('#import-file');
  document.querySelector('#btn-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      const parsed = JSON.parse(text);
      if (!parsed.progress) throw new Error('invalid file');
      state = { ...defaultState(), ...parsed };
      saveState();
      render('home');
    } catch (err) {
      alert('Could not import: ' + err.message);
    }
  });
}

function stat(label, value) {
  const d = document.createElement('div');
  d.className = 'stat';
  d.innerHTML = `<div class="label"></div><div class="value"></div>`;
  d.querySelector('.label').textContent = label;
  d.querySelector('.value').textContent = value;
  return d;
}

// --- Filter panel helpers ---
function buildFilterPanel(prefix, items, selected) {
  const toggle = document.querySelector(`#${prefix}-filter-toggle`);
  const panel = document.querySelector(`#${prefix}-panel`);
  const list = document.querySelector(`#${prefix}-list`);
  const badge = document.querySelector(`#${prefix}-badge`);

  list.innerHTML = '';
  items.forEach(item => {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = item;
    cb.checked = selected.includes(item);
    cb.addEventListener('change', () => updateFilterBadge(prefix, items));
    const span = document.createElement('span');
    span.textContent = item;
    label.appendChild(cb);
    label.appendChild(span);
    list.appendChild(label);
  });

  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
  });

  document.querySelector(`#${prefix}-all`).addEventListener('click', () => {
    list.querySelectorAll('input').forEach(cb => cb.checked = true);
    updateFilterBadge(prefix, items);
  });
  document.querySelector(`#${prefix}-none`).addEventListener('click', () => {
    list.querySelectorAll('input').forEach(cb => cb.checked = false);
    updateFilterBadge(prefix, items);
  });

  updateFilterBadge(prefix, items);
}

function getFilterSelection(prefix) {
  const list = document.querySelector(`#${prefix}-list`);
  return Array.from(list.querySelectorAll('input:checked')).map(cb => cb.value);
}

function updateFilterBadge(prefix, allItems) {
  const badge = document.querySelector(`#${prefix}-badge`);
  const selected = getFilterSelection(prefix);
  if (selected.length === allItems.length || selected.length === 0) {
    badge.textContent = 'All';
  } else {
    badge.textContent = `${selected.length} / ${allItems.length}`;
  }
}

// ---------- Session ----------
let session = null;

function startSession(queue) {
  session = {
    queue,
    index: 0,
    results: [], // { id, correct }
  };
  showCurrentQuestion();
}

function showCurrentQuestion() {
  if (!session) return;
  if (session.index >= session.queue.length) {
    render('summary', session);
    return;
  }
  render('question', session.queue[session.index]);
}

function bindQuestion(q) {
  const total = session.queue.length;
  const idx = session.index;
  document.querySelector('#q-counter').textContent = `Q ${idx + 1} / ${total}`;
  document.querySelector('#q-source').textContent = q.source || '';
  document.querySelector('#q-topics').textContent = (q.topics || []).join(', ');
  document.querySelector('#q-stem').textContent = q.stem || '';
  document.querySelector('#progress-fill').style.width = `${Math.round((idx) / total * 100)}%`;

  // Render images if present
  const imagesEl = document.querySelector('#q-images');
  imagesEl.innerHTML = '';
  if (q.images && q.images.length > 0) {
    q.images.forEach(src => {
      const img = document.createElement('img');
      img.src = src;
      img.alt = 'Question image';
      img.className = 'q-img';
      imagesEl.appendChild(img);
    });
  }

  const optsEl = document.querySelector('#q-options');
  optsEl.innerHTML = '';
  q.options.forEach(opt => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="letter"></span><span class="text"></span>`;
    li.querySelector('.letter').textContent = opt.key;
    li.querySelector('.text').textContent = opt.text;
    li.addEventListener('click', () => pickAnswer(q, opt.key, li));
    optsEl.appendChild(li);
  });

  const feedbackEl = document.querySelector('#q-feedback');
  const nextBtn = document.querySelector('#btn-next');
  feedbackEl.hidden = true;
  nextBtn.hidden = true;

  document.querySelector('#btn-skip').addEventListener('click', () => {
    session.index++;
    showCurrentQuestion();
  });
  nextBtn.addEventListener('click', () => {
    session.index++;
    showCurrentQuestion();
  });
}

function pickAnswer(q, pickedKey, clickedEl) {
  const optsEl = document.querySelector('#q-options');
  Array.from(optsEl.children).forEach(li => li.classList.add('disabled'));
  const correctKey = (q.answer || '').toUpperCase();
  const wasCorrect = pickedKey.toUpperCase() === correctKey;

  Array.from(optsEl.children).forEach(li => {
    const k = li.querySelector('.letter').textContent.toUpperCase();
    if (k === correctKey) li.classList.add('correct');
    else if (k === pickedKey.toUpperCase()) li.classList.add('wrong');
  });

  const fb = document.querySelector('#q-feedback');
  fb.hidden = false;
  fb.classList.toggle('correct', wasCorrect);
  fb.classList.toggle('wrong', !wasCorrect);
  fb.innerHTML = '';
  const title = document.createElement('h4');
  title.textContent = wasCorrect ? 'Correct' : `Correct answer: ${correctKey}`;
  fb.appendChild(title);
  if (q.explanation) {
    const p = document.createElement('p');
    p.textContent = q.explanation;
    p.style.margin = '0';
    fb.appendChild(p);
  }
  if (q.answerSource && q.answerSource !== 'official') {
    const note = document.createElement('p');
    note.className = 'muted';
    note.style.margin = '6px 0 0';
    note.style.fontSize = '12px';
    note.textContent = q.answerSource === 'generated'
      ? 'Answer generated — verify against a source.'
      : `Answer source: ${q.answerSource}`;
    fb.appendChild(note);
  }

  document.querySelector('#btn-next').hidden = false;
  document.querySelector('#btn-skip').hidden = true;
  recordAnswer(q.id, wasCorrect);
  session.results.push({ id: q.id, correct: wasCorrect });
}

// ---------- Summary ----------
function bindSummary() {
  const total = session.results.length;
  const correct = session.results.filter(r => r.correct).length;
  document.querySelector('#s-correct').textContent = correct;
  document.querySelector('#s-total').textContent = total;
  const pct = total ? Math.round(correct / total * 100) : 0;
  document.querySelector('#s-accuracy').textContent = `${pct}% accuracy`;

  const list = document.querySelector('#s-list');
  list.innerHTML = '<h3>Review</h3>';
  if (total === 0) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No answers recorded.';
    list.appendChild(p);
  }
  session.results.forEach((r, i) => {
    const q = questions.find(x => x.id === r.id);
    const d = document.createElement('div');
    d.className = 'item';
    d.innerHTML = `<span class="status ${r.correct ? 'c' : 'w'}"></span><span class="txt"></span>`;
    d.querySelector('.status').textContent = r.correct ? '✓' : '✗';
    d.querySelector('.txt').textContent = q ? (q.stem.slice(0, 90) + (q.stem.length > 90 ? '…' : '')) : r.id;
    list.appendChild(d);
  });

  document.querySelector('#btn-review-wrong').addEventListener('click', () => {
    const wrongIds = session.results.filter(r => !r.correct).map(r => r.id);
    if (!wrongIds.length) { alert('No wrong answers this session.'); return; }
    const queue = questions.filter(q => wrongIds.includes(q.id));
    startSession(queue);
  });
  document.querySelector('#btn-again').addEventListener('click', () => {
    const filters = {
      sources: state.settings.selectedSources || null,
      topics: state.settings.selectedTopics || null,
    };
    const queue = buildQueue(questions, state.settings.mode, state.settings.sessionSize, filters);
    if (queue.length === 0) { alert('No questions available.'); return; }
    startSession(queue);
  });
  document.querySelector('#btn-home-from-summary').addEventListener('click', () => render('home'));
}

// ---------- Stats ----------
function bindStats() {
  const detail = document.querySelector('#stats-detail');
  const ids = Object.keys(state.progress);
  const totalSeen = ids.length;
  const totalCorrect = ids.reduce((s, id) => s + (state.progress[id].correct || 0), 0);
  const totalWrong = ids.reduce((s, id) => s + (state.progress[id].wrong || 0), 0);
  const totalAnswers = totalCorrect + totalWrong;
  const pct = totalAnswers ? Math.round(totalCorrect / totalAnswers * 100) : 0;
  const dueNow = ids.filter(id => state.progress[id].dueAt <= Date.now()).length;

  detail.innerHTML = '';
  detail.appendChild(stat('Questions seen', totalSeen));
  detail.appendChild(stat('Total answers', totalAnswers));
  detail.appendChild(stat('Accuracy', `${pct}%`));
  detail.appendChild(stat('Due now', dueNow));

  // By tag
  const byTag = {};
  questions.forEach(q => {
    (q.tags || []).forEach(t => {
      const p = state.progress[q.id];
      if (!byTag[t]) byTag[t] = { seen: 0, correct: 0, wrong: 0 };
      if (p) {
        byTag[t].seen++;
        byTag[t].correct += p.correct || 0;
        byTag[t].wrong += p.wrong || 0;
      }
    });
  });
  const container = document.querySelector('#stats-by-tag');
  container.innerHTML = '';
  const tagList = Object.keys(byTag).sort();
  if (tagList.length === 0) {
    container.innerHTML = '<p class="muted">No tags yet.</p>';
  } else {
    tagList.forEach(t => {
      const row = document.createElement('div');
      row.className = 'tag-row';
      const answers = byTag[t].correct + byTag[t].wrong;
      const acc = answers ? Math.round(byTag[t].correct / answers * 100) + '%' : '—';
      row.innerHTML = `<span></span><span></span>`;
      row.children[0].textContent = t;
      row.children[1].textContent = `${byTag[t].seen} seen · ${acc}`;
      container.appendChild(row);
    });
  }
}

// ---------- Love ----------
function bindLove() {
  document.querySelector('#btn-love-back').addEventListener('click', () => render('home'));
}

// ---------- Boot ----------
let state = loadState();
let questions = [];
(async function boot() {
  questions = await loadQuestions();
  if (questions.length === 0) {
    render('empty');
  } else {
    render('home');
  }
  // Register service worker only in production (not localhost — avoids deadlocking the dev server)
  if ('serviceWorker' in navigator && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    try { await navigator.serviceWorker.register('service-worker.js'); } catch (e) { /* ok */ }
  }
})();
