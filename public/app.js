// docker-panel — frontend
const STANDALONE = '__standalone__';
const $ = (sel) => document.querySelector(sel);

const state = {
  projects: [],
  filter: '',
  busy: new Set(),            // chaves de ações em andamento ("p:nome" / "c:id")
  collapsed: new Set(JSON.parse(safeGet('collapsed') || '[]')),
  terms: new Map(),           // id da aba -> { term, fit, ws, tab, pane }
  activeTerm: null,
};

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- API ---------------------------------------------------------------------
async function api(method, url) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function refresh() {
  try {
    state.projects = await api('GET', '/api/projects');
    render();
  } catch (e) {
    $('#summary').textContent = `Erro ao falar com o Docker: ${e.message}`;
  }
}

async function runAction(key, label, fn) {
  if (state.busy.has(key)) return;
  state.busy.add(key);
  render();
  const toast = showToast(`${label}…`, 'info', 0);
  try {
    const res = await fn();
    updateToast(toast, `${label}: ok`, 'ok', res?.output);
  } catch (e) {
    updateToast(toast, `${label}: falhou`, 'error', e.message);
  } finally {
    state.busy.delete(key);
    await refresh();
  }
}

function projectAction(name, action) {
  if (action === 'down' && !confirm(`Derrubar o projeto "${name}"?\n\nOs containers serão removidos (volumes são mantidos).`)) return;
  const labels = { up: 'Subindo', stop: 'Parando', down: 'Derrubando', restart: 'Reiniciando' };
  runAction(`p:${name}`, `${labels[action]} ${name}`, () => api('POST', `/api/projects/${encodeURIComponent(name)}/${action}`));
}

function containerAction(id, name, action) {
  const labels = { start: 'Iniciando', stop: 'Parando', restart: 'Reiniciando' };
  runAction(`c:${id}`, `${labels[action]} ${name}`, () => api('POST', `/api/containers/${id}/${action}`));
}

async function forgetProject(name) {
  if (!confirm(`Remover "${name}" da lista? (não mexe em nada no Docker)`)) return;
  await api('DELETE', `/api/projects/${encodeURIComponent(name)}`).catch((e) => showToast(e.message, 'error'));
  refresh();
}

// --- render ------------------------------------------------------------------
function matches(project, c) {
  if (!state.filter) return true;
  const hay = `${project.standalone ? 'avulsos standalone' : project.name} ${c?.name ?? ''} ${c?.image ?? ''} ${c?.service ?? ''}`.toLowerCase();
  return hay.includes(state.filter);
}

function projectStatus(p) {
  if (p.containers.length === 0) return 'stopped';
  if (p.running === 0) return 'stopped';
  return p.running === p.containers.length ? 'running' : 'partial';
}

function render() {
  const total = state.projects.reduce((n, p) => n + p.containers.length, 0);
  const running = state.projects.reduce((n, p) => n + p.running, 0);
  $('#summary').textContent = `${running} rodando · ${total} containers · ${state.projects.filter((p) => !p.standalone).length} projetos`;

  const html = state.projects.map((p) => {
    const containers = p.containers.filter((c) => matches(p, c));
    const projectMatches = matches(p, null);
    if (state.filter && !projectMatches && containers.length === 0) return '';
    const shown = projectMatches ? p.containers : containers;
    return renderProject(p, shown);
  }).join('');

  $('#projects').innerHTML = html || '<p class="empty">Nenhum container encontrado.</p>';
}

function renderProject(p, containers) {
  const status = projectStatus(p);
  const busy = state.busy.has(`p:${p.name}`);
  const collapsed = state.collapsed.has(p.name) && !state.filter;
  const title = p.standalone ? 'Avulsos' : p.name;
  const sub = p.standalone ? 'containers fora de docker compose' : (p.workingDir || '');
  // Sem compose no disco: subir/parar/reiniciar ainda funcionam direto nos containers, derrubar não.
  const dis = busy || (!p.composeAvailable && p.containers.length === 0) ? 'disabled' : '';
  const disDown = busy || !p.composeAvailable ? 'disabled' : '';
  const actions = p.standalone ? '' : `
    <div class="actions">
      ${!p.composeAvailable ? '<span class="warn" title="O arquivo docker-compose não existe mais no disco. Subir/Parar/Reiniciar agem direto nos containers; Derrubar fica indisponível.">compose ausente</span>' : ''}
      <button class="btn up" ${dis} data-p="${esc(p.name)}" data-a="up">▲ Subir</button>
      <button class="btn" ${dis || (p.running ? '' : 'disabled')} data-p="${esc(p.name)}" data-a="restart">↻ Reiniciar</button>
      <button class="btn" ${dis || (p.running ? '' : 'disabled')} data-p="${esc(p.name)}" data-a="stop">■ Parar</button>
      <button class="btn danger" ${disDown || (p.containers.length ? '' : 'disabled')} data-p="${esc(p.name)}" data-a="down">▼ Derrubar</button>
      ${p.containers.length === 0 ? `<button class="btn ghost" data-forget="${esc(p.name)}" title="Remover da lista">✕</button>` : ''}
    </div>`;

  const rows = containers.length
    ? containers.map(renderContainer).join('')
    : '<div class="row muted">Sem containers — use "Subir" para criar.</div>';

  return `
    <article class="card ${busy ? 'busy' : ''}">
      <header class="card-head">
        <button class="collapse" data-collapse="${esc(p.name)}" title="Recolher/expandir">${collapsed ? '▸' : '▾'}</button>
        <span class="dot ${status}"></span>
        <div class="title">
          <h2>${esc(title)}</h2>
          <span class="sub">${esc(sub)} · ${p.running}/${p.containers.length} rodando</span>
        </div>
        ${actions}
      </header>
      ${collapsed ? '' : `<div class="rows">${rows}</div>`}
    </article>`;
}

function renderContainer(c) {
  const running = c.state === 'running';
  const busy = state.busy.has(`c:${c.id}`);
  const dis = busy ? 'disabled' : '';
  const ports = c.ports.map((p) =>
    `<a href="http://localhost:${p.public}" target="_blank" rel="noopener" title="${p.private}/${p.type}">:${p.public}</a>`).join(' ');
  return `
    <div class="row ${busy ? 'busy' : ''}">
      <span class="dot ${running ? 'running' : c.state === 'restarting' ? 'partial' : 'stopped'}"></span>
      <div class="c-main">
        <span class="c-name">${esc(c.name)}</span>
        <span class="c-image">${esc(c.image)}</span>
      </div>
      <span class="c-status">${esc(c.status)}</span>
      <span class="c-ports">${ports}</span>
      <div class="actions">
        ${running
          ? `<button class="btn" ${dis} data-c="${c.id}" data-n="${esc(c.name)}" data-a="restart" title="Reiniciar">↻</button>
             <button class="btn" ${dis} data-c="${c.id}" data-n="${esc(c.name)}" data-a="stop" title="Parar">■</button>`
          : `<button class="btn up" ${dis} data-c="${c.id}" data-n="${esc(c.name)}" data-a="start" title="Iniciar">▶</button>`}
        <button class="btn term" ${running ? '' : 'disabled'} data-term="${c.id}" data-n="${esc(c.name)}">&gt;_ Terminal</button>
      </div>
    </div>`;
}

// --- eventos -----------------------------------------------------------------
$('#projects').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  if (b.dataset.collapse) {
    const n = b.dataset.collapse;
    state.collapsed.has(n) ? state.collapsed.delete(n) : state.collapsed.add(n);
    safeSet('collapsed', JSON.stringify([...state.collapsed]));
    render();
  } else if (b.dataset.forget) forgetProject(b.dataset.forget);
  else if (b.dataset.term) openTerminal(b.dataset.term, b.dataset.n);
  else if (b.dataset.p) projectAction(b.dataset.p, b.dataset.a);
  else if (b.dataset.c) containerAction(b.dataset.c, b.dataset.n, b.dataset.a);
});

$('#search').addEventListener('input', (e) => {
  state.filter = e.target.value.trim().toLowerCase();
  render();
});

// --- terminais ---------------------------------------------------------------
let termSeq = 0;

function openTerminal(containerId, name) {
  const key = `t${++termSeq}`;
  const section = $('#terminals');
  section.classList.remove('hidden', 'minimized');
  document.body.classList.add('has-terms');

  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.innerHTML = `<span class="tab-dot"></span><span>${esc(name)}</span><button class="tab-close" title="Fechar">×</button>`;
  $('#tabs').appendChild(tab);

  const pane = document.createElement('div');
  pane.className = 'term-pane';
  $('#term-panes').appendChild(pane);

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'ui-monospace, "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace',
    theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#58a6ff' },
    scrollback: 5000,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(pane);

  const entry = { term, fit, ws: null, tab, pane };
  state.terms.set(key, entry);
  activateTerm(key);

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/exec/${containerId}?cols=${term.cols}&rows=${term.rows}`);
  ws.binaryType = 'arraybuffer';
  entry.ws = ws;

  ws.onopen = () => { tab.classList.add('live'); term.focus(); };
  ws.onmessage = (ev) => term.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data));
  ws.onclose = () => {
    tab.classList.remove('live');
    tab.classList.add('dead');
    term.write('\r\n\x1b[2m[sessão encerrada]\x1b[0m\r\n');
  };
  term.onData((d) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: 'i', d })));
  term.onResize(({ cols, rows }) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: 'r', c: cols, r: rows })));

  tab.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-close')) closeTerm(key);
    else activateTerm(key);
  });
}

function activateTerm(key) {
  state.activeTerm = key;
  for (const [k, t] of state.terms) {
    t.tab.classList.toggle('active', k === key);
    t.pane.classList.toggle('active', k === key);
  }
  const t = state.terms.get(key);
  if (t) requestAnimationFrame(() => { t.fit.fit(); t.term.focus(); });
}

function closeTerm(key) {
  const t = state.terms.get(key);
  if (!t) return;
  t.ws?.close();
  t.term.dispose();
  t.tab.remove();
  t.pane.remove();
  state.terms.delete(key);
  if (state.terms.size === 0) {
    $('#terminals').classList.add('hidden');
    document.body.classList.remove('has-terms');
  } else if (state.activeTerm === key) {
    activateTerm([...state.terms.keys()].pop());
  }
}

$('#term-toggle').addEventListener('click', () => {
  const s = $('#terminals');
  s.classList.toggle('minimized');
  $('#term-toggle').textContent = s.classList.contains('minimized') ? '▴' : '▾';
  if (!s.classList.contains('minimized')) activateTerm(state.activeTerm);
});

window.addEventListener('resize', () => {
  const t = state.terms.get(state.activeTerm);
  if (t) t.fit.fit();
});

// --- toasts ------------------------------------------------------------------
function showToast(msg, kind = 'info', ttl = 4000) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<div class="toast-msg"></div><button class="toast-close">×</button>`;
  el.querySelector('.toast-msg').textContent = msg;
  el.querySelector('.toast-close').onclick = () => el.remove();
  $('#toasts').appendChild(el);
  if (ttl) setTimeout(() => el.remove(), ttl);
  return el;
}

function updateToast(el, msg, kind, detail) {
  el.className = `toast ${kind}`;
  el.querySelector('.toast-msg').textContent = msg;
  if (detail) {
    const pre = document.createElement('pre');
    pre.textContent = detail;
    el.appendChild(pre);
  }
  setTimeout(() => el.remove(), kind === 'error' ? 15000 : 5000);
}

// --- start -------------------------------------------------------------------
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 3000);
