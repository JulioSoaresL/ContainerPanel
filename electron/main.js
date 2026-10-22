// docker-panel — app desktop: sobe o servidor do painel em uma porta livre e abre numa janela.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');

// Dados fora da pasta do app (no Flatpak /app é somente leitura).
process.env.PANEL_DATA_DIR ||= path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'docker-panel');

// Docker rootless: usa o socket do usuário se existir e o do sistema não.
if (process.env.XDG_RUNTIME_DIR) {
  const rootless = path.join(process.env.XDG_RUNTIME_DIR, 'docker.sock');
  if (!fs.existsSync('/run/docker.sock') && !fs.existsSync('/var/run/docker.sock') && fs.existsSync(rootless)) {
    process.env.DOCKER_HOST = `unix://${rootless}`;
  }
}

const { start } = require('../server');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let win = null;
let server = null;

function isLocal(url) {
  try { return ['127.0.0.1', 'localhost'].includes(new URL(url).hostname) && new URL(url).port === String(server.address().port); }
  catch { return false; }
}

async function createWindow() {
  let port;
  try {
    ({ port, server } = await start({ port: 0 }));
  } catch (e) {
    dialog.showErrorBox('Docker Panel', `Não foi possível iniciar o painel:\n${e.message}`);
    return app.quit();
  }

  win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Docker Panel',
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  // Links para portas dos containers e projetos abrem no navegador do sistema.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isLocal(url)) { e.preventDefault(); shell.openExternal(url); }
  });

  win.loadURL(`http://127.0.0.1:${port}`);
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  if (!gotLock) return;
  Menu.setApplicationMenu(null);
  return createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => server?.close());
