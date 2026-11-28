const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const net = require('node:net');
const ADAPTER_VERSION = '1.0';
let mainWindow, activeProcess, stopping = false, runtimeDataDir = '';
let config = { root: process.env.ONTON_STUDIO_PROJECT || process.cwd(), gameplan: process.env.ONTON_STUDIO_GAMEPLAN || '', backend: 'codex' };
let run = { id: null, mode: 'local', status: 'idle', startedAt: null, endedAt: null };
const now = () => new Date().toISOString();
function root() { const r = fs.realpathSync(config.root); if (!fs.statSync(r).isDirectory()) throw Error('Project is not a directory'); config.root = r; return r; }
function git(args) { return gitAt(root(), args); }
function gitAt(cwd, args) { try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 2500, windowsHide: true }).trim(); } catch (_) { return ''; } }
function key() { return crypto.createHash('sha256').update(root()).digest('hex').slice(0, 24); }
function localFile() { return path.join(app.getPath('userData'), 'projects', `${key()}.json`); }
function persisted() { try { return JSON.parse(fs.readFileSync(localFile(), 'utf8')); } catch (_) { return {}; } }
function save() { fs.mkdirSync(path.dirname(localFile()), { recursive: true }); fs.writeFileSync(localFile(), JSON.stringify({ config, run }, null, 2)); }
function dataDir() { const base = runtimeDataDir || run.dataDir || persisted().run?.dataDir || process.env.ONTON_DATA_DIR || path.join(app.getPath('userData'), 'real-runs', key(), 'onton-data'); if (fs.existsSync(path.join(base, 'snapshot.json'))) return base; try { const child = fs.readdirSync(base).map((name) => path.join(base, name)).find((candidate) => fs.existsSync(path.join(candidate, 'snapshot.json'))); if (child) return child; } catch (_) {} return base; }
function projectName() { const gp = readGameplan(); return String(gp?.project || gp?.project_name || path.basename(root())); }
function gameplanPath() { return config.gameplan ? path.resolve(root(), config.gameplan) : ''; }
function readGameplan() { try { return JSON.parse(fs.readFileSync(gameplanPath(), 'utf8')); } catch (_) { return null; } }
function records() { const file = path.join(dataDir(), 'events.jsonl'); try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((x) => JSON.parse(x)); } catch (_) { return []; } }
function snapshotFile() { try { return JSON.parse(fs.readFileSync(path.join(dataDir(), 'snapshot.json'), 'utf8')); } catch (_) { return null; } }
function sessionTranscripts() {
  const result = {};
  const sessions = path.join(dataDir(), 'sessions');
  if (!fs.existsSync(sessions)) return result;
  for (const name of fs.readdirSync(sessions)) {
    const metaPath = path.join(sessions, name, 'meta.json');
    const streamPath = path.join(sessions, name, 'stdout.jsonl');
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const taskId = `task-${String(meta.patch_id).replace(/^patch-/, '')}`;
      const lines = fs.readFileSync(streamPath, 'utf8').split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const record = JSON.parse(line);
        const item = record.item;
        if (record.type === 'item.completed' && item?.type === 'agent_message' && item.text) (result[taskId] ||= []).push(String(item.text));
        if (record.type === 'item.completed' && item?.type === 'command_execution' && item.aggregated_output) (result[taskId] ||= []).push(String(item.aggregated_output));
      }
    } catch (_) { /* incomplete session is not authoritative */ }
  }
  return result;
}
function taskStatus(agent) {
  if (!agent || typeof agent !== 'object') return 'queued';
  if (agent.intervention_reason || agent.wontdo_reason || agent.needs_intervention === true) return 'blocked';
  if (agent.busy === true || agent.current_op_state?.[0] === 'Running') return 'running';
  if (agent.merged === true || agent.completed === true || agent.status === 'done' || agent.status === 'completed' || agent.branch_reconcile?.publications?.length > 0) return 'done';
  return 'queued';
}
function authoritativeTasks(snap) {
  const agents = snap?.orchestrator?.agents || snap?.agents || {};
  const find = (id) => Array.isArray(agents) ? agents.find((a) => String(a.patch_id || a.id) === id || String(a.patch_id || a.id) === id.replace('task-', '')) : agents[id] || agents[id.replace('task-', '')];
  const patches = readGameplan()?.patches;
  return Array.isArray(patches) ? patches.map((p) => { const n = String(p.number); const a = find(`task-${n}`); const status = taskStatus(a); return { id: `task-${n}`, title: String(p.title || `Patch ${n}`), owner: `patch-${n}`, status, dependsOn: Array.isArray(p.dependsOn) ? p.dependsOn.map((x) => String(x).startsWith('task-') ? String(x) : `task-${x}`) : [], progress: status === 'done' ? 100 : status === 'running' ? 50 : 0, detail: String(p.description || p.title || '') }; }) : [];
}
function projected() {
  const persistedState = persisted(); if (persistedState.config) config = { ...config, ...persistedState.config }; if (persistedState.run && !activeProcess) run = persistedState.run;
  if (!activeProcess && run.status === 'running') { run = { ...run, status: 'failed', endedAt: now(), fenceReason: 'Studio restarted without an attachable Onton process' }; save(); }
  const snap = snapshotFile(), recs = records();
  const transcripts = sessionTranscripts();
  for (const r of recs) if (r.source === 'transcript' && r.patch_id != null) { const id = `task-${String(r.patch_id).replace(/^patch-/, '')}`; (transcripts[id] ||= []).push(String(r.message || r.text || '')); }
  const events = recs.slice(-100).reverse().map((r, i) => ({ id: String(r.id || `event-${i}`), time: r.ts ? new Date(Number(r.ts) * 1000).toLocaleTimeString() : now(), kind: r.source === 'transcript' ? 'agent' : 'milestone', title: r.source === 'transcript' ? 'Agent transcript' : String(r.kind || 'Onton event'), detail: String(r.message || r.text || JSON.stringify(r)), agentId: r.patch_id == null ? undefined : `task-${String(r.patch_id).replace(/^patch-/, '')}` }));
  const agents = projectedAgents(snap, transcripts);
  const artifacts = {}; const dir = path.join(dataDir(), 'artifacts'); try { for (const p of fs.readdirSync(dir)) { const d = path.join(dir, p); if (fs.statSync(d).isDirectory()) artifacts[p] = fs.readdirSync(d); } } catch (_) {} for (const agent of Object.values(snap?.orchestrator?.agents || {})) { const files = gitAt(agent.worktree_path, ['show', '--format=', '--name-only', agent.branch_reconcile?.publications?.at(-1)?.published_revision || '']); if (files) artifacts[String(agent.patch_id)] = [...new Set([...(artifacts[String(agent.patch_id)] || []), ...files.split(/\r?\n/).filter(Boolean)])]; }
  return { version: ADAPTER_VERSION, mode: run.mode === 'real' ? 'real' : run.mode === 'simulated' ? 'simulated' : 'local', realEnabled: process.env.ONTON_STUDIO_ENABLE_REAL === '1', project: { root: root(), name: path.basename(root()), branch: git(['branch', '--show-current']) || 'detached', dirty: Boolean(git(['status', '--porcelain'])), updatedAt: now(), gameplanPath: gameplanPath() || null, backend: "codex" }, tasks: authoritativeTasks(snap), agents, events, transcripts, artifacts, commits: publishedCommits(snap), run };
}
function publishedCommits(snap) { const values = []; const agents = snap?.orchestrator?.agents || {}; for (const agent of Object.values(agents)) for (const publication of agent.branch_reconcile?.publications || []) if (publication.published_revision) values.push(String(publication.published_revision)); return [...new Set(values)]; }
function projectedAgents(snap, transcripts) { const raw = snap?.orchestrator?.agents || snap?.agents || {}; const values = Array.isArray(raw) ? raw : Object.entries(raw).map(([id, v]) => ({ id, ...v })); return values.map((a) => { const id = `task-${String(a.patch_id || a.id).replace(/^patch-/, '')}`; const status = taskStatus(a); return { id, name: String(a.name || id), role: 'Onton worker', status: status === 'done' ? 'idle' : status === 'queued' ? 'waiting' : status, taskId: id, accent: id, lastEvent: (transcripts[id] || []).at(-1) || '' }; }); }
function emit() { save(); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('studio:event', projected()); }
function simulation() { run = { id: `simulation-${Date.now()}`, mode: 'simulated', status: 'running', startedAt: now(), endedAt: null }; save(); emit(); setTimeout(() => { if (run.status === 'running' && run.mode === 'simulated') { run = { ...run, status: 'completed', endedAt: now() }; save(); emit(); } }, 1200); return projected(); }
function executable() { const candidates = [process.env.ONTON_STUDIO_ONTON, path.join(__dirname, '..', '_build', 'default', 'bin', 'main.exe'), path.join(root(), '_build', 'default', 'bin', 'main.exe')].filter(Boolean); const found = candidates.find(fs.existsSync); if (!found) throw Error('Built Onton executable not found; set ONTON_STUDIO_ONTON'); return found; }
function readControlEndpoint() { try { return JSON.parse(fs.readFileSync(run.controlPath, 'utf8')); } catch (_) { return null; } }
function sendControl(command) {
  return new Promise((resolve) => {
    const endpoint = readControlEndpoint();
    if (!endpoint) return resolve(false);
    const socket = endpoint.transport === 'tcp' ? net.createConnection({ host: endpoint.host, port: endpoint.port }) : net.createConnection(endpoint.path || run.controlPath);
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 1500);
    let data = '';
    socket.on('connect', () => { if (endpoint.token) socket.write(`${endpoint.token}\n`); socket.write(`${JSON.stringify(command)}\n`); });
    socket.on('data', (chunk) => { data += chunk.toString(); if (data.includes('\n')) { clearTimeout(timer); socket.end(); try { const status = JSON.parse(data.trim()).status; resolve(status === 'accepted' || status === 'cancellation_requested'); } catch (_) { resolve(false); } } });
    socket.on('error', () => { clearTimeout(timer); resolve(false); });
    socket.on('close', () => { clearTimeout(timer); if (!data) resolve(false); });
  });
}
function startReal() { if (process.env.ONTON_STUDIO_ENABLE_REAL !== '1') throw Error('Real orchestration is disabled; set ONTON_STUDIO_ENABLE_REAL=1'); if (activeProcess || run.status === 'running') return projected(); const gp = gameplanPath(); if (!gp || !fs.existsSync(gp)) throw Error('Choose a local gameplan first'); const dir = path.join(app.getPath('userData'), 'real-runs', `${key()}-${Date.now()}`); fs.mkdirSync(dir, { recursive: true }); const controlPath = path.join(dir, 'control.endpoint'); runtimeDataDir = path.join(dir, 'onton-data'); const setsid = path.join(__dirname, '..', '_build', 'default', 'bin', 'setsid_exec', 'main.exe'); const env = { ...process.env, PATH: `${path.join(__dirname, '..', '_opam', 'lib', 'stublibs')};${path.join(__dirname, '..', '_opam', 'bin')};${process.env.LOCALAPPDATA || ''}\\opam\\.cygwin\\root\\usr\\x86_64-w64-mingw32\\sys-root\\mingw\\bin;${process.env.PATH || ''}`, ONTON_DATA_DIR: runtimeDataDir, ONTON_CONTROL_SOCKET: controlPath, ONTON_STUDIO_REAL_RUN: '1', ...(fs.existsSync(setsid) ? { ONTON_SETSID_EXEC: setsid } : {}) }; activeProcess = spawn(executable(), ['--forge', 'local', '--repo', root(), '--gameplan', gp, '--backend', 'codex', '--main-branch', 'main', '--headless', '--headless-transcript', '--no-refresh'], { cwd: root(), env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); run = { id: `real-${Date.now()}`, mode: 'real', status: 'running', startedAt: now(), endedAt: null, pid: activeProcess.pid, controlPath, dataDir: runtimeDataDir }; save(); activeProcess.stdout.on('data', emit); activeProcess.stderr.on('data', (x) => { const text = x.toString(); if (text.trim()) { console.error(text.trim()); emit(); } }); activeProcess.on('error', () => {}); activeProcess.on('close', (code, signal) => { const cancelled = stopping; activeProcess = null; stopping = false; if (run.status === 'running') { const final = snapshotFile(); const agents = Object.values(final?.orchestrator?.agents || {}); const complete = agents.length > 0 && agents.every((agent) => !agent.busy && (agent.merged || agent.branch_reconcile?.publications?.length > 0)); run = { ...run, status: cancelled ? 'cancelled' : code === 0 && complete ? 'completed' : 'failed', endedAt: now() }; } save(); emit(); }); emit(); return projected(); }
async function stop() {
  if (activeProcess && run.status === 'running') {
    const accepted = await sendControl({ version: 1, id: `studio-cancel-${Date.now()}`, type: 'cancel', payload: {} });
    if (accepted) await new Promise((resolve) => { const timer = setTimeout(resolve, 2500); activeProcess?.once('close', () => { clearTimeout(timer); resolve(); }); });
    if (activeProcess) { stopping = true; if (process.platform === 'win32') spawn('taskkill', ['/PID', String(activeProcess.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else activeProcess.kill('SIGTERM'); }
    return projected();
  }
  if (run.status === 'running') run = { ...run, status: 'cancelled', endedAt: now() };
  save(); return projected();
}
async function choose(kind) { const result = await dialog.showOpenDialog(mainWindow, { properties: kind === 'project' ? ['openDirectory'] : ['openFile'], filters: kind === 'gameplan' ? [{ name: 'Gameplan', extensions: ['json', 'yaml', 'yml', 'md'] }] : undefined }); if (!result.canceled && result.filePaths[0]) { if (kind === 'project') config.root = result.filePaths[0]; else config.gameplan = path.relative(root(), result.filePaths[0]); save(); } return projected(); }
function createWindow() { mainWindow = new BrowserWindow({ width: 1440, height: 940, title: 'onton studio', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } }); mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); mainWindow.loadFile(path.join(__dirname, 'index.html')); }
app.whenReady().then(() => { ipcMain.handle('studio:get-snapshot', () => projected()); ipcMain.handle('studio:choose-project', () => choose('project')); ipcMain.handle('studio:choose-gameplan', () => choose('gameplan')); ipcMain.handle('studio:choose-backend', () => projected()); ipcMain.handle('studio:run-simulation', simulation); ipcMain.handle('studio:run-real', startReal); ipcMain.handle('studio:stop-run', stop); createWindow(); });
app.on('before-quit', () => { if (activeProcess) stop(); });
