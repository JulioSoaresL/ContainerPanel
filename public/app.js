// docker-panel — frontend
const STANDALONE = '__standalone__';
const $ = (sel) => document.querySelector(sel);

const state = {
  projects: [],
  filter: '',
  busy: new Map(),            // ações em andamento: "p:nome" / "c:id" -> ação
  view: safeGet('view') === 'list' ? 'list' : 'tabs',   // visualização: cards em lista ou abas
  active: safeGet('activeTab'),   // projeto da aba selecionada
  collapsed: new Set(JSON.parse(safeGet('collapsed') || '[]')),   // cards recolhidos na lista
  moreOpen: false,                // menu "…" das abas que não cabem
  appsOpen: new Set(JSON.parse(safeGet('appsOpen') || '[]')),   // nomes de containers com a lista de projetos aberta
  showHidden: safeGet('showHidden') === '1',
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
    $('#summary').innerHTML = `<span class="stat error">Erro ao falar com o Docker: ${esc(e.message)}</span>`;
  }
}

async function runAction(key, action, label, fn) {
  if (state.busy.has(key)) return;
  state.busy.set(key, action);
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
  runAction(`p:${name}`, action, `${labels[action]} ${name}`, () => api('POST', `/api/projects/${encodeURIComponent(name)}/${action}`));
}

function containerAction(id, name, action) {
  const labels = { start: 'Iniciando', stop: 'Parando', restart: 'Reiniciando' };
  runAction(`c:${id}`, action, `${labels[action]} ${name}`, () => api('POST', `/api/containers/${id}/${action}`));
}

async function hideProject(name, hide) {
  await api('POST', `/api/projects/${encodeURIComponent(name)}/${hide ? 'hide' : 'unhide'}`).catch((e) => showToast(e.message, 'error'));
  refresh();
}

function removeProject(name) {
  if (!confirm(`Deletar os containers do projeto "${name}"?\n\nOs containers serão removidos (volumes são mantidos).`)) return;
  runAction(`p:${name}`, 'remove', `Deletando containers de ${name}`, () => api('POST', `/api/projects/${encodeURIComponent(name)}/remove`));
}

function removeContainer(id, name) {
  if (!confirm(`Deletar o container "${name}"?`)) return;
  runAction(`c:${id}`, 'rm', `Deletando ${name}`, () => api('DELETE', `/api/containers/${id}`));
}

// --- formatação --------------------------------------------------------------
const UNITS = { second: 's', minute: 'min', hour: 'h', day: ['dia', 'dias'], week: ['sem', 'sem'], month: ['mês', 'meses'], year: ['ano', 'anos'] };

// "36 minutes" / "About an hour" / "Less than a second" -> "36 min" / "1 h" / "<1 s"
function durPt(s) {
  s = s.replace(/less than a second/i, '<1 second').replace(/^(about )?an? /i, '1 ');
  return s.replace(/(<1|\d+) (second|minute|hour|day|week|month|year)s?/i, (_, n, u) => {
    const unit = UNITS[u.toLowerCase()];
    return `${n} ${Array.isArray(unit) ? unit[n === '1' ? 0 : 1] : unit}`;
  });
}

// Status do Docker ("Up 2 hours (healthy)", "Exited (1) 3 days ago"...) -> texto curto + selos.
function fmtStatus(c) {
  const s = c.status || '';
  const health = s.match(/\((healthy|unhealthy|health: starting)\)/i)?.[1].toLowerCase();
  let text = s;
  let exit = null;
  let m;
  if ((m = s.match(/^Up (.+?)(?: \(.*\))?$/))) text = `há ${durPt(m[1])}`;
  else if ((m = s.match(/^Exited \((\d+)\) (.+) ago$/))) { text = `parado há ${durPt(m[2])}`; exit = m[1] !== '0' ? m[1] : null; }
  else if (/^Created/.test(s)) text = 'criado';
  else if (/^Restarting/.test(s)) text = 'reiniciando';
  else if (/Paused/.test(s)) text = 'pausado';
  const badges = [
    health === 'healthy' ? '<span class="badge ok">healthy</span>' : '',
    health === 'unhealthy' ? '<span class="badge danger">unhealthy</span>' : '',
    health === 'health: starting' ? '<span class="badge warn">iniciando</span>' : '',
    exit ? `<span class="badge danger" title="código de saída">exit ${esc(exit)}</span>` : '',
  ].join('');
  return `<span class="c-status" title="${esc(s)}">${esc(text)}${badges}</span>`;
}

const tildify = (p) => (p || '').replace(/^\/home\/[^/]+(?=\/|$)/, '~');
const STATE_LABEL = { running: 'rodando', partial: 'parcial', stopped: 'parado', restarting: 'reiniciando' };

function btn(cls, attrs, label, busyAction, action, extra = '') {
  const spin = busyAction === action ? ' spinning' : '';
  return `<button class="btn ${cls}${spin}" ${attrs} ${extra}>${label}</button>`;
}

// --- render ------------------------------------------------------------------
const has = (s) => String(s ?? '').toLowerCase().includes(state.filter);

function matches(project, c) {
  if (!state.filter) return true;
  const hay = `${project.standalone ? 'avulsos standalone' : project.name} ${c?.name ?? ''} ${c?.image ?? ''} ${c?.service ?? ''}`.toLowerCase();
  return hay.includes(state.filter) || !!c?.apps?.some((a) => has(a.name));
}

function projectStatus(p) {
  if (p.containers.length === 0) return 'stopped';
  if (p.running === 0) return 'stopped';
  return p.running === p.containers.length ? 'running' : 'partial';
}

function render() {
  const visible = state.projects.filter((p) => !p.hidden);
  const hidden = state.projects.length - visible.length;
  const total = visible.reduce((n, p) => n + p.containers.length, 0);
  const running = visible.reduce((n, p) => n + p.running, 0);
  const projects = visible.filter((p) => !p.standalone).length;
  $('#summary').innerHTML = `
    <span class="stat"><span class="dot running"></span><b>${running}</b> rodando</span>
    <span class="stat"><span class="dot stopped"></span><b>${total - running}</b> parados</span>
    <span class="stat"><b>${projects}</b> projetos</span>
    ${hidden ? `<button class="btn ghost hidden-toggle ${state.showHidden ? 'active' : ''}" data-show-hidden="1" aria-pressed="${state.showHidden}" title="${state.showHidden ? 'Esconder' : 'Mostrar'} projetos ocultos">Ocultos (${hidden})</button>` : ''}`;

  const tabs = (state.showHidden ? state.projects : visible).map((p) => {
    const containers = p.containers.filter((c) => matches(p, c));
    const projectMatches = matches(p, null);
    if (state.filter && !projectMatches && containers.length === 0) return null;
    return { p, shown: projectMatches ? p.containers : containers };
  }).filter(Boolean);
  // A aba salva pode estar fora do filtro; mostra a primeira sem esquecer a escolha.
  const current = tabs.find((t) => t.p.name === state.active) || tabs[0];

  const list = state.view === 'list';
  document.body.dataset.view = state.view;
  for (const b of document.querySelectorAll('#view-toggle [data-view]')) {
    b.classList.toggle('active', b.dataset.view === state.view);
    b.setAttribute('aria-pressed', b.dataset.view === state.view);
  }

  // O refresh a cada 3s recria o HTML; devolve o foco ao mesmo controle (navegação por teclado).
  const focused = focusKey(document.activeElement);
  $('#ptabs').hidden = list;
  if (list) state.moreOpen = false;
  else renderTabs(tabs.map((t) => t.p), current?.p.name);
  const html = list
    ? tabs.map((t) => renderProject(t.p, t.shown, true)).join('')
    : current && renderProject(current.p, current.shown);
  $('#projects').innerHTML = html || (state.filter
    ? `<div class="empty"><p>Nada encontrado para “${esc(state.filter)}”.</p><button class="btn" data-clear="1">Limpar filtro</button></div>`
    : '<div class="empty"><p>Nenhum container encontrado.</p></div>');
  if (focused) [...document.querySelectorAll('#ptabs button, #projects button, #projects a')].find((el) => focusKey(el) === focused)?.focus();
}

function focusKey(el) {
  if (!el?.closest('#projects, #ptabs')) return null;
  return `${el.tagName}|${el.getAttribute('href') || ''}|${JSON.stringify({ ...el.dataset })}`;
}

// --- abas de projeto -----------------------------------------------------------
const tabLabel = (p) => (p.standalone ? 'Avulsos' : p.name);

function renderTabs(projects, active) {
  $('#ptab-list').innerHTML = projects.map((p) => {
    const on = p.name === active;
    return `
      <button class="ptab ${on ? 'active' : ''} ${p.hidden ? 'is-hidden' : ''}" role="tab" aria-selected="${on}" tabindex="${on ? 0 : -1}" data-tab="${esc(p.name)}" title="${esc(tabLabel(p))}">
        <span class="dot ${projectStatus(p)}"></span><span class="ptab-name">${esc(tabLabel(p))}</span><span class="ptab-count">${p.running}/${p.containers.length}</span>
      </button>`;
  }).join('');
  fitTabs();
}

// Esconde as abas que não cabem (de trás para frente, nunca a ativa) e as lista no menu "…".
function fitTabs() {
  if (state.view !== 'tabs') return;
  const list = $('#ptab-list');
  const more = $('#ptab-more');
  const menu = $('#ptab-menu');
  const tabs = [...list.children];
  for (const t of tabs) t.hidden = false;
  more.hidden = true;
  const overflow = [];
  if (list.scrollWidth > list.clientWidth) {
    more.hidden = false;
    for (let i = tabs.length - 1; i >= 0 && list.scrollWidth > list.clientWidth; i--) {
      if (tabs[i].classList.contains('active')) continue;
      tabs[i].hidden = true;
      overflow.unshift(tabs[i]);
    }
  }
  more.textContent = `… ${overflow.length}`;
  menu.replaceChildren(...overflow.map((t) => {
    const item = t.cloneNode(true);
    item.hidden = false;
    item.className = `ptab-item ${t.classList.contains('is-hidden') ? 'is-hidden' : ''}`;
    item.setAttribute('role', 'menuitem');
    item.removeAttribute('aria-selected');
    item.removeAttribute('tabindex');
    return item;
  }));
  if (!overflow.length) state.moreOpen = false;
  menu.hidden = !state.moreOpen;
  more.setAttribute('aria-expanded', state.moreOpen);
}

function selectTab(name) {
  state.active = name;
  state.moreOpen = false;
  safeSet('activeTab', name);
  render();
}

$('#ptabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id === 'ptab-more') {
    state.moreOpen = !state.moreOpen;
    fitTabs();
    if (state.moreOpen) $('#ptab-menu button')?.focus();
  } else if (b.dataset.tab) selectTab(b.dataset.tab);
});

// ←/→ trocam de aba entre as visíveis.
$('#ptab-list').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const tabs = [...$('#ptab-list').children].filter((t) => !t.hidden);
  const i = tabs.findIndex((t) => t.classList.contains('active'));
  const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
  if (!next) return;
  e.preventDefault();
  selectTab(next.dataset.tab);
  $('#ptab-list .ptab.active')?.focus();
});

document.addEventListener('click', (e) => {
  if (state.moreOpen && !e.target.closest('#ptabs')) {
    state.moreOpen = false;
    fitTabs();
  }
});

new ResizeObserver(() => fitTabs()).observe($('#ptabs'));

function renderProject(p, containers, collapsible = false) {
  const status = projectStatus(p);
  const busyAction = state.busy.get(`p:${p.name}`);
  const busy = !!busyAction;
  const collapsed = collapsible && state.collapsed.has(p.name) && !state.filter;
  const title = p.standalone ? 'Avulsos' : p.name;
  const sub = p.standalone ? 'containers fora de docker compose' : tildify(p.workingDir);
  // Sem compose no disco: subir/parar/reiniciar ainda funcionam direto nos containers, derrubar não.
  const dis = busy || (!p.composeAvailable && p.containers.length === 0) ? 'disabled' : '';
  const disDown = busy || !p.composeAvailable ? 'disabled' : '';
  const attrs = (a, label) => `data-p="${esc(p.name)}" data-a="${a}" title="${label}" aria-label="${label} ${esc(p.name)}"`;
  const allUp = p.containers.length > 0 && p.running === p.containers.length;
  const actions = p.standalone ? '' : `
    <div class="actions">
      ${!p.composeAvailable ? '<span class="badge warn" title="O arquivo docker-compose não existe mais no disco. Subir/Parar/Reiniciar agem direto nos containers; use Deletar containers no lugar de Derrubar.">compose ausente</span>' : ''}
      ${btn(`icon-btn ${allUp ? 'ghost up' : 'primary'}`, attrs('up', 'Subir'), '▲', busyAction, 'up', dis)}
      ${btn('icon-btn', attrs('restart', 'Reiniciar'), '↻', busyAction, 'restart', dis || (p.running ? '' : 'disabled'))}
      ${btn('icon-btn', attrs('stop', 'Parar'), '■', busyAction, 'stop', dis || (p.running ? '' : 'disabled'))}
      <span class="sep"></span>
      ${btn('icon-btn danger', attrs('down', 'Derrubar'), '▼', busyAction, 'down', disDown || (p.containers.length ? '' : 'disabled'))}
      ${btn('icon-btn danger', `data-remove="${esc(p.name)}" title="Deletar containers (remove containers e redes, mantém volumes)" aria-label="Deletar containers de ${esc(p.name)}"`, '🗑', busyAction, 'remove', busy || !p.containers.length ? 'disabled' : '')}
      <button class="btn ghost" data-hide="${esc(p.name)}" data-hidden="${p.hidden ? 1 : ''}">${p.hidden ? 'Mostrar' : 'Ocultar'}</button>
    </div>`;

  const rows = containers.length
    ? containers.map(renderContainer).join('')
    : '<div class="row-empty">Sem containers — use “Subir” para criar.</div>';

  return `
    <article class="card ${busy ? 'busy' : ''} ${p.hidden ? 'is-hidden' : ''}">
      <header class="card-head">
        ${collapsible ? `<button class="collapse" data-collapse="${esc(p.name)}" aria-expanded="${!collapsed}" title="Recolher/expandir">${collapsed ? '▸' : '▾'}</button>` : ''}
        <div class="title">
          <div class="title-line">
            <h2>${esc(title)}</h2>
            <span class="badge ${status === 'running' ? 'ok' : status === 'partial' ? 'warn' : ''}" title="${STATE_LABEL[status]}">
              <span class="dot ${status}"></span>${p.running}/${p.containers.length} rodando
            </span>
          </div>
          <span class="sub" title="${esc(p.workingDir || '')}">${esc(sub)}</span>
        </div>
        ${actions}
      </header>
      ${collapsed ? '' : `<div class="rows">${rows}</div>`}
    </article>`;
}

function renderContainer(c) {
  const running = c.state === 'running';
  const st = running ? 'running' : c.state === 'restarting' ? 'restarting' : 'stopped';
  const busyAction = state.busy.get(`c:${c.id}`);
  const dis = busyAction ? 'disabled' : '';
  const attrs = (a, label) => `data-c="${c.id}" data-n="${esc(c.name)}" data-a="${a}" title="${label}" aria-label="${label} ${esc(c.name)}"`;
  const ports = c.ports.map((p) =>
    `<a class="chip port" href="http://localhost:${p.public}" target="_blank" rel="noopener" title="${p.private}/${p.type}">:${p.public}</a>`).join('');
  const { apps, open } = visibleApps(c);
  const appsChip = running && c.apps?.length
    ? `<button class="chip apps-toggle ${open ? 'open' : ''}" data-apps="${esc(c.name)}" aria-expanded="${open}">${c.apps.length} projeto${c.apps.length > 1 ? 's' : ''} <span class="caret">${open ? '▾' : '▸'}</span></button>`
    : '';
  return `
    <div class="row ${busyAction ? 'busy' : ''}">
      <span class="dot ${st === 'restarting' ? 'partial' : st}" title="${STATE_LABEL[st]}" role="img" aria-label="${STATE_LABEL[st]}"></span>
      <div class="c-main">
        <span class="c-name">${esc(c.name)}</span>
        <span class="c-image" title="${esc(c.image)}">${esc(c.image)}</span>
      </div>
      ${fmtStatus(c)}
      <span class="c-ports">${ports}</span>
      <span class="c-apps">${appsChip}</span>
      <div class="actions">
        <div class="seg">
          ${running
            ? `${btn('', attrs('restart', 'Reiniciar'), '↻', busyAction, 'restart', dis)}${btn('', attrs('stop', 'Parar'), '■', busyAction, 'stop', dis)}`
            : btn('up', attrs('start', 'Iniciar'), '▶', busyAction, 'start', dis)}
          ${btn('danger', `data-rm="${c.id}" data-n="${esc(c.name)}" title="Deletar" aria-label="Deletar ${esc(c.name)}"`, '🗑', busyAction, 'rm', dis)}
        </div>
        <button class="btn term" ${running ? '' : 'disabled'} data-term="${c.id}" data-n="${esc(c.name)}">&gt;_ Terminal</button>
      </div>
    </div>${open ? renderApps(c, apps) : ''}`;
}

// Com filtro casando projetos internos, a lista abre sozinha mostrando só eles.
function visibleApps(c) {
  if (c.state !== 'running' || !c.apps?.length) return { apps: [], open: false };
  if (state.filter) {
    const hit = c.apps.filter((a) => has(a.name));
    if (hit.length) return { apps: hit, open: true };
  }
  return { apps: c.apps, open: state.appsOpen.has(c.name) };
}

function renderApps(c, apps) {
  const rows = apps.map((a) => {
    const link = a.url
      ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.url.replace(/^https?:\/\//, ''))} <span aria-hidden="true">↗</span></a>`
      : '<span class="muted">sem porta</span>';
    const pathHint = a.path.endsWith(`/${a.name}`) ? '' : `<span class="app-path">${esc(a.path)}</span>`;
    return `
      <div class="app-row">
        <span class="app-name" title="${esc(a.path)}">${esc(a.name)}${pathHint}</span>
        <span class="app-url">${link}</span>
        <button class="btn term" data-term="${c.id}" data-n="${esc(`${c.name}:${a.name}`)}" data-cwd="${esc(a.path)}" title="Terminal em ${esc(a.path)}">&gt;_ Terminal</button>
      </div>`;
  }).join('');
  return `<div class="apps">${rows}</div>`;
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
  } else if (b.dataset.apps) {
    const n = b.dataset.apps;
    state.appsOpen.has(n) ? state.appsOpen.delete(n) : state.appsOpen.add(n);
    safeSet('appsOpen', JSON.stringify([...state.appsOpen]));
    render();
  } else if (b.dataset.clear) clearSearch();
  else if (b.dataset.hide) hideProject(b.dataset.hide, !b.dataset.hidden);
  else if (b.dataset.remove) removeProject(b.dataset.remove);
  else if (b.dataset.rm) removeContainer(b.dataset.rm, b.dataset.n);
  else if (b.dataset.term) openTerminal(b.dataset.term, b.dataset.n, b.dataset.cwd);
  else if (b.dataset.p) projectAction(b.dataset.p, b.dataset.a);
  else if (b.dataset.c) containerAction(b.dataset.c, b.dataset.n, b.dataset.a);
});

$('#view-toggle').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (!b || b.dataset.view === state.view) return;
  state.view = b.dataset.view;
  safeSet('view', state.view);
  render();
});

$('#summary').addEventListener('click', (e) => {
  if (!e.target.closest('[data-show-hidden]')) return;
  state.showHidden = !state.showHidden;
  safeSet('showHidden', state.showHidden ? '1' : '');
  render();
});

$('#search').addEventListener('input', (e) => {
  state.filter = e.target.value.trim().toLowerCase();
  render();
});

function clearSearch() {
  $('#search').value = '';
  state.filter = '';
  render();
}

// "/" foca a busca; Esc limpa (fora de campos de texto e do terminal).
document.addEventListener('keydown', (e) => {
  const typing = e.target.closest('input, textarea, .xterm');
  if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    $('#search').focus();
  } else if (e.key === 'Escape' && state.moreOpen) {
    state.moreOpen = false;
    fitTabs();
    $('#ptab-more').focus();
  } else if (e.key === 'Escape' && e.target === $('#search')) {
    clearSearch();
    e.target.blur();
  }
});

// --- terminais ---------------------------------------------------------------
let termSeq = 0;

function openTerminal(containerId, name, cwd) {
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
  const ws = new WebSocket(`${proto}://${location.host}/ws/exec/${containerId}?cols=${term.cols}&rows=${term.rows}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ''}`);
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
  fitTabs();
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
