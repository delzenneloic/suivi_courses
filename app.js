'use strict';

// ====================================================================
// Configuration
// ====================================================================
const CLIENT_ID = '4855509636-ivkbqfrh8q2f7orpj50e7cgltkfm2vda.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive';   // lecture/écriture de fichiers créés hors de l'app (PC, tickets)
const LISTS_PREFIX = 'courses_from_';                     // nom des fichiers de liste : courses_from_AAAA-MM-JJ_to_AAAA-MM-JJ.json
const TICKETS_FOLDER = 'tickets';                         // dossier (à la racine du Drive) des tickets de caisse
const SYNC_DELAY = 2000;
const LS = { token: 'courses.token', lists: 'courses.lists', current: 'courses.current' };
const EXTRA_CATEGORY = 'Hors liste';

// ====================================================================
// État
// ====================================================================
// Fichier de liste (créé à la main sur le Drive) :
//   { version, from, to, createdAt, updatedAt,
//     items:   [{ id, category, name, qty, checked, extra }],
//     tickets: [{ fileId, name, date, magasin, total }] }

let lists = load(LS.lists) || [];        // [{ id, name, from, to, checked, count, total }] (métadonnées)
let current = load(LS.current) || null;  // { fileId, name, doc }
let view = { name: 'list', panel: null };
let ticketFiles = null;                  // tickets trouvés sur le Drive pour le panneau de liaison
let token = loadToken();
let tokenClient = null;
let pending = false, syncing = false, syncAgain = false, syncTimer = null, lastSync = null;
let loadingLists = false;

function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
function save(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
function loadToken() {
  const t = load(LS.token);
  return t && t.exp > Date.now() + 60000 ? t : null;
}
const uid = () => crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('fr-BE', { day: 'numeric', month: 'short' }) : '?';
const fmtDateFull = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('fr-BE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '?';
const fmtEur = n => n == null ? '—' : n.toLocaleString('fr-BE', { style: 'currency', currency: 'EUR' });
const periodOf = name => { const m = /courses_from_(\d{4}-\d{2}-\d{2})_to_?(\d{4}-\d{2}-\d{2})/.exec(name); return m ? { from: m[1], to: m[2] } : { from: null, to: null }; };
const ticketDate = (name, doc) => {
  let m = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(name);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(doc && doc.date || '');
  return m ? `20${m[1]}-${m[2]}-${m[3]}` : null;
};
const ticketsTotal = doc => doc.tickets.reduce((s, t) => s + (t.total || 0), 0);

function markChanged() {
  current.doc.updatedAt = new Date().toISOString();
  save(LS.current, current);
  pending = true;
  scheduleSync();
}

// ====================================================================
// Rendu
// ====================================================================
const app = document.getElementById('app');

function render() {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === view.name));
  if (view.name === 'lists') renderLists();
  else renderList();
  setStatus();
}

function renderLists() {
  const sorted = [...lists].sort((a, b) => b.name.localeCompare(a.name));
  app.innerHTML = `
    <div class="row between">
      <h2>Listes</h2>
      <button class="small" data-action="lists-refresh" ${token ? '' : 'disabled'}>Actualiser</button>
    </div>
    ${sorted.length ? `<div class="card-list">${sorted.map(l => `
      <button class="card ${current && current.fileId === l.id ? 'current' : ''}" data-action="list-open" data-id="${l.id}">
        <span class="period">${esc(fmtDate(l.from))} → ${esc(fmtDate(l.to))}</span>
        <span class="muted">${l.count != null ? `${l.checked}/${l.count} articles` : ''}${l.tickets ? ` · ${l.tickets} ticket${l.tickets > 1 ? 's' : ''}` : ''}</span>
        <span class="amount">${l.total != null ? fmtEur(l.total) : ''}</span>
      </button>`).join('')}</div>`
    : `<p class="empty">${loadingLists ? 'Recherche des listes sur le Drive…' : token ? 'Aucune liste trouvée. Dépose un fichier courses_from_AAAA-MM-JJ_to_AAAA-MM-JJ.json sur ton Drive.' : 'Connecte-toi à Google pour voir tes listes.'}</p>`}`;
}

function renderList() {
  if (!current) {
    app.innerHTML = `<p class="empty">${token ? 'Aucune liste ouverte. Choisis-en une dans l\'onglet Listes.' : 'Connecte-toi à Google (en haut à droite) pour charger la dernière liste.'}</p>`;
    return;
  }
  const d = current.doc;
  const cats = [];
  for (const it of d.items) { if (!cats.includes(it.category)) cats.push(it.category); }
  if (cats.includes(EXTRA_CATEGORY)) { cats.splice(cats.indexOf(EXTRA_CATEGORY), 1); cats.push(EXTRA_CATEGORY); }
  const done = d.items.filter(i => i.checked).length;

  app.innerHTML = `
    <div class="list-head">
      <h2>${esc(fmtDate(d.from))} → ${esc(fmtDate(d.to))}</h2>
      <p class="muted">${done}/${d.items.length} articles · ${d.tickets.length} ticket${d.tickets.length > 1 ? 's' : ''} · ${fmtEur(ticketsTotal(d))}</p>
    </div>
    ${cats.map(c => `
      <section class="cat">
        <h3>${esc(c)}</h3>
        ${d.items.filter(i => i.category === c).map(i => `
          <label class="item ${i.checked ? 'checked' : ''}" data-item="${i.id}">
            <input type="checkbox" data-f="checked" ${i.checked ? 'checked' : ''}>
            <span class="name">${esc(i.name)}${i.extra ? ' <em>ajouté</em>' : ''}</span>
            <span class="qty">${esc(i.qty)}</span>
            ${i.extra ? `<button class="icon danger" data-action="item-del" title="Retirer">×</button>` : ''}
          </label>`).join('')}
      </section>`).join('')}
    ${view.panel === 'add' ? `
      <section class="panel">
        <input id="add-name" placeholder="Article" autocomplete="off">
        <div class="row">
          <input id="add-qty" placeholder="Quantité" autocomplete="off">
          <button class="primary" data-action="item-add">Ajouter</button>
          <button data-action="panel" data-panel="">Annuler</button>
        </div>
      </section>`
    : `<button class="primary wide" data-action="panel" data-panel="add">Ajouter un achat hors liste</button>`}

    <section class="tickets">
      <h3>Tickets liés</h3>
      ${d.tickets.length ? d.tickets.map(t => `
        <div class="ticket" data-ticket="${t.fileId}">
          <span class="tdate">${esc(fmtDate(t.date))}</span>
          <span class="tname">${esc(t.magasin || t.name)}</span>
          <span class="amount">${fmtEur(t.total)}</span>
          <button class="icon danger" data-action="ticket-unlink" title="Délier">×</button>
        </div>`).join('')
      : `<p class="muted">Aucun ticket lié à cette liste.</p>`}
      ${view.panel === 'tickets' ? renderTicketPicker(d) : `<button class="wide" data-action="tickets-open" ${token ? '' : 'disabled'}>Lier un ticket</button>`}
    </section>`;
  if (view.panel === 'add') document.getElementById('add-name').focus();
}

function renderTicketPicker(d) {
  if (!ticketFiles) return `<p class="muted">Recherche des tickets sur le Drive…</p>`;
  const linked = new Set(d.tickets.map(t => t.fileId));
  const rows = ticketFiles.filter(f => !linked.has(f.id));
  return `
    <div class="panel">
      <div class="row between"><strong>Tickets sur le Drive</strong><button class="small" data-action="panel" data-panel="">Fermer</button></div>
      ${rows.length ? rows.map(f => {
        const date = ticketDate(f.name);
        const inPeriod = date && date >= d.from && date <= d.to;
        return `<button class="ticket pick ${inPeriod ? 'in-period' : ''}" data-action="ticket-link" data-id="${f.id}" data-name="${esc(f.name)}">
          <span class="tdate">${esc(fmtDate(date))}</span>
          <span class="tname">${esc(f.name)}</span>
          <span class="muted">${inPeriod ? 'dans la période' : ''}</span>
        </button>`; }).join('')
      : `<p class="muted">Aucun ticket à lier dans le dossier « ${esc(TICKETS_FOLDER)} ».</p>`}
    </div>`;
}

// ====================================================================
// Événements
// ====================================================================
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  switch (a) {
    case 'go': view = { name: el.dataset.view, panel: null }; render(); window.scrollTo(0, 0); break;
    case 'sync': token ? syncNow(true) : connect(); break;
    case 'panel': view.panel = el.dataset.panel || null; if (view.panel !== 'tickets') ticketFiles = null; render(); break;

    case 'lists-refresh': loadLists(true); break;
    case 'list-open': view = { name: 'list', panel: null }; await openList(el.dataset.id); break;

    case 'item-add': {
      const name = document.getElementById('add-name').value.trim();
      const qty = document.getElementById('add-qty').value.trim();
      if (!name) break;
      current.doc.items.push({ id: uid(), category: EXTRA_CATEGORY, name, qty, checked: true, extra: true });
      view.panel = null; markChanged(); render(); break;
    }
    case 'item-del': {
      e.preventDefault();
      const id = el.closest('[data-item]').dataset.item;
      current.doc.items = current.doc.items.filter(i => i.id !== id);
      markChanged(); render(); break;
    }

    case 'tickets-open': view.panel = 'tickets'; ticketFiles = null; render(); loadTickets(); break;
    case 'ticket-link': await linkTicket(el.dataset.id, el.dataset.name); break;
    case 'ticket-unlink': {
      const id = el.closest('[data-ticket]').dataset.ticket;
      current.doc.tickets = current.doc.tickets.filter(t => t.fileId !== id);
      markChanged(); render(); break;
    }
  }
});

app.addEventListener('change', e => {
  if (e.target.dataset.f !== 'checked') return;
  const it = current.doc.items.find(i => i.id === e.target.closest('[data-item]').dataset.item);
  it.checked = e.target.checked;
  e.target.closest('.item').classList.toggle('checked', it.checked);
  markChanged();
  const done = current.doc.items.filter(i => i.checked).length;
  app.querySelector('.list-head .muted').firstChild.textContent = `${done}/${current.doc.items.length} articles · `;
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.target.id === 'add-name' || e.target.id === 'add-qty')) document.querySelector('[data-action="item-add"]').click();
});

// ====================================================================
// Google Drive
// ====================================================================
window.gsiLoaded = function () {
  if (!CLIENT_ID.startsWith('COLLE_')) {
    tokenClient = google.accounts.oauth2.initTokenClient({ client_id: CLIENT_ID, scope: SCOPE, callback: onToken });
  }
  setStatus();
  if (token) start();
};
function connect() {
  if (!tokenClient) {
    alert(CLIENT_ID.startsWith('COLLE_') ? 'Colle ton client ID Google dans app.js (constante CLIENT_ID).'
      : 'Le script Google ne s\'est pas chargé. Vérifie la connexion puis recharge la page.');
    return;
  }
  tokenClient.requestAccessToken({ prompt: '' });
}
function onToken(r) {
  if (r.error) { setStatus('error', 'Connexion Google refusée'); return; }
  token = { value: r.access_token, exp: Date.now() + r.expires_in * 1000 };
  save(LS.token, token);
  start();
}
async function start() {
  if (current) { syncNow(true); loadLists(); }
  else {
    await loadLists();
    const latest = [...lists].sort((a, b) => b.name.localeCompare(a.name))[0];
    if (latest) await openList(latest.id);
  }
}

async function drive(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token.value } });
  if (r.status === 401) { token = null; localStorage.removeItem(LS.token); throw new Error('auth'); }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r;
}
const q = s => encodeURIComponent(s);
async function readJson(fileId) { return (await drive(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`)).json(); }
async function writeJson(fileId, doc) {
  await drive(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc) });
}

// --- Listes : tous les fichiers courses_from_*.json du Drive, avec leurs compteurs ---
async function loadLists(force = false) {
  if (!token || !navigator.onLine || loadingLists) return;
  loadingLists = true; if (view.name === 'lists') render();
  try {
    const query = `name contains '${LISTS_PREFIX}' and name contains '.json' and trashed = false`;
    const j = await (await drive(`https://www.googleapis.com/drive/v3/files?q=${q(query)}&fields=files(id,name)&pageSize=100&orderBy=name desc`)).json();
    const files = j.files || [];
    const docs = await Promise.all(files.map(f => readJson(f.id).catch(() => null)));
    lists = files.map((f, i) => {
      const d = docs[i]; const p = periodOf(f.name);
      return { id: f.id, name: f.name, from: d && d.from || p.from, to: d && d.to || p.to,
               count: d ? d.items.length : null, checked: d ? d.items.filter(x => x.checked).length : 0,
               tickets: d ? d.tickets.length : 0, total: d ? ticketsTotal(d) : null };
    });
    save(LS.lists, lists);
  } catch (e) { setStatus(e.message === 'auth' ? 'auth' : 'error'); }
  finally { loadingLists = false; if (view.name === 'lists') render(); }
}

async function openList(fileId) {
  if (current && current.fileId === fileId) { render(); return; }
  const meta = lists.find(l => l.id === fileId);
  current = null; pending = false; render();
  try {
    const doc = await readJson(fileId);
    normalize(doc, meta ? meta.name : '');
    current = { fileId, name: meta ? meta.name : '', doc };
    save(LS.current, current);
    lastSync = new Date();
    render();
  } catch (e) { setStatus(e.message === 'auth' ? 'auth' : 'error', e.message === 'auth' ? null : 'Impossible de lire la liste'); }
}
function normalize(doc, name) {
  const p = periodOf(name);
  doc.from = doc.from || p.from; doc.to = doc.to || p.to;
  doc.items = (doc.items || []).map(i => ({ id: i.id || uid(), category: i.category || 'Divers', name: i.name || '', qty: i.qty || '', checked: !!i.checked, extra: !!i.extra }));
  doc.tickets = doc.tickets || [];
  doc.updatedAt = doc.updatedAt || '1970-01-01T00:00:00.000Z';
}

// --- Tickets : fichiers JSON du dossier tickets ---
async function loadTickets() {
  try {
    const fq = `name = '${TICKETS_FOLDER}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const folders = (await (await drive(`https://www.googleapis.com/drive/v3/files?q=${q(fq)}&fields=files(id)`)).json()).files || [];
    if (!folders.length) { ticketFiles = []; render(); return; }
    const tq = `'${folders[0].id}' in parents and name contains '.json' and trashed = false`;
    const j = await (await drive(`https://www.googleapis.com/drive/v3/files?q=${q(tq)}&fields=files(id,name)&pageSize=100&orderBy=name desc`)).json();
    ticketFiles = j.files || [];
  } catch (e) { ticketFiles = []; setStatus(e.message === 'auth' ? 'auth' : 'error'); }
  if (view.panel === 'tickets') render();
}
async function linkTicket(fileId, name) {
  if (current.doc.tickets.some(t => t.fileId === fileId)) return;
  let t;
  try { t = await readJson(fileId); } catch { t = {}; }
  current.doc.tickets.push({ fileId, name, date: ticketDate(name, t), magasin: t.magasin && t.magasin.nom || null, total: typeof t.total === 'number' ? t.total : null });
  view.panel = null; ticketFiles = null;
  markChanged(); render();
}

// --- Synchronisation de la liste courante (même logique que Muscu : updatedAt départage) ---
function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(() => syncNow(), SYNC_DELAY); setStatus(); }
async function syncNow(pull = false) {
  if (!token || !navigator.onLine || !current) { setStatus(); return; }
  if (syncing) { syncAgain = true; return; }
  syncing = true; setStatus('saving');
  try {
    if (pull) {
      const remote = await readJson(current.fileId);
      normalize(remote, current.name);
      if (remote.updatedAt > current.doc.updatedAt) { current.doc = remote; save(LS.current, current); pending = false; render(); }
      else if (remote.updatedAt < current.doc.updatedAt) pending = true;
    }
    if (pending) { pending = false; await writeJson(current.fileId, current.doc); }
    lastSync = new Date(); setStatus('ok');
  } catch (e) {
    if (e.message === 'auth') setStatus('auth');
    else { pending = true; setStatus('error'); }
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; scheduleSync(); }
  }
}

function setStatus(kind, text) {
  const el = document.getElementById('sync');
  if (!kind) {
    if (!tokenClient) { kind = 'off'; text = CLIENT_ID.startsWith('COLLE_') ? 'Drive non configuré' : 'Google indisponible'; }
    else if (!token) { kind = 'auth'; text = 'Se connecter à Google'; }
    else if (!navigator.onLine) { kind = 'off'; text = pending ? 'Hors ligne · modifs en attente' : 'Hors ligne'; }
    else if (pending) { kind = 'saving'; text = 'Modifications en attente'; }
    else if (lastSync) { kind = 'ok'; text = 'Synchronisé ' + lastSync.toLocaleTimeString('fr-BE', { hour: '2-digit', minute: '2-digit' }); }
    else { kind = 'saving'; text = 'Lecture de Drive…'; }
  } else if (!text) {
    text = { saving: 'Enregistrement…', ok: 'Synchronisé ' + new Date().toLocaleTimeString('fr-BE', { hour: '2-digit', minute: '2-digit' }),
             error: 'Non synchronisé · réessayer', auth: 'Reconnecter Google' }[kind];
  }
  el.className = 'sync ' + kind; el.textContent = text;
}
window.addEventListener('online', () => { if (pending) scheduleSync(); else setStatus(); });
window.addEventListener('offline', () => setStatus());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && token && token.exp < Date.now() + 60000) { token = null; localStorage.removeItem(LS.token); setStatus(); }
});

// ====================================================================
// Démarrage
// ====================================================================
render();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
