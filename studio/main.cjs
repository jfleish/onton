const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');

const ADAPTER_VERSION = '1.0';
let mainWindow;
let activeProcess = null;
let stopping = false;
let state = { run: { id: null, mode: 'local', status: 'idle', startedAt: null, endedAt: null }, events: [], agents: {}, transcripts: {} };

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
    if (value && value.run && Array.isArray(value.events)) state = { ...state, ...value, agents: value.agents || {}, transcripts: value.transcripts || {} };
  } catch (_) { /* first local run */ }
  if (!activeProcess && state.run.status === 'running' && state.run.mode === 'real') {
    state.run = { ...state.run, status: 'failed', endedAt: new Date().toISOString() };
    state.events = [{ id: `recovery-${Date.now()}`, time: new Date().toISOString(), kind: 'system', title: 'Previous real run recovered', detail: 'Studio restarted without an attachable Onton process; the persisted run was fenced.' }, ...state.events].slice(0, 100);
  }
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
      const agent = state.agents[id];
      return { id, title: String(patch.title || `Patch ${number}`), owner: `patch-${number}`, status: agent?.status === 'blocked' ? 'blocked' : agent?.status === 'working' ? 'running' : agent?.status === 'idle' ? 'done' : 'queued', dependsOn: dependencies, progress: agent?.status === 'done' ? 100 : agent?.status === 'working' ? 50 : 0, detail: String(patch.description || patch.title || 'Local gameplan task') };
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
    mode: state.run.mode === 'real' ? 'real' : state.run.mode === 'simulated' ? 'simulated' : 'local',
    realEnabled: process.env.ONTON_STUDIO_ENABLE_REAL === '1',
    project: { root, name: path.basename(root), branch, dirty: Boolean(git(root, ['status', '--porcelain'])), updatedAt: new Date().toISOString(), gameplanPath: process.env.ONTON_STUDIO_GAMEPLAN || null },
    tasks,
    agents: Object.values(state.agents),
    events,
    transcripts: state.transcripts,
    run: state.run
  };
}
function startSimulation() {
  if (state.run.status === 'running') return snapshot();
  const root = projectRoot();
  state.run = { id: `simulation-${Date.now()}`, mode: 'simulated', status: 'running', startedAt: new Date().toISOString(), endedAt: null };
  emit({ id: `run-${Date.now()}`, time: new Date().toLocaleTimeString(), kind: 'system', title: 'Local simulation started', detail: 'No coordinator, workers, agents, or subprocesses were launched.' });
  setTimeout(() => {
    if (state.run.id && state.run.id.startsWith('simulation-') && state.run.status === 'running') {
      state.run = { ...state.run, status: 'completed', endedAt: new Date().toISOString() };
      emit({ id: `run-${Date.now()}`, time: new Date().toLocaleTimeString(), kind: 'milestone', title: 'Local simulation completed', detail: 'The local adapter persisted the run lifecycle without external side effects.' });
    }
  }, 1200);
  saveState(root);
  return snapshot();
}
function onHeadlessRecord(line) {
  let record;
  try { record = JSON.parse(line); } catch (_) { return; }
  const patchId = record.patch_id ? String(record.patch_id) : null;
  const taskId = patchId ? (patchId.startsWith('task-') ? patchId : `task-${patchId.replace(/^patch-/, '')}`) : null;
  if (taskId) {
    state.agents[taskId] = { id: taskId, name: taskId, role: 'Onton worker', status: 'working', taskId, accent: taskId, lastEvent: String(record.message || '') };
    if (/complete|published|merged|finished|success/i.test(String(record.message || ''))) state.agents[taskId].status = 'idle';
    if (/failed|error|attention|blocked/i.test(String(record.message || ''))) state.agents[taskId].status = 'blocked';
  }
  const isTranscript = record.source === 'transcript';
  if (isTranscript && taskId) state.transcripts[taskId] = [...(state.transcripts[taskId] || []), String(record.message || '')].slice(-200);
  emit({ id: `real-${Date.now()}-${Math.random().toString(16).slice(2)}`, time: new Date(record.timestamp ? record.timestamp * 1000 : Date.now()).toLocaleTimeString(), kind: isTranscript ? 'agent' : 'milestone', title: isTranscript ? 'Agent transcript' : 'Onton activity', detail: String(record.message || line), agentId: taskId || undefined });
}
function onHeadlessStderr(chunk) {
  const detail = String(chunk).trim();
  if (detail) emit({ id: `stderr-${Date.now()}`, time: new Date().toLocaleTimeString(), kind: 'system', title: 'Onton stderr', detail });
}
function onRealExit(code, signal) {
  const wasStopping = stopping;
  activeProcess = null;
  stopping = false;
  if (state.run.status === 'running') {
    state.run = { ...state.run, status: wasStopping ? 'cancelled' : code === 0 ? 'completed' : 'failed', endedAt: new Date().toISOString() };
    emit({ id: `exit-${Date.now()}`, time: new Date().toLocaleTimeString(), kind: wasStopping ? 'system' : code === 0 ? 'milestone' : 'system', title: wasStopping ? 'Real Onton run cancelled' : code === 0 ? 'Real Onton run completed' : 'Real Onton run failed', detail: `Process exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.` });
  }
}
function ontonExecutable(root) {
  const configured = process.env.ONTON_STUDIO_ONTON;
  const candidates = [configured, path.join(root, '_build', 'default', 'bin', process.platform === 'win32' ? 'main.exe' : 'main.exe'), path.join(root, '_build', 'default', 'bin', 'onton.exe')].filter(Boolean);
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error('Built Onton executable not found; set ONTON_STUDIO_ONTON');
  return executable;
}
function startReal() {
  if (process.env.ONTON_STUDIO_ENABLE_REAL !== '1') throw new Error('Real orchestration is disabled; set ONTON_STUDIO_ENABLE_REAL=1 for an explicitly guarded run');
  if (activeProcess || state.run.status === 'running') return snapshot();
  const root = projectRoot();
  const gameplan = process.env.ONTON_STUDIO_GAMEPLAN ? path.resolve(root, process.env.ONTON_STUDIO_GAMEPLAN) : '';
  if (!gameplan || !fs.existsSync(gameplan)) throw new Error('Real orchestration requires ONTON_STUDIO_GAMEPLAN');
  const executable = ontonExecutable(root);
  const runDir = path.join(app.getPath('userData'), 'real-runs', crypto.createHash('sha256').update(root).digest('hex').slice(0, 24));
  const dataDir = path.join(runDir, 'onton-data');
  const controlPath = path.join(runDir, 'control.endpoint');
  fs.mkdirSync(runDir, { recursive: true });
  const env = { ...process.env, ONTON_DATA_DIR: dataDir, ONTON_CONTROL_SOCKET: controlPath, ONTON_STUDIO_REAL_RUN: '1' };
  const args = ['--gameplan', gameplan, '--headless', '--headless-transcript', '--no-refresh'];
  activeProcess = spawn(executable, args, { cwd: root, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  stopping = false;
  state.agents = {};
  state.transcripts = {};
  state.run = { id: `real-${Date.now()}`, mode: 'real', status: 'running', startedAt: new Date().toISOString(), endedAt: null, pid: activeProcess.pid, controlPath };
  emit({ id: `run-${Date.now()}`, time: new Date().toLocaleTimeString(), kind: 'system', title: 'Real Onton run started', detail: 'The Studio main process launched the guarded headless Onton executable.' });
  let stdoutBuffer = '';
  activeProcess.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    lines.filter(Boolean).forEach(onHeadlessRecord);
  });
  activeProcess.stderr.on('data', onHeadlessStderr);
  activeProcess.on('error', (error) => onHeadlessStderr(error.message));
  activeProcess.on('close', onRealExit);
  saveState(root);
  return snapshot();
}
function stopRun() {
  if (activeProcess && state.run.status === 'running') {
    stopping = true;
    const pid = activeProcess.pid;
    if (process.platform === 'win32' && pid) spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else activeProcess.kill('SIGTERM');
    return snapshot();
  }
  if (state.run.status === 'running') {
    state.run = { ...state.run, status: 'cancelled', endedAt: new Date().toISOString() };
    emit({ id: `run-${Date.now()}`, time: new Date().toLocaleTimeString(), kind: 'system', title: 'Local run cancelled', detail: 'No external process tree was active.' });
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
  ipcMain.handle('studio:run-real', () => startReal());
  ipcMain.handle('studio:stop-run', () => stopRun());
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('before-quit', () => { if (activeProcess) { stopping = true; if (process.platform === 'win32' && activeProcess.pid) spawn('taskkill', ['/PID', String(activeProcess.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else activeProcess.kill('SIGTERM'); } });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
