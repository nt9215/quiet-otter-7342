'use strict';
/* Otter — offline workout viewer and logger.
   All workouts, videos and logs live in this browser's IndexedDB on the phone.
   Nothing is sent anywhere. */
const APP_VERSION = '1.0.1';

/* ---------------- IndexedDB ---------------- */
const STORES = ['workouts', 'exercises', 'videos', 'logs', 'meta'];
let _db;
function db() {
  if (!_db) _db = new Promise((res, rej) => {
    const r = indexedDB.open('gym-workouts', 1);
    r.onupgradeneeded = () => { for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return _db;
}
const p = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function idbGet(s, k) { return p((await db()).transaction(s).objectStore(s).get(k)); }
async function idbKeys(s) { return p((await db()).transaction(s).objectStore(s).getAllKeys()); }
async function idbAll(s) {
  const st = (await db()).transaction(s).objectStore(s);
  const [k, v] = await Promise.all([p(st.getAllKeys()), p(st.getAll())]);
  return k.map((key, i) => [key, v[i]]);
}
async function idbWrite(s, fn) {
  const t = (await db()).transaction(s, 'readwrite');
  fn(t.objectStore(s));
  return new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('aborted')); });
}
const idbPut = (s, k, v) => idbWrite(s, st => st.put(v, k));
const idbDel = (s, k) => idbWrite(s, st => st.delete(k));
const idbClear = s => idbWrite(s, st => st.clear());

/* ---------------- State ---------------- */
const S = { workouts: [], wById: {}, ex: {}, logs: {}, videoKeys: new Set(), meta: {} };
async function loadState() {
  const [w, e, l, vk, m] = await Promise.all([idbAll('workouts'), idbAll('exercises'), idbAll('logs'), idbKeys('videos'), idbAll('meta')]);
  S.workouts = w.map(x => x[1]).sort((a, b) => (a.due || '').localeCompare(b.due || '') || (a.title || '').localeCompare(b.title || ''));
  S.wById = Object.fromEntries(S.workouts.map(x => [String(x.id), x]));
  S.ex = Object.fromEntries(e);
  S.logs = Object.fromEntries(l);
  S.videoKeys = new Set(vk.map(String));
  S.meta = Object.fromEntries(m);
}

/* ---------------- Helpers ---------------- */
const $ = (sel, el = document) => el.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
function todayISO() { const t = new Date(); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`; }
function parseISO(s) { const [y, m, d] = (s || '').split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); }
function fmtDate(s, opt = { weekday: 'short', day: 'numeric', month: 'short' }) { return s ? parseISO(s).toLocaleDateString('en-GB', opt) : ''; }
function fmtStamp(ms) { return ms ? new Date(ms).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''; }
function fmtBytes(b) { if (!b) return '0 MB'; const mb = b / 1048576; return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb.toFixed(mb < 10 ? 1 : 0) + ' MB'; }
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function parseTitle(t) {
  const wd = /W\s*(\d+)\s*:\s*D\s*(\d+)/i.exec(t || '');
  const ph = /Phase\s*(\d+)(?:\s*\/\s*(\d+))?/i.exec(t || '');
  return { week: wd ? +wd[1] : null, day: wd ? +wd[2] : null, phase: ph ? +ph[1] : null, phases: ph && ph[2] ? +ph[2] : null };
}
function shortTitle(w) { const t = parseTitle(w.title); return t.week ? `Week ${t.week} · Day ${t.day}` : (w.title || 'Workout'); }
function splitInfo(info) { const parts = String(info || '').trim().split(/\n\s*\n/); return { presc: parts[0] || '', rest: parts.slice(1).join('\n\n') }; }
function parseSets(info) {
  const first = splitInfo(info).presc;
  let m = /(\d+)\s*(?:[–—-]\s*(\d+))?\s*sets?\b/i.exec(first) || /(\d+)\s*x\s*\d+/i.exec(first);
  let n = m ? +(m[2] || m[1]) : 3;
  if (!(n >= 1 && n <= 10)) n = 3;
  const work = first.split(/\brest\b/i)[0];
  const secs = !/\breps?\b/i.test(work) && /(second|secs?\b|hold)/i.test(work);
  return { n, unit: secs ? 'secs' : 'reps' };
}
function parseRest(info) {
  const m = /rest\s*(?:for\s*)?(\d+)\s*(?:[–—-]\s*(\d+))?\s*(seconds?|secs?|s\b|minutes?|mins?|m\b)/i.exec(String(info || ''));
  if (!m) return null;
  const mult = /^m/i.test(m[3]) ? 60 : 1;
  return { lo: +m[1] * mult, hi: m[2] ? +m[2] * mult : null };
}
function exName(id) { return (S.ex[id] && S.ex[id].name) || 'Exercise'; }
function itemVideoId(item, il) {
  if (item.alts && item.alts.length > 1) return (il && il.choice) || item.alts[0];
  return item.ex || (item.alts && item.alts[0]) || null;
}
function effName(item, il) { return item.alts && item.alts.length > 1 && il && il.choice ? exName(il.choice) : item.name; }
function labelsFor(w) {
  // Prefer TrueCoach's own labels (A, B, C1, C2...). Fall back to building them from the superset links.
  if (w.items.every(i => i.label)) return w.items.map(i => i.label);
  const out = []; let letter = 0, inGroup = false, sub = 0;
  w.items.forEach((it, i) => {
    const prevLinked = i > 0 && w.items[i - 1].linked;
    if (!prevLinked) { letter++; sub = 0; inGroup = !!it.linked; }
    sub++;
    out.push(String.fromCharCode(64 + letter) + (inGroup ? sub : ''));
  });
  return out;
}
function allExerciseIds(w) {
  const ids = new Set();
  for (const it of w.items || []) { if (it.ex) ids.add(String(it.ex)); (it.alts || []).forEach(a => ids.add(String(a))); }
  (w.warmup_ex || []).forEach(a => ids.add(String(a)));
  (w.cooldown_ex || []).forEach(a => ids.add(String(a)));
  return ids;
}
function hasAnyData(il) { return il && ((il.sets || []).some(s => s.kg !== '' || s.reps !== '' || s.done) || (il.note || '').trim()); }
function workoutStatus(w) {
  const log = S.logs[String(w.id)];
  if (log && log.finished) return 'done';
  if (log && (Object.values(log.items || {}).some(hasAnyData) || (log.note || '').trim())) return 'prog';
  return '';
}
function upNext() {
  const today = todayISO();
  const open = S.workouts.filter(w => workoutStatus(w) !== 'done' && !w.rest_day);
  return open.find(w => workoutStatus(w) === 'prog') || open.find(w => (w.due || '') >= today) || open[open.length - 1] || null;
}
function toast(msg, ms = 2600) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

/* ---------------- Navigation ---------------- */
let current = { v: 'home' };
const blobUrls = [];
function releaseVideos() { while (blobUrls.length) URL.revokeObjectURL(blobUrls.pop()); }
function go(v, extra = {}, replace = false) {
  const st = { v, ...extra };
  if (replace) history.replaceState(st, ''); else history.pushState(st, '');
  render(st);
}
window.addEventListener('popstate', e => render(e.state || { v: 'home' }));
$('#backBtn').onclick = () => history.back();
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]'); if (!b) return;
  const v = b.dataset.tab === 'workouts' ? 'home' : b.dataset.tab;
  go(v, {}, current.v === v || ['home', 'progress', 'data'].includes(current.v));
});
function setChrome(title, back, tab) {
  $('#title').textContent = title;
  $('#backBtn').classList.toggle('hide', !back);
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
}
async function render(st) {
  flushSave();
  releaseVideos();
  current = st;
  const view = $('#view');
  view.innerHTML = '';
  window.scrollTo(0, 0);
  if (st.v === 'workout') return renderWorkout(view, String(st.id));
  if (st.v === 'progress') return renderProgress(view);
  if (st.v === 'exhist') return renderExHistory(view, st.key);
  if (st.v === 'data') return renderData(view);
  return renderHome(view);
}

/* ---------------- Home ---------------- */
function wRow(w, hero = false) {
  const st = workoutStatus(w), t = parseTitle(w.title), today = todayISO();
  const d = parseISO(w.due);
  const pill = st === 'done' ? '<span class="pill done">Done ✓</span>'
    : st === 'prog' ? '<span class="pill prog">In progress</span>'
    : w.due === today ? '<span class="pill today">Today</span>'
    : w.rest_day ? '<span class="pill">Rest day</span>' : '';
  const names = (w.items || []).slice(0, 4).map(i => i.name).join(' · ');
  return `<a href="#" data-wid="${esc(w.id)}">
    <div class="daybox"><span>${esc(d.toLocaleDateString('en-GB', { month: 'short' }))}</span><b>${d.getDate()}</b></div>
    <div class="wl-main"><div class="wl-title">${esc(shortTitle(w))}${t.phase ? ` <span class="muted small">Phase ${t.phase}</span>` : ''}</div>
    <div class="wl-sub">${esc(fmtDate(w.due, { weekday: 'long' }))}${names ? ' — ' + esc(names) : ''}</div></div>${pill}</a>`;
}
function renderHome(view) {
  setChrome('Otter', false, 'workouts');
  if (!S.workouts.length) {
    view.innerHTML = `<div class="card empty"><div class="big">🏋️</div><h3>No workouts yet</h3>
      <p class="muted">Download your workout file on Wi-Fi, then import it here. After that, everything works with no signal.</p>
      <button class="btn primary" id="goImport">Import workouts</button></div>`;
    $('#goImport').onclick = () => go('data', {}, true);
    return;
  }
  const nx = upNext();
  let html = '';
  if (nx) html += `<h2>Up next</h2><div class="card wlist hero">${wRow(nx, true)}</div>`;
  const groups = new Map();
  for (const w of S.workouts) { const ph = parseTitle(w.title).phase; const k = ph ? `Phase ${ph}` : 'Other'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(w); }
  const curPhase = nx ? parseTitle(nx.title).phase : null;
  const keys = [...groups.keys()].sort((a, b) => (parseInt(b.replace(/\D/g, '')) || 0) - (parseInt(a.replace(/\D/g, '')) || 0));
  for (const k of keys) {
    const list = groups.get(k);
    const done = list.filter(w => workoutStatus(w) === 'done').length;
    const open = curPhase ? k === `Phase ${curPhase}` : k === keys[0];
    html += `<details class="phase" ${open ? 'open' : ''}><summary><h2 style="display:inline-flex">${esc(k)} <span class="pill">${done}/${list.length} done</span></h2></summary>
      <div class="card wlist">${list.map(w => wRow(w)).join('')}</div></details>`;
  }
  const missing = missingVideos();
  if (missing.length) html += `<p class="small muted" style="text-align:center">${missing.length} exercise video${missing.length > 1 ? 's' : ''} not on this phone yet — see Data.</p>`;
  view.innerHTML = html;
  view.querySelectorAll('a[data-wid]').forEach(a => a.onclick = e => { e.preventDefault(); go('workout', { id: a.dataset.wid }); });
}

/* ---------------- Videos ---------------- */
function videoBlock(exId, label = 'Play demo video') {
  const wrap = document.createElement('div');
  wrap.className = 'vidwrap';
  if (!exId) return wrap;
  exId = String(exId);
  const e = S.ex[exId] || {};
  const ytId = e.yt && e.yt.id;
  if (!S.videoKeys.has(exId)) {
    wrap.innerHTML = `<div class="vidph missing">🎬 Video not on this phone yet${ytId ? ` · <a href="https://youtu.be/${esc(ytId)}" target="_blank" rel="noopener" style="color:var(--link)">YouTube</a>` : ''}</div>`;
    return wrap;
  }
  const b = document.createElement('button');
  b.className = 'vidph'; b.innerHTML = `▶ ${esc(label)}`;
  b.onclick = async () => {
    const rec = await idbGet('videos', exId).catch(() => null);
    if (!rec || !rec.blob) { b.outerHTML = '<div class="vidph missing">Video could not be loaded — re-import it from Data.</div>'; return; }
    const url = URL.createObjectURL(rec.blob); blobUrls.push(url);
    const box = document.createElement('div'); box.className = 'vid';
    const v = document.createElement('video');
    v.src = url; v.controls = true; v.loop = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
    box.appendChild(v);
    const hide = document.createElement('button'); hide.className = 'more'; hide.textContent = 'Hide video';
    hide.onclick = () => { v.pause(); box.replaceWith(b); hide.remove(); };
    b.replaceWith(box); box.after(hide);
    v.play().catch(() => {});
  };
  wrap.appendChild(b);
  return wrap;
}
function missingVideos() {
  const need = new Set();
  S.workouts.forEach(w => allExerciseIds(w).forEach(id => need.add(id)));
  return [...need].filter(id => !S.videoKeys.has(id) && S.ex[id] && S.ex[id].yt && S.ex[id].yt.id);
}

/* ---------------- Logs ---------------- */
let pendingSave = null;
function getLog(wid) {
  if (!S.logs[wid]) S.logs[wid] = { wid, items: {}, note: '', started: null, finished: null, updated: null };
  return S.logs[wid];
}
function itemLog(log, item) {
  const k = String(item.id);
  if (!log.items[k]) {
    const { n } = parseSets(item.info);
    log.items[k] = { sets: Array.from({ length: n }, () => ({ kg: '', reps: '', done: false })), note: '', choice: item.alts && item.alts.length > 1 ? String(item.alts[0]) : null };
  }
  return log.items[k];
}
function saveLog(log, now = false) {
  log.updated = Date.now();
  if (!log.started) log.started = log.updated;
  S.logs[log.wid] = log;
  clearTimeout(pendingSave && pendingSave.t);
  const doSave = () => { pendingSave = null; return idbPut('logs', log.wid, JSON.parse(JSON.stringify(log))).catch(err => toast('Could not save: ' + err.message)); };
  if (now) return doSave();
  pendingSave = { t: setTimeout(doSave, 400), run: doSave };
}
function flushSave() { if (pendingSave) { clearTimeout(pendingSave.t); pendingSave.run(); } }
window.addEventListener('pagehide', flushSave);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });

function historyIndex(excludeWid) {
  // name -> list of {when, due, sets, wid, title}, newest first
  const idx = {};
  for (const [wid, log] of Object.entries(S.logs)) {
    if (wid === excludeWid) continue;
    const w = S.wById[wid]; if (!w) continue;
    for (const it of w.items || []) {
      const il = log.items && log.items[String(it.id)];
      if (!il) continue;
      const sets = (il.sets || []).filter(s => s.kg !== '' || s.reps !== '');
      if (!sets.length) continue;
      const key = norm(effName(it, il));
      (idx[key] = idx[key] || []).push({ when: log.finished || log.updated || 0, due: w.due, sets, wid, title: w.title, unit: parseSets(it.info).unit, note: il.note });
    }
  }
  for (const k in idx) idx[k].sort((a, b) => (b.due || '').localeCompare(a.due || '') || b.when - a.when);
  return idx;
}
const setStr = (s, unit) => s.kg !== '' && s.reps !== '' ? `${s.kg}kg × ${s.reps}${unit === 'secs' ? 's' : ''}` : s.kg !== '' ? `${s.kg}kg` : `${s.reps}${unit === 'secs' ? 's' : ' reps'}`;

/* ---------------- Rest timer ---------------- */
const T = { end: 0, h: null };
function beep() {
  try { const c = new (window.AudioContext || window.webkitAudioContext)(); const o = c.createOscillator(); const g = c.createGain(); o.frequency.value = 880; o.connect(g); g.connect(c.destination); g.gain.setValueAtTime(0.25, c.currentTime); o.start(); o.stop(c.currentTime + 0.35); setTimeout(() => c.close(), 600); } catch (e) {}
}
function startTimer(sec) {
  T.end = Date.now() + sec * 1000; T.fired = false;
  $('#timer').classList.remove('hide', 'over');
  clearInterval(T.h); T.h = setInterval(tick, 250); tick();
}
function tick() {
  const left = Math.round((T.end - Date.now()) / 1000);
  const a = Math.abs(left);
  $('#timerT').textContent = (left < 0 ? '+' : '') + Math.floor(a / 60) + ':' + pad(a % 60);
  if (left <= 0 && !T.fired) { T.fired = true; $('#timer').classList.add('over'); try { navigator.vibrate && navigator.vibrate([300, 150, 300]); } catch (e) {} beep(); }
}
function stopTimer() { clearInterval(T.h); $('#timer').classList.add('hide'); }
$('#timerStop').onclick = stopTimer;
$('#timerPlus').onclick = () => { T.end += 15000; if (T.end > Date.now()) { T.fired = false; $('#timer').classList.remove('over'); } tick(); };
$('#timerMinus').onclick = () => { T.end -= 15000; tick(); };

/* ---------------- Workout view ---------------- */
function renderWorkout(view, wid) {
  const w = S.wById[wid];
  if (!w) { go('home', {}, true); return; }
  const t = parseTitle(w.title);
  setChrome(shortTitle(w) + (t.phase ? ` · Phase ${t.phase}` : ''), true, 'workouts');
  const log = getLog(wid);
  const hist = historyIndex(wid);
  const labels = labelsFor(w);
  const groupLetters = [...new Set(labels.filter(l => /\d/.test(l)).map(l => l[0]))];

  const top = document.createElement('div');
  top.innerHTML = `<div class="row" style="justify-content:space-between;margin:2px 2px 12px"><div><div style="font-size:20px;font-weight:700">${esc(fmtDate(w.due, { weekday: 'long', day: 'numeric', month: 'long' }))}</div>
    <div class="muted small">${esc(w.title || '')}</div></div>${log.finished ? '<span class="pill done">Done ✓</span>' : ''}</div>`;
  view.appendChild(top);

  if (w.rest_day) {
    const c = document.createElement('div'); c.className = 'card';
    c.innerHTML = `<b>Rest day</b><div class="wu-text">${esc(w.rest_info || '')}</div>`; view.appendChild(c);
  }

  // Warm-up
  if ((w.warmup || '').trim() || (w.warmup_ex || []).length) {
    const c = document.createElement('details'); c.className = 'card';
    c.innerHTML = `<summary>🔥 Warm-up${(w.warmup_ex || []).length ? ` <span class="muted small">· ${(w.warmup_ex || []).length} exercise${(w.warmup_ex || []).length === 1 ? '' : 's'}</span>` : ''}</summary>`;
    const wx = document.createElement('div'); wx.className = 'wu-ex';
    (w.warmup_ex || []).forEach((id, i) => { const vb = videoBlock(id, `${i + 1}. ${exName(id)}`); if (!S.videoKeys.has(String(id))) vb.firstChild.innerHTML = `${i + 1}. ${esc(exName(id))} — <span class="small">video not on phone</span>`; wx.appendChild(vb); });
    c.appendChild(wx);
    if ((w.warmup || '').trim()) { const tx = document.createElement('div'); tx.className = 'wu-text'; tx.textContent = w.warmup.trim(); c.appendChild(tx); }
    view.appendChild(c);
  }

  // Exercises
  (w.items || []).forEach((item, i) => {
    const il = itemLog(log, item);
    const lab = labels[i];
    const gi = /\d/.test(lab) ? groupLetters.indexOf(lab[0]) : -1;
    const { presc, rest } = splitInfo(item.info);
    const { unit } = parseSets(item.info);
    const restT = parseRest(item.info);
    const card = document.createElement('div');
    card.className = 'card ex' + (gi >= 0 ? ` ss${(gi % 4) + 1}` : '');
    card.innerHTML = `<div class="exhead"><div class="lab">${esc(lab)}</div><div class="exname">${esc(item.name)}</div>${gi >= 0 ? '<span class="pill">Superset</span>' : ''}</div>
      <div class="presc">${esc(presc)}</div>${rest ? `<button class="more">Coaching notes</button><div class="coach hide">${esc(rest)}</div>` : ''}`;
    const moreBtn = card.querySelector('.more');
    if (moreBtn) moreBtn.onclick = () => { const c = card.querySelector('.coach'); c.classList.toggle('hide'); moreBtn.textContent = c.classList.contains('hide') ? 'Coaching notes' : 'Hide notes'; };

    // Variation choice
    const vidSlot = document.createElement('div');
    if (item.alts && item.alts.length > 1) {
      const alts = document.createElement('div'); alts.className = 'alts';
      item.alts.forEach(a => {
        const b = document.createElement('button'); b.textContent = exName(a); b.className = String(a) === String(il.choice) ? 'on' : '';
        b.onclick = () => { il.choice = String(a); saveLog(log); alts.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); releaseOne(); vidSlot.replaceChildren(videoBlock(a)); refreshLast(); };
        alts.appendChild(b);
      });
      card.appendChild(alts);
    }
    function releaseOne() { const v = vidSlot.querySelector('video'); if (v) v.pause(); }
    vidSlot.appendChild(videoBlock(itemVideoId(item, il)));
    card.appendChild(vidSlot);

    const lastEl = document.createElement('div'); lastEl.className = 'last';
    card.appendChild(lastEl);
    let lastSets = [];
    function refreshLast() {
      const all = hist[norm(effName(item, il))] || [];
      const h = all.find(x => (x.due || '') < (w.due || '')) || all[0];
      lastSets = h ? h.sets : [];
      lastEl.innerHTML = h ? `Last time (${esc(fmtDate(h.due))}): ${h.sets.map(s => esc(setStr(s, h.unit))).join(' · ')}` : '';
      card.querySelectorAll('tbody tr').forEach((tr, si) => { const ls = lastSets[si] || lastSets[lastSets.length - 1]; tr.querySelector('.kg').placeholder = ls && ls.kg !== '' ? ls.kg : 'kg'; tr.querySelector('.rp').placeholder = ls && ls.reps !== '' ? ls.reps : unit; });
    }

    const tbl = document.createElement('table'); tbl.className = 'sets';
    tbl.innerHTML = `<thead><tr><th style="text-align:center">Set</th><th>kg</th><th>${unit}</th><th></th></tr></thead><tbody></tbody>`;
    card.appendChild(tbl);
    const tb = tbl.querySelector('tbody');
    function drawSets() {
      tb.innerHTML = '';
      il.sets.forEach((s, si) => {
        const tr = document.createElement('tr'); if (s.done) tr.className = 'done';
        tr.innerHTML = `<td class="n">${si + 1}</td><td><input class="kg" inputmode="decimal" enterkeyhint="next" value="${esc(s.kg)}" aria-label="Set ${si + 1} kg"></td>
          <td><input class="rp" inputmode="decimal" enterkeyhint="done" value="${esc(s.reps)}" aria-label="Set ${si + 1} ${unit}"></td>
          <td style="width:54px"><button class="tick ${s.done ? 'on' : ''}" aria-label="Set ${si + 1} done">✓</button></td>`;
        tr.querySelector('.kg').oninput = e => { s.kg = e.target.value.trim(); saveLog(log); };
        tr.querySelector('.rp').oninput = e => { s.reps = e.target.value.trim(); saveLog(log); };
        tr.querySelector('.tick').onclick = e => {
          const ls = lastSets[si] || lastSets[lastSets.length - 1];
          if (!s.done && s.kg === '' && s.reps === '' && ls) { s.kg = ls.kg; s.reps = ls.reps; tr.querySelector('.kg').value = s.kg; tr.querySelector('.rp').value = s.reps; }
          s.done = !s.done; tr.classList.toggle('done', s.done); e.currentTarget.classList.toggle('on', s.done);
          saveLog(log, true);
          if (s.done && restT) startTimer(restT.lo);
          if (s.done) toastOnce(w);
        };
        tb.appendChild(tr);
      });
      refreshLast();
    }
    drawSets();
    const sb = document.createElement('div'); sb.className = 'setbtns';
    sb.innerHTML = `<button class="btn small">+ Set</button><button class="btn small">− Set</button>${restT ? `<button class="btn small" title="Start rest timer">⏱ ${restT.lo >= 60 && restT.lo % 60 === 0 ? restT.lo / 60 + ' min' : restT.lo + 's'}</button>` : ''}`;
    const [addB, remB, timB] = sb.querySelectorAll('button');
    addB.onclick = () => { il.sets.push({ kg: '', reps: '', done: false }); saveLog(log); drawSets(); };
    remB.onclick = () => { if (il.sets.length > 1) { il.sets.pop(); saveLog(log); drawSets(); } };
    if (timB) timB.onclick = () => startTimer(restT.lo);
    card.appendChild(sb);

    const nd = document.createElement('details'); nd.style.marginTop = '10px'; if ((il.note || '').trim()) nd.open = true;
    nd.innerHTML = `<summary class="small muted">Note</summary><textarea placeholder="How did it feel? Seat height, grip, etc."></textarea>`;
    const ta = nd.querySelector('textarea'); ta.value = il.note || ''; ta.oninput = () => { il.note = ta.value; saveLog(log); };
    card.appendChild(nd);
    view.appendChild(card);
  });

  // Cool-down
  if ((w.cooldown || '').trim() || (w.cooldown_ex || []).length) {
    const c = document.createElement('details'); c.className = 'card';
    c.innerHTML = `<summary>🧊 Cool-down</summary>`;
    const wx = document.createElement('div'); wx.className = 'wu-ex';
    (w.cooldown_ex || []).forEach((id, i) => wx.appendChild(videoBlock(id, `${i + 1}. ${exName(id)}`)));
    c.appendChild(wx);
    if ((w.cooldown || '').trim()) { const tx = document.createElement('div'); tx.className = 'wu-text'; tx.textContent = w.cooldown.trim(); c.appendChild(tx); }
    view.appendChild(c);
  }

  // Session note + finish
  const end = document.createElement('div'); end.className = 'card';
  end.innerHTML = `<b>Session note</b><textarea id="wnote" placeholder="Energy, sleep, anything to tell your coach"></textarea>
    <div style="margin-top:12px">${log.finished ? `<p class="small muted">Finished ${esc(fmtStamp(log.finished))}</p><button class="btn block" id="unfinish">Mark as not finished</button>` : '<button class="btn primary block" id="finish">Finish workout ✓</button>'}</div>`;
  view.appendChild(end);
  const wn = $('#wnote', end); wn.value = log.note || ''; wn.oninput = () => { log.note = wn.value; saveLog(log); };
  const fin = $('#finish', end), unf = $('#unfinish', end);
  if (fin) fin.onclick = async () => { log.finished = Date.now(); await saveLog(log, true); stopTimer(); toast('Workout saved 💪'); go('home', {}, true); };
  if (unf) unf.onclick = async () => { log.finished = null; await saveLog(log, true); render(current); };
}
let toastedFor = null;
function toastOnce(w) { if (toastedFor !== w.id && !navigator.onLine) { toastedFor = w.id; toast('Saved on this phone — no signal needed'); } }

/* ---------------- Progress ---------------- */
function renderProgress(view) {
  setChrome('Progress', false, 'progress');
  const done = S.workouts.filter(w => workoutStatus(w) === 'done');
  const idx = historyIndex(null);
  const names = Object.keys(idx).map(k => ({ key: k, name: displayNameFor(k), n: idx[k].length, last: idx[k][0].due })).sort((a, b) => (b.last || '').localeCompare(a.last || '') || a.name.localeCompare(b.name));
  const weekAgo = Date.now() - 7 * 864e5;
  const thisWeek = done.filter(w => (S.logs[String(w.id)].finished || 0) >= weekAgo).length;
  view.innerHTML = `<div class="card"><div class="row" style="justify-content:space-around;text-align:center">
      <div><div style="font-size:28px;font-weight:700">${done.length}</div><div class="small muted">workouts done</div></div>
      <div><div style="font-size:28px;font-weight:700">${thisWeek}</div><div class="small muted">in the last 7 days</div></div>
      <div><div style="font-size:28px;font-weight:700">${names.length}</div><div class="small muted">exercises logged</div></div></div></div>
    <h2>Exercise history</h2>
    ${names.length ? `<input type="search" id="exq" placeholder="Search exercises">
    <div class="card wlist" id="exlist" style="margin-top:10px">${names.map(n => `<a href="#" data-key="${esc(n.key)}"><div class="wl-main"><div class="wl-title">${esc(n.name)}</div><div class="wl-sub">${n.n} session${n.n > 1 ? 's' : ''} · last ${esc(fmtDate(n.last))}</div></div><span class="muted">›</span></a>`).join('')}</div>`
      : '<div class="card muted">Log a few sets and your history will show here.</div>'}
    <h2>Finished workouts</h2>
    ${done.length ? `<div class="card wlist">${done.slice().reverse().map(w => wRow(w)).join('')}</div>` : '<div class="card muted">Nothing finished yet.</div>'}
    <h2>Export</h2>
    <div class="card"><p class="small muted" style="margin-top:0">Save your logs as a spreadsheet (CSV) to keep, or to send to your coach.</p>
      <div class="row" style="flex-wrap:wrap"><button class="btn" id="csvShare">Share CSV</button><button class="btn" id="csvDl">Download CSV</button></div></div>`;
  view.querySelectorAll('a[data-wid]').forEach(a => a.onclick = e => { e.preventDefault(); go('workout', { id: a.dataset.wid }); });
  view.querySelectorAll('a[data-key]').forEach(a => a.onclick = e => { e.preventDefault(); go('exhist', { key: a.dataset.key }); });
  const q = $('#exq');
  if (q) q.oninput = () => { const s = norm(q.value); view.querySelectorAll('#exlist a').forEach(a => a.classList.toggle('hide', s && !a.dataset.key.includes(s))); };
  $('#csvShare').onclick = () => shareFile(logsCSV(), `Workout Log ${todayISO()}.csv`, 'text/csv');
  $('#csvDl').onclick = () => downloadFile(logsCSV(), `Workout Log ${todayISO()}.csv`, 'text/csv');
}
function displayNameFor(key) {
  for (const w of S.workouts) for (const it of w.items || []) {
    if (norm(it.name) === key) return it.name;
    for (const a of it.alts || []) if (norm(exName(a)) === key) return exName(a);
  }
  return key;
}
function renderExHistory(view, key) {
  const name = displayNameFor(key);
  setChrome(name, true, 'progress');
  const rows = historyIndex(null)[key] || [];
  const best = rows.flatMap(r => r.sets).reduce((m, s) => Math.max(m, parseFloat(s.kg) || 0), 0);
  view.innerHTML = `<div class="card"><div class="muted small">Heaviest logged</div><div style="font-size:28px;font-weight:700">${best ? best + ' kg' : '—'}</div></div>
    <div class="card hist"><table><thead><tr><th>Date</th><th>Sets</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td style="white-space:nowrap"><a href="#" data-wid="${esc(r.wid)}" style="color:var(--link)">${esc(fmtDate(r.due))}</a><div class="small muted">${esc(shortTitle(S.wById[r.wid] || {}))}</div></td>
      <td>${r.sets.map(s => esc(setStr(s, r.unit))).join('<br>')}${r.note ? `<div class="small muted">${esc(r.note)}</div>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  view.querySelectorAll('a[data-wid]').forEach(a => a.onclick = e => { e.preventDefault(); go('workout', { id: a.dataset.wid }); });
}
function csvCell(v) { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function logsCSV() {
  const out = [['Workout date', 'Workout', 'Finished', 'Label', 'Exercise', 'Set', 'kg', 'Reps/secs', 'Done', 'Exercise note', 'Session note']];
  for (const w of S.workouts) {
    const log = S.logs[String(w.id)]; if (!log) continue;
    const labels = labelsFor(w);
    (w.items || []).forEach((it, i) => {
      const il = log.items && log.items[String(it.id)]; if (!il) return;
      (il.sets || []).forEach((s, si) => { if (s.kg === '' && s.reps === '' && !s.done) return; out.push([w.due, w.title, log.finished ? fmtStamp(log.finished) : '', labels[i], effName(it, il), si + 1, s.kg, s.reps, s.done ? 'yes' : '', si === 0 ? il.note || '' : '', '']); });
    });
    if ((log.note || '').trim()) out.push([w.due, w.title, log.finished ? fmtStamp(log.finished) : '', '', '', '', '', '', '', '', log.note]);
  }
  return out.map(r => r.map(csvCell).join(',')).join('\r\n');
}
async function shareFile(text, name, type) {
  const f = new File([text], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [f] })) { try { await navigator.share({ files: [f], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  downloadFile(text, name, type);
}
function downloadFile(data, name, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

/* ---------------- Data / import ---------------- */
async function renderData(view) {
  setChrome('Data', false, 'data');
  const vk = S.videoKeys.size, miss = missingVideos();
  let est = null, persisted = null;
  try { est = await navigator.storage.estimate(); persisted = await navigator.storage.persisted(); } catch (e) {}
  const range = S.workouts.length ? `${fmtDate(S.workouts[0].due)} – ${fmtDate(S.workouts[S.workouts.length - 1].due)}` : '—';
  view.innerHTML = `<div class="card"><b>Import workouts & videos</b>
      <p class="small muted">Pick the <b>.tcb</b> workout file (or a .json / .mp4 file). Do this on Wi-Fi or with signal if the file is in the cloud; once imported, everything works offline.</p>
      <button class="btn primary block" id="imp">Choose file to import</button>
      <div id="impStatus" class="small muted" style="margin-top:8px"></div><div class="prog hide" id="impProg"><i></i></div></div>
    <div class="card"><b>On this phone</b><dl class="kv" style="margin-top:10px">
      <dt>Workouts</dt><dd>${S.workouts.length} (${esc(range)})</dd>
      <dt>Videos</dt><dd>${vk} saved${miss.length ? `, <span style="color:var(--warn)">${miss.length} missing</span>` : ' ✓'}</dd>
      <dt>Last import</dt><dd>${esc(S.meta.lastImport ? fmtStamp(S.meta.lastImport) : '—')}${S.meta.lastFile ? `<div class="small muted">${esc(S.meta.lastFile)}</div>` : ''}</dd>
      <dt>Storage used</dt><dd>${est ? fmtBytes(est.usage) : '—'}</dd>
      <dt>Protected</dt><dd>${persisted ? 'Yes ✓' : `No <button class="btn small" id="persist" style="margin-left:6px">Protect</button>`}</dd>
      <dt>App version</dt><dd>${APP_VERSION}</dd></dl>
      ${miss.length ? `<details style="margin-top:10px"><summary class="small">Missing videos</summary><ul class="small muted">${miss.map(id => `<li>${esc(exName(id))}</li>`).join('')}</ul></details>` : ''}</div>
    <div class="card"><b>Back up your logs</b><p class="small muted">Your sets and notes are only on this phone. Save a backup now and then (e.g. to Google Drive).</p>
      <div class="row" style="flex-wrap:wrap"><button class="btn" id="bk">Save backup</button><button class="btn" id="rs">Restore backup</button></div></div>
    <div class="card"><b>Reset</b><p class="small muted">Removes workouts, videos and logs from this phone.</p><button class="btn danger" id="wipe">Delete everything…</button></div>`;
  $('#imp').onclick = () => { fileMode = 'import'; $('#fileIn').value = ''; $('#fileIn').click(); };
  $('#rs').onclick = () => { fileMode = 'import'; $('#fileIn').value = ''; $('#fileIn').click(); };
  $('#bk').onclick = () => shareFile(JSON.stringify({ kind: 'gym-logs', version: 1, saved: new Date().toISOString(), logs: S.logs }), `Workout Log Backup ${todayISO()}.json`, 'application/json');
  const ps = $('#persist'); if (ps) ps.onclick = async () => { const ok = await navigator.storage.persist().catch(() => false); toast(ok ? 'Storage protected' : 'Chrome said no — install the app to your home screen first'); render(current); };
  const wipe = $('#wipe');
  wipe.onclick = async () => {
    if (wipe.dataset.arm !== '1') { wipe.dataset.arm = '1'; wipe.textContent = 'Tap again to delete everything'; setTimeout(() => { wipe.dataset.arm = ''; wipe.textContent = 'Delete everything…'; }, 4000); return; }
    for (const s of STORES) await idbClear(s);
    await loadState(); toast('Everything deleted'); render(current);
  };
}
let fileMode = 'import';
$('#fileIn').onchange = async e => {
  const files = [...e.target.files]; if (!files.length) return;
  if (current.v !== 'data') go('data', {}, true);
  await importFiles(files);
};
function setStatus(msg, frac) {
  const st = $('#impStatus'), pr = $('#impProg');
  if (st) st.textContent = msg;
  if (pr) { pr.classList.toggle('hide', frac == null); if (frac != null) pr.firstElementChild.style.width = Math.round(frac * 100) + '%'; }
}
async function importFiles(files) {
  let added = { w: 0, v: 0, logs: 0 }, errors = [];
  try { await navigator.storage.persist(); } catch (e) {}
  for (const f of files) {
    try {
      const head = new Uint8Array(await f.slice(0, 8).arrayBuffer());
      const magic = String.fromCharCode(...head);
      if (magic === 'TCBUNDLE') { const r = await importBundle(f); added.w += r.w; added.v += r.v; }
      else if (/\.json$/i.test(f.name) || head[0] === 0x7b) {
        const obj = JSON.parse(await f.text());
        if (obj.kind === 'gym-logs') added.logs += await restoreLogs(obj);
        else if (Array.isArray(obj.workouts)) added.w += await importData(obj);
        else throw new Error('not a workout file');
      } else if (/^video\//.test(f.type) || /\.(mp4|m4v|webm|mov)$/i.test(f.name)) {
        const id = (/^(\d+)/.exec(f.name) || [])[1];
        if (!id) throw new Error('video name must start with the exercise number');
        await idbPut('videos', id, { blob: f, type: f.type || 'video/mp4', size: f.size, name: f.name }); added.v++;
      } else throw new Error('unknown file type');
    } catch (err) { errors.push(`${f.name}: ${err.message}`); }
  }
  await idbPut('meta', 'lastImport', Date.now()); await idbPut('meta', 'lastFile', files.map(f => f.name).join(', '));
  await loadState();
  if (current.v === 'data') await render(current);
  const parts = [];
  if (added.w) parts.push(`${added.w} workouts`); if (added.v) parts.push(`${added.v} videos`); if (added.logs) parts.push(`${added.logs} logged sessions`);
  setStatus((parts.length ? 'Imported ' + parts.join(', ') + '.' : 'Nothing imported.') + (errors.length ? ' Problems: ' + errors.join('; ') : ''), null);
  toast(errors.length ? 'Import finished with problems' : 'Import complete ✓');
}
async function importData(obj) {
  const ws = obj.workouts || [];
  await idbWrite('workouts', st => ws.forEach(w => st.put(w, String(w.id))));
  const ex = obj.exercises || {};
  await idbWrite('exercises', st => Object.entries(ex).forEach(([k, v]) => st.put(v, String(k))));
  if (obj.coach) await idbPut('meta', 'coach', obj.coach);
  return ws.length;
}
async function importBundle(f) {
  const hb = await f.slice(8, 12).arrayBuffer();
  const len = new DataView(hb).getUint32(0, true);
  const hdr = JSON.parse(await f.slice(12, 12 + len).text());
  const base = 12 + len;
  setStatus('Importing workouts…', 0);
  const w = await importData(hdr);
  const vids = hdr.videos || [];
  let v = 0;
  for (const it of vids) {
    const blob = f.slice(base + it.offset, base + it.offset + it.size, it.type || 'video/mp4');
    await idbPut('videos', String(it.ex), { blob, type: it.type || 'video/mp4', size: it.size, name: it.name || '' });
    v++; setStatus(`Saving videos… ${v}/${vids.length}`, v / vids.length);
  }
  return { w, v };
}
async function restoreLogs(obj) {
  const logs = obj.logs || {}; let n = 0;
  for (const [wid, log] of Object.entries(logs)) {
    const mine = S.logs[wid];
    if (!mine || (log.updated || 0) > (mine.updated || 0)) { await idbPut('logs', wid, log); n++; }
  }
  return n;
}

/* ---------------- Online / offline ---------------- */
function netUI() { const on = navigator.onLine; $('#netDot').classList.toggle('off', !on); $('#netTxt').textContent = on ? 'Online' : 'Offline'; }
window.addEventListener('online', netUI); window.addEventListener('offline', netUI);

/* ---------------- Start ---------------- */
(async function start() {
  netUI();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.addEventListener('updatefound', () => { const nw = reg.installing; nw && nw.addEventListener('statechange', () => { if (nw.state === 'activated' && navigator.serviceWorker.controller) toast('App updated'); }); });
    }).catch(() => {});
  }
  try { await loadState(); } catch (e) { $('#view').innerHTML = `<div class="card">This browser blocked storage (${esc(e.message)}). Open the app from your home screen in Chrome.</div>`; return; }
  const st = history.state && history.state.v ? history.state : { v: 'home' };
  history.replaceState(st, '');
  render(st);
})();
