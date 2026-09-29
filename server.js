// docker-panel — painel web local para gerenciar todos os containers Docker da máquina.
const path = require('path');
const fs = require('fs');
const http = require('http');
const { execFile } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const Docker = require('dockerode');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PANEL_PORT) || 7777;
const DATA_FILE = path.join(__dirname, 'data', 'projects.json');
const STANDALONE = '__standalone__';

const docker = new Docker();
const app = express();
app.use(express.json());

// --- segurança ---------------------------------------------------------------
// O painel dá shell em qualquer container, então só aceita requisições vindas da
// própria página (bloqueia DNS rebinding e outros sites chamando localhost).
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
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

function containerInfo(c) {
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
  };
}

async function listProjects() {
  const containers = await docker.listContainers({ all: true });
  const known = loadKnown();
  let changed = false;
  const groups = {};

  for (const c of containers) {
    const labels = c.Labels || {};
    const name = labels['com.docker.compose.project'] || STANDALONE;
    groups[name] ??= [];
    groups[name].push(containerInfo(c));

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
  if (changed) saveKnown(known);

  const names = new Set([...Object.keys(groups), ...Object.keys(known)]);
  names.delete(STANDALONE);

  const projects = [...names].sort().map((name) => {
    const list = (groups[name] || []).sort((a, b) => a.name.localeCompare(b.name));
    const meta = known[name] || null;
    return {
      name,
      standalone: false,
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
  const base = ['compose', '-p', name];
  if (meta.workingDir) base.push('--project-directory', meta.workingDir);
  for (const f of meta.configFiles) base.push('-f', f);

  return new Promise((resolve, reject) => {
    execFile('docker', [...base, ...args], {
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

app.post('/api/projects/:name/:action', wrap(async (req) => {
  const { name, action } = req.params;
  const args = PROJECT_ACTIONS[action];
  if (!args) throw new Error('Ação inválida.');
  const meta = loadKnown()[name];
  const composeOk = meta && meta.configFiles.every((f) => fs.existsSync(f));
  return { output: composeOk ? await runCompose(name, args) : await runFallback(name, action) };
}));

app.delete('/api/projects/:name', wrap(async (req) => {
  const known = loadKnown();
  delete known[req.params.name];
  saveKnown(known);
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

  try {
    exec = await docker.getContainer(id).exec({
      Cmd: ['sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi'],
      Env: ['TERM=xterm-256color'],
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

server.listen(PORT, HOST, () => {
  console.log(`docker-panel rodando em http://${HOST}:${PORT}`);
});
