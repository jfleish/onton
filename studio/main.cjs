const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ADAPTER_VERSION = '1.0';
let mainWindow;
let timers = [];
let state = { run: { id: null, status: 'idle', startedAt: null, endedAt: null }, events: [] };

function projectRoot() {
  const requested = process.env.ONTON_STUDIO_PROJECT || process.cwd();
  const resolved = fs.realpathSync(requested);
  if (!fs.statSync(resolved).isDirectory()) throw new Error('Studio project is not a directory');
  return resolved;
}
function git(root, args) {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 2500, windowsHide: true }).trim(); }
  catch (_) { return ''; }
}
function stateFile(root) {
  const key = crypto.createHash('sha256').update(root).digest('hex').slice(0, 24);
  return path.join(app.getPath('userData'), 'projects', `${key}.json`);
}
function loadState(root) {
  try {
    const value = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
    if (value && value.run && Array.isArray(value.events)) state = value;
  } catch (_) { /* first local run */ }
}
function saveState(root) {
  const file = stateFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
}
function emit(event) {
  state.events = [event, ...state.events].slice(0, 100);
  const root = projectRoot();
  saveState(root);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('studio:event', event);
}
function discoverTasks(root) {
  const requested = process.env.ONTON_STUDIO_GAMEPLAN;
  let file = requested ? path.resolve(root, requested) : '';
  if (!file) {
    const dir = path.join(root, 'gameplans');
    const candidates = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort() : [];
    file = candidates.length ? path.join(dir, candidates[0]) : '';
  }
  if (!file || !fs.existsSync(file)) return [];
  try {
    const document = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(document.patches) ? document.patches.map((patch) => {
      const number = Number(patch.number);
      const id = `task-${number}`;
      const dependencies = Array.isArray(patch.dependsOn) ? patch.dependsOn.map(String).map((value) => value.startsWith('task-') ? value : `task-${value}`) : [];
      return { id, title: String(patch.title || `Patch ${number}`), owner: `patch-${number}`, status: 'queued', dependsOn: dependencies, progress: 0, detail: String(patch.description || patch.title || 'Local gameplan task') };
    }) : [];
  } catch (_) { return []; }
}
function snapshot() {
  const root = projectRoot();
  loadState(root);
  const branch = git(root, ['branch', '--show-current']) || 'detached';
  const tasks = discoverTasks(root);
  const events = state.events.length ? state.events : [{ id: `discovery-${Date.now()}`, time: new Date().toLocaleTimeString(), kind: 'system', title: 'Project discovered', detail: 'Local project metadata loaded by the Studio main process.' }];
  return {
    version: ADAPTER_VERSION,
    mode: 'local',
    project: { root, name: path.basename(root), branch, dirty: Boolean(git(root, ['status', '--porcelain'])), updatedAt: new Date().toISOString(), gameplanPath: process.env.ONTON_STUDIO_GAMEPLAN || null },
    tasks,
    agents: [],
    events,
    transcripts: {},
    run: state.run
  };
}
function startSimulation() {
  if (state.run.status === 'running') return snapshot();
  const root = projectRoot();
  state.run = { id: `simulation-${Date.now()}`, status: 'running', startedAt: new Date().toISOString(), endedAt: null };
  emit({ id: `run-${Date.now()}`, time: new Date().toLocaleTimeString(), kind: 'system', title: 'Local simulation started', detail: 'No coordinator, workers, agents, or subprocesses were launched.' });
  timers.push(setTimeout(() => {
    state.run = { ...state.run, status: 'completed', endedAt: new Date().toISOString() };
    emit({ id: `run-${Date.now()}`, time: new Date().toLocaleTimeString(), kind: 'milestone', title: 'Local simulation completed', detail: 'The local adapter persisted the run lifecycle without external side effects.' });
  }, 1200));
  saveState(root);
  return snapshot();
}
function stopRun() {
  timers.forEach(clearTimeout); timers = [];
  if (state.run.status === 'running') {
    state.run = { ...state.run, status: 'cancelled', endedAt: new Date().toISOString() };
    emit({ id: `run-${Date.now()}`, time: new Date().toLocaleTimeString(), kind: 'system', title: 'Local run cancelled', detail: 'No external process tree was active in local-only mode.' });
  }
  return snapshot();
}
function createWindow() {
  mainWindow = new BrowserWindow({ width: 1440, height: 940, minWidth: 1100, minHeight: 720, title: 'onton studio', backgroundColor: '#0b0d14', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}
app.whenReady().then(() => {
  ipcMain.handle('studio:get-snapshot', () => snapshot());
  ipcMain.handle('studio:run-simulation', () => startSimulation());
  ipcMain.handle('studio:stop-run', () => stopRun());
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { timers.forEach(clearTimeout); if (process.platform !== 'darwin') app.quit(); });
