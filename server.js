// docker-panel — painel web local para gerenciar todos os containers Docker da máquina.
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { execFile } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const Docker = require('dockerode');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PANEL_PORT) || 7777;
const DATA_FILE = path.join(process.env.PANEL_DATA_DIR || path.join(__dirname, 'data'), 'projects.json');
// O binário standalone do compose (usado no Flatpak) dispensa o CLI `docker`.
const COMPOSE_CMD = process.env.PANEL_COMPOSE_BIN ? [process.env.PANEL_COMPOSE_BIN] : ['docker', 'compose'];
const STANDALONE = '__standalone__';
const IGNORED = '__ignored__';   // projetos que o usuário removeu da lista
const SCAN_DIRS = (process.env.PANEL_SCAN_DIRS || os.homedir()).split(':').filter(Boolean);
const SCAN_DEPTH = 4;
const SCAN_TTL = 60 * 1000;
const COMPOSE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const SKIP_DIRS = new Set(['node_modules', 'vendor']);

const docker = new Docker();
const app = express();
app.use(express.json());

// --- segurança ---------------------------------------------------------------
// O painel dá shell em qualquer container, então só aceita requisições vindas da
// própria página (bloqueia DNS rebinding e outros sites chamando localhost).
// Preenchido em start(), quando a porta real é conhecida (pode ser 0 = porta livre).
const ALLOWED_HOSTS = new Set();
function isAllowed(headers, method) {
  if (!ALLOWED_HOSTS.has(headers.host)) return false;
  const origin = headers.origin;
  if (!origin) return method === 'GET';
  try { return ALLOWED_HOSTS.has(new URL(origin).host); } catch { return false; }
}
app.use((req, res, next) => (isAllowed(req.headers, req.method) ? next() : res.status(403).send('Forbidden')));

// --- projetos conhecidos (persistidos para sobreviver a um `compose down`) ----
function loadKnown() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
}
function saveKnown(known) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(known, null, 2));
}

// --- descoberta de arquivos compose no disco ----------------------------------
// Projetos derrubados com `compose down` não têm containers, então só dá para
// encontrá-los pelo arquivo compose.
function composeProjectName(file, dir) {
  try {
    const m = fs.readFileSync(file, 'utf8').match(/^name:\s*["']?([^"'\s#]+)/m);
    if (m) return m[1];
  } catch {}
  return path.basename(dir).toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

function scanComposeFiles() {
  const found = {};
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const files = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    const file = COMPOSE_NAMES.find((n) => files.has(n));
    if (file) {
      const name = composeProjectName(path.join(dir, file), dir);
      if (name && !found[name]) found[name] = { configFiles: [path.join(dir, file)], workingDir: dir };
    }
    if (depth >= SCAN_DEPTH) return;
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1);
    }
  };
  for (const root of SCAN_DIRS) walk(path.resolve(root), 0);
  return found;
}

let scanCache = { at: 0, projects: {} };
function scannedProjects() {
  if (Date.now() - scanCache.at > SCAN_TTL) scanCache = { at: Date.now(), projects: scanComposeFiles() };
  return scanCache.projects;
}

// --- projetos montados dentro dos containers ---------------------------------
const PROJECT_MARKERS = ['.git', 'composer.json', 'package.json', 'artisan', 'go.mod', 'pyproject.toml', 'requirements.txt', 'Gemfile'];
const NGINX_CONF_DIRS = ['/etc/nginx/conf.d', '/etc/nginx/sites-enabled'];

function isProjectDir(dir) {
  try { return fs.statSync(dir).isDirectory() && PROJECT_MARKERS.some((m) => fs.existsSync(path.join(dir, m))); } catch { return false; }
}

// Traduz um caminho de dentro do container para o host, pelos bind mounts.
function toHostPath(mounts, p) {
  const binds = (mounts || []).filter((m) => m.Type === 'bind').sort((a, b) => b.Destination.length - a.Destination.length);
  const m = binds.find((m) => p === m.Destination || p.startsWith(`${m.Destination}/`));
  return m ? m.Source + p.slice(m.Destination.length) : null;
}

// Lê os server blocks dos nginx rodando: server_name + porta publicada -> root/upstream.
function nginxRoutes(containers) {
  const routes = [];
  for (const c of containers) {
    if (c.State !== 'running' || !/nginx/.test(c.Image)) continue;
    const files = [];
    for (const m of c.Mounts || []) {
      if (m.Type !== 'bind' || !NGINX_CONF_DIRS.some((d) => m.Destination === d || m.Destination.startsWith(`${d}/`))) continue;
      try {
        if (fs.statSync(m.Source).isDirectory()) {
          for (const f of fs.readdirSync(m.Source)) {
            if (f.endsWith('.conf') || m.Destination.includes('sites-enabled')) files.push(path.join(m.Source, f));
          }
        } else files.push(m.Source);
      } catch {}
    }
    for (const file of files) {
      let text;
      try { text = fs.readFileSync(file, 'utf8').replace(/#.*$/gm, ''); } catch { continue; }
      for (const block of text.split(/\bserver\s*\{/).slice(1)) {
        const get = (re) => block.match(re)?.[1];
        const listen = Number(get(/\blisten\s+(?:[^\s;]*:)?(\d+)/) || 80);
        const pub = (c.Ports || []).find((p) => p.PrivatePort === listen && p.PublicPort)?.PublicPort;
        const serverName = get(/\bserver_name\s+([^\s;]+)/);
        if (!pub || !serverName || serverName === '_') continue;
        const root = get(/\broot\s+([^\s;]+)/);
        routes.push({
          url: `http://${serverName}${pub === 80 ? '' : `:${pub}`}`,
          root: root ? toHostPath(c.Mounts, root) : null,
          upstream: get(/\b(?:fastcgi_pass|proxy_pass)\s+(?:https?:\/\/)?([^\s:;/]+)/),
        });
      }
    }
  }
  return routes;
}

function containerApps(c, routes) {
  if (c.State !== 'running') return [];
  const names = new Set([c.Labels?.['com.docker.compose.service'], ...(c.Names || []).map((n) => n.replace(/^\//, ''))].filter(Boolean));
  const ports = (c.Ports || []).map((p) => p.PublicPort).filter(Boolean);
  const fallback = ports.length ? `http://localhost:${Math.min(...ports)}` : null;
  const apps = [];
  for (const m of c.Mounts || []) {
    if (m.Type !== 'bind' || !isProjectDir(m.Source)) continue;
    const inside = routes.filter((r) => r.root && (r.root === m.Source || r.root.startsWith(`${m.Source}/`)));
    const route = inside.find((r) => names.has(r.upstream)) || inside[0]
      || routes.find((r) => !r.root && names.has(r.upstream));
    apps.push({ name: path.basename(m.Destination), path: m.Destination, url: route?.url || fallback });
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

function containerInfo(c, routes) {
  const ports = [];
  const seen = new Set();
  for (const p of c.Ports || []) {
    if (!p.PublicPort || seen.has(p.PublicPort)) continue;
    seen.add(p.PublicPort);
    ports.push({ public: p.PublicPort, private: p.PrivatePort, type: p.Type });
  }
  ports.sort((a, b) => a.public - b.public);
  return {
    id: c.Id,
    name: (c.Names?.[0] || c.Id.slice(0, 12)).replace(/^\//, ''),
    service: c.Labels?.['com.docker.compose.service'] || null,
    image: c.Image,
    state: c.State,
    status: c.Status,
    ports,
    apps: containerApps(c, routes),
  };
}

async function listProjects() {
  const containers = await docker.listContainers({ all: true });
  const known = loadKnown();
  const ignored = new Set(known[IGNORED] || []);
  delete known[IGNORED];
  let changed = false;
  const groups = {};
  const routes = nginxRoutes(containers);

  for (const c of containers) {
    const labels = c.Labels || {};
    const name = labels['com.docker.compose.project'] || STANDALONE;
    groups[name] ??= [];
    groups[name].push(containerInfo(c, routes));

    if (name !== STANDALONE && labels['com.docker.compose.project.config_files']) {
      const entry = {
        configFiles: labels['com.docker.compose.project.config_files'].split(',').filter(Boolean),
        workingDir: labels['com.docker.compose.project.working_dir'] || null,
      };
      if (JSON.stringify(known[name]) !== JSON.stringify(entry)) {
        known[name] = entry;
        changed = true;
      }
    }
  }
  for (const [name, entry] of Object.entries(scannedProjects())) {
    if (known[name] || ignored.has(name)) continue;
    known[name] = entry;
    changed = true;
  }
  // Sem containers e sem o arquivo compose no disco (pasta apagada): não há o que mostrar.
  for (const [name, entry] of Object.entries(known)) {
    if (groups[name] || entry.configFiles.every((f) => fs.existsSync(f))) continue;
    delete known[name];
    ignored.delete(name);
    changed = true;
  }
  if (changed) saveKnown({ ...known, ...(ignored.size ? { [IGNORED]: [...ignored] } : {}) });

  const names = new Set([...Object.keys(groups), ...Object.keys(known)]);
  names.delete(STANDALONE);

  const projects = [...names].sort().map((name) => {
    const list = (groups[name] || []).sort((a, b) => a.name.localeCompare(b.name));
    const meta = known[name] || null;
    return {
      name,
      standalone: false,
      hidden: ignored.has(name),
      containers: list,
      running: list.filter((c) => c.state === 'running').length,
      configFiles: meta?.configFiles || [],
      workingDir: meta?.workingDir || null,
      composeAvailable: !!meta && meta.configFiles.every((f) => fs.existsSync(f)),
    };
  });

  if (groups[STANDALONE]) {
    const list = groups[STANDALONE].sort((a, b) => a.name.localeCompare(b.name));
    projects.push({
      name: STANDALONE,
      standalone: true,
      containers: list,
      running: list.filter((c) => c.state === 'running').length,
      configFiles: [],
      workingDir: null,
      composeAvailable: false,
    });
  }
  return projects;
}

function runCompose(name, args) {
  const meta = loadKnown()[name];
  if (!meta) return Promise.reject(new Error(`Projeto '${name}' desconhecido.`));
  const base = [...COMPOSE_CMD.slice(1), '-p', name];
  if (meta.workingDir) base.push('--project-directory', meta.workingDir);
  for (const f of meta.configFiles) base.push('-f', f);

  return new Promise((resolve, reject) => {
    execFile(COMPOSE_CMD[0], [...base, ...args], {
      cwd: meta.workingDir && fs.existsSync(meta.workingDir) ? meta.workingDir : undefined,
      maxBuffer: 20 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim();
      if (err) reject(new Error(output || err.message));
      else resolve(output);
    });
  });
}

// --- API ---------------------------------------------------------------------
const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) { res.status(500).json({ error: e.json?.message || e.message }); }
};

app.get('/api/projects', wrap(() => listProjects()));

const PROJECT_ACTIONS = {
  up: ['up', '-d'],
  stop: ['stop'],
  down: ['down'],
  restart: ['restart'],
};
// Sem arquivo compose no disco: ainda dá para iniciar/parar os containers existentes.
const FALLBACK_ACTIONS = { up: 'start', stop: 'stop', restart: 'restart' };
async function runFallback(name, action) {
  const method = FALLBACK_ACTIONS[action];
  if (!method) throw new Error(`'${action}' exige o arquivo docker-compose, que não existe mais no disco.`);
  const containers = await docker.listContainers({
    all: true,
    filters: { label: [`com.docker.compose.project=${name}`] },
  });
  const lines = [];
  for (const c of containers) {
    const cname = c.Names[0].replace(/^\//, '');
    if (method === 'start' && c.State === 'running') continue;
    if (method !== 'start' && c.State !== 'running') continue;
    await docker.getContainer(c.Id)[method]();
    lines.push(`${cname}: ${method} ok`);
  }
  return lines.join('\n') || 'Nada a fazer.';
}

// Remove containers e redes do projeto (volumes ficam), com ou sem o arquivo compose.
async function removeProject(name) {
  const filters = { label: [`com.docker.compose.project=${name}`] };
  const lines = [];
  for (const c of await docker.listContainers({ all: true, filters })) {
    await docker.getContainer(c.Id).remove({ force: true });
    lines.push(`${c.Names[0].replace(/^\//, '')}: removido`);
  }
  for (const n of await docker.listNetworks({ filters })) {
    await docker.getNetwork(n.Id).remove();
    lines.push(`rede ${n.Name}: removida`);
  }
  return lines.join('\n') || 'Nada a fazer.';
}

function setHidden(name, hidden) {
  const known = loadKnown();
  const list = new Set(known[IGNORED] || []);
  hidden ? list.add(name) : list.delete(name);
  known[IGNORED] = [...list];
  saveKnown(known);
  return { ok: true };
}

app.post('/api/projects/:name/hide', wrap((req) => setHidden(req.params.name, true)));
app.post('/api/projects/:name/unhide', wrap((req) => setHidden(req.params.name, false)));
app.post('/api/projects/:name/remove', wrap(async (req) => ({ output: await removeProject(req.params.name) })));

app.post('/api/projects/:name/:action', wrap(async (req) => {
  const { name, action } = req.params;
  const args = PROJECT_ACTIONS[action];
  if (!args) throw new Error('Ação inválida.');
  const meta = loadKnown()[name];
  const composeOk = meta && meta.configFiles.every((f) => fs.existsSync(f));
  return { output: composeOk ? await runCompose(name, args) : await runFallback(name, action) };
}));

app.delete('/api/containers/:id', wrap(async (req) => {
  await docker.getContainer(req.params.id).remove({ force: true });
  return { ok: true };
}));

app.post('/api/containers/:id/:action', wrap(async (req) => {
  const { id, action } = req.params;
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error('Ação inválida.');
  try {
    await docker.getContainer(id)[action]();
  } catch (e) {
    if (e.statusCode !== 304) throw e;  // 304 = já estava no estado pedido
  }
  return { ok: true };
}));

app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/vendor/addon-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));
app.use(express.static(path.join(__dirname, 'public')));

// --- terminal (WebSocket) ----------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const match = url.pathname.match(/^\/ws\/exec\/([a-zA-Z0-9_.-]+)$/);
  if (!match || !isAllowed(req.headers, 'WS')) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => openShell(ws, match[1], url.searchParams));
});

async function openShell(ws, id, params) {
  let size = { w: Number(params.get('cols')) || 120, h: Number(params.get('rows')) || 30 };
  let exec = null;
  let stream = null;
  const pending = [];   // teclas digitadas antes do shell ficar pronto

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'i' && typeof msg.d === 'string') {
      stream ? stream.write(msg.d) : pending.push(msg.d);
    } else if (msg.t === 'r' && msg.c > 0 && msg.r > 0) {
      size = { w: msg.c, h: msg.r };
      if (stream) exec.resize(size).catch(() => {});
    }
  });
  ws.on('close', () => stream?.end());

  const cwd = params.get('cwd');
  try {
    exec = await docker.getContainer(id).exec({
      Cmd: ['sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi'],
      Env: ['TERM=xterm-256color'],
      ...(cwd && /^\/[^\0]*$/.test(cwd) ? { WorkingDir: cwd } : {}),
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    });
    stream = await exec.start({ hijack: true, stdin: true, Tty: true });
    if (ws.readyState !== ws.OPEN) return stream.end();

    stream.on('data', (chunk) => ws.readyState === ws.OPEN && ws.send(chunk));
    stream.on('end', () => ws.close());
    stream.on('error', () => ws.close());
    await exec.resize(size).catch(() => {});
    for (const d of pending.splice(0)) stream.write(d);
  } catch (e) {
    if (ws.readyState === ws.OPEN) {
      ws.send(Buffer.from(`\r\n\x1b[31mErro ao abrir shell: ${e.json?.message || e.message}\x1b[0m\r\n`));
      ws.close();
    }
  }
}

function start({ port = PORT } = {}) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      const real = server.address().port;
      ALLOWED_HOSTS.add(`127.0.0.1:${real}`).add(`localhost:${real}`);
      resolve({ port: real, server });
    });
  });
}

module.exports = { start };

if (require.main === module) {
  start().then(({ port }) => console.log(`docker-panel rodando em http://${HOST}:${port}`));
}
