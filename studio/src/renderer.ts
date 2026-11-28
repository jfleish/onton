import type { StudioAgent, StudioSnapshot, StudioTask } from "./adapter.js";
import { layoutTasks } from "./graph.js";

const app = document.querySelector<HTMLDivElement>("#app")!;
let snapshot: StudioSnapshot | undefined;
let page = "gameplan";
let selectedTask = "";
let toast = "";
let error = "";
let graphScale = 1;
let graphPan = { x: 0, y: 0 };
let dragging = false;
let dragStart = { x: 0, y: 0 };
let panStart = { x: 0, y: 0 };

const esc = (value: unknown) => String(value ?? "").replace(/[&<>\"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]!));
const label = (value: string) => value ? value[0].toUpperCase() + value.slice(1) : "Unknown";
const currentTask = () => snapshot?.tasks.find((item) => item.id === selectedTask);
const currentAgent = (task: StudioTask | undefined): StudioAgent | undefined => task?.agentId ? snapshot?.agents.find((item) => item.id === task.agentId) : undefined;
const badge = (value: string) => `<span class="badge badge-${esc(value)}"><i></i>${esc(label(value))}</span>`;
const statusText = (task: StudioTask) => task.status === "done" ? "Complete" : label(task.status);

function navItem(id: string, text: string, icon: string) {
  return `<button class="nav-item ${page === id ? "active" : ""}" data-page="${id}" aria-current="${page === id ? "page" : "false"}"><span class="nav-icon">${icon}</span>${text}</button>`;
}

function graph() {
  const tasks = snapshot?.tasks ?? [];
  const points = layoutTasks(tasks);
  const maxX = Math.max(0, ...[...points.values()].map((point) => point.x));
  const maxY = Math.max(0, ...[...points.values()].map((point) => point.y));
  const width = Math.max(760, maxX + 360);
  const height = Math.max(330, maxY + 180);
  const edge = (from: string, to: string, active: boolean) => { const a = points.get(from), b = points.get(to); if (!a || !b) return ""; return `<path class="edge ${active ? "edge-active" : ""}" d="M ${a.x + 216} ${a.y + 46} C ${a.x + 245} ${a.y + 46}, ${b.x - 28} ${b.y + 46}, ${b.x} ${b.y + 46}" marker-end="url(#arrow)"/>`; };
  const edges = tasks.flatMap((task) => task.dependsOn.map((dep) => edge(dep, task.id, tasks.find((item) => item.id === dep)?.status === "done"))).join("");
  const nodes = tasks.map((task) => { const point = points.get(task.id)!; const agent = currentAgent(task); const progress = task.progress === null ? "" : `<span>${task.progress}%</span>`; return `<button class="graph-node status-${esc(task.status)} ${selectedTask === task.id ? "selected" : ""}" data-task="${esc(task.id)}" data-x="${point.x}" data-y="${point.y}" aria-label="${esc(`${task.title}, ${statusText(task)}`)}" aria-pressed="${selectedTask === task.id}"><span class="node-kicker">${esc(task.id.replace("task-", "TASK "))}</span><strong>${esc(task.title)}</strong><small>${badge(task.status)}${progress}</small>${agent ? `<em>${esc(agent.name)}</em>` : ""}</button>`; }).join("");
  return `<div class="graph-shell"><div class="graph-toolbar"><div><strong>Dependency map</strong><span>${tasks.length} tasks · ${tasks.filter((task) => task.status === "running").length} active</span></div><div class="graph-actions"><button data-graph="zoom-out" aria-label="Zoom out">−</button><button data-graph="reset">Reset</button><button data-graph="fit">Fit</button><button data-graph="zoom-in" aria-label="Zoom in">+</button></div></div><div class="graph-legend">${["done", "running", "queued", "blocked", "failed", "cancelled"].map((status) => `<span>${badge(status)}</span>`).join("")}</div><div class="graph-viewport" id="graph-viewport" tabindex="0" aria-label="Interactive gameplan dependency graph"><div class="graph-canvas" data-width="${width}" data-height="${height}"><svg width="${width}" height="${height}" aria-hidden="true"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z"/></marker></defs>${edges}</svg>${nodes}</div>${tasks.length === 0 ? `<div class="empty-state graph-empty">Choose a gameplan to see its dependency graph.</div>` : ""}</div><p class="graph-hint">Drag to pan · scroll to zoom · use Tab and arrow keys to navigate tasks</p></div>`;
}

function detailPanel() {
  const item = currentTask();
  if (!item) return `<aside class="details empty-details"><span class="detail-mark">◌</span><h2>Select a task</h2><p>Choose a node to inspect its agent, transcript, artifacts, and commits.</p></aside>`;
  const worker = currentAgent(item);
  const lines = worker ? snapshot?.transcripts[worker.id] ?? [] : [];
  const files = snapshot?.artifacts[item.id.replace("task-", "")] ?? snapshot?.artifacts[item.id] ?? [];
  const dependencies = item.dependsOn.map((id) => snapshot?.tasks.find((task) => task.id === id)).filter(Boolean) as StudioTask[];
  return `<aside class="details"><div class="detail-top"><div><span class="eyebrow">TASK DETAIL</span><h2>${esc(item.title)}</h2></div>${badge(item.status)}</div><p class="detail-description">${esc(item.detail)}</p><div class="detail-meta"><div><small>Task</small><strong>${esc(item.id)}</strong></div><div><small>Agent</small><strong>${esc(worker?.name ?? "Not assigned")}</strong></div><div><small>Commit</small><strong class="mono">${item.commit ? esc(item.commit.slice(0, 10)) : "—"}</strong></div></div><section class="detail-section"><h3>Dependencies <span>${dependencies.length}</span></h3>${dependencies.length ? `<div class="dependency-list">${dependencies.map((dep) => `<button data-task="${esc(dep.id)}" class="dependency-item">${badge(dep.status)}<span>${esc(dep.title)}</span></button>`).join("")}</div>` : `<p class="muted">Independent task</p>`}</section><section class="detail-section"><h3>Transcript <span>${lines.length}</span></h3>${lines.length ? `<div class="detail-transcript">${lines.slice(-4).map((line) => `<p>${esc(line)}</p>`).join("")}</div>` : `<p class="muted">No transcript available yet.</p>`}</section><section class="detail-section"><h3>Artifacts <span>${files.length}</span></h3>${files.length ? `<ul class="artifact-list">${files.slice(0, 8).map((file) => `<li>${esc(file)}</li>`).join("")}</ul>` : `<p class="muted">No artifacts recorded.</p>`}</section></aside>`;
}

function dashboard() { return `<section class="page"><div class="page-title"><div><span class="eyebrow">OVERVIEW</span><h1>Orchestration at a glance</h1><p class="subtitle">Follow the live execution graph without leaving the evidence behind.</p></div><button class="primary" data-action="reload">Refresh state</button></div><div class="summary-grid"><div><small>Run status</small><strong>${esc(label(snapshot?.run.status ?? "idle"))}</strong></div><div><small>Tasks</small><strong>${snapshot?.tasks.length ?? 0}</strong></div><div><small>Active agents</small><strong>${snapshot?.tasks.filter((task) => task.status === "running").length ?? 0}</strong></div><div><small>Commits</small><strong>${snapshot?.commits.length ?? 0}</strong></div></div>${graph()}</section>`; }
function agentsPage() { return `<section class="page"><div class="page-title"><div><span class="eyebrow">WORKERS</span><h1>Agents</h1><p class="subtitle">Authoritative worker state from the Onton runtime.</p></div></div><div class="agent-grid">${(snapshot?.agents ?? []).map((item) => `<button class="agent-card" data-task="${esc(item.taskId ?? "")}"><span class="avatar">${esc(item.name.slice(0, 1))}</span><span><strong>${esc(item.name)}</strong><small>${esc(item.role)}</small></span>${badge(item.status)}</button>`).join("") || `<div class="empty-state">No agents are active.</div>`}</div></section>`; }
function timelinePage() { return `<section class="page"><div class="page-title"><div><span class="eyebrow">EVENT STREAM</span><h1>Timeline</h1><p class="subtitle">Events arrive from the persisted Onton run.</p></div></div><div class="timeline">${(snapshot?.events ?? []).map((event) => `<article><time>${esc(event.time)}</time><div><strong>${esc(event.title)}</strong><p>${esc(event.detail)}</p></div></article>`).join("") || `<div class="empty-state">No events recorded.</div>`}</div></section>`; }
function setupPage() { return `<section class="page"><div class="page-title"><div><span class="eyebrow">PROJECT</span><h1>${esc(snapshot?.project.name ?? "Studio")}</h1><p class="subtitle">${esc(snapshot?.project.root ?? "Choose a project")}</p></div></div><div class="panel"><h2>Gameplan</h2><p class="muted">${esc(snapshot?.project.gameplanPath ?? "No gameplan selected")}</p><button class="primary" data-action="choose-gameplan">Choose gameplan</button></div></section>`; }
function render() {
  if (!snapshot) { app.innerHTML = `<div class="loading">Loading Studio…</div>`; return; }
  const title = snapshot.project.name || "Studio";
  app.innerHTML = `<aside class="sidebar"><div class="brand"><span class="brand-mark">◈</span><span>onton <b>studio</b></span></div><div class="nav-section"><span class="nav-label">WORKSPACE</span>${navItem("dashboard", "Overview", "◈")}${navItem("gameplan", "Dependency graph", "⌘")}${navItem("agents", "Agents", "◎")}${navItem("timeline", "Timeline", "◷")}</div><div class="nav-section bottom">${navItem("setup", "Project setup", "⚙")}<div class="runtime"><span class="pulse ${snapshot.run.status}"></span><div><strong>${esc(label(snapshot.run.status))}</strong><small>${esc(title)}</small></div></div></div></aside><main><header class="topbar"><div class="crumb"><span>Workspace</span><b>/</b><strong>${esc(title)}</strong></div><div class="top-actions"><span class="connection"><i></i> Live runtime</span><button class="icon-button" data-action="reload" aria-label="Refresh">↻</button>${snapshot.run.status === "running" ? `<button class="stop-button" data-action="stop">Stop run</button>` : ""}</div></header>${error ? `<div class="error-banner">${esc(error)}</div>` : ""}${page === "dashboard" ? dashboard() : page === "gameplan" ? `<section class="page"><div class="page-title"><div><span class="eyebrow">LIVE GAMEPLAN</span><h1>Dependency graph</h1><p class="subtitle">Concurrent branches, fan-in, and downstream work in one view.</p></div><button class="primary" data-action="reload">Refresh</button></div><div class="workspace-grid">${graph()}${detailPanel()}</div></section>` : page === "agents" ? agentsPage() : page === "timeline" ? timelinePage() : setupPage()}${toast ? `<div class="toast">${esc(toast)}</div>` : ""}`;
  bind();
}
function selectTask(id: string) { if (snapshot?.tasks.some((item) => item.id === id)) { selectedTask = id; render(); } }
function bind() {
  const graphCanvas = app.querySelector<HTMLElement>(".graph-canvas");
  if (graphCanvas) {
    graphCanvas.style.width = `${graphCanvas.dataset.width ?? 0}px`;
    graphCanvas.style.height = `${graphCanvas.dataset.height ?? 0}px`;
    graphCanvas.style.transform = `translate(${graphPan.x}px,${graphPan.y}px) scale(${graphScale})`;
  }
  app.querySelectorAll<HTMLElement>(".graph-node").forEach((node) => {
    node.style.left = `${node.dataset.x ?? 0}px`;
    node.style.top = `${node.dataset.y ?? 0}px`;
  });
  app.querySelectorAll<HTMLElement>("[data-page]").forEach((element) => element.addEventListener("click", () => { page = element.dataset.page ?? "gameplan"; render(); }));
  app.querySelectorAll<HTMLElement>("[data-task]").forEach((element) => element.addEventListener("click", () => selectTask(element.dataset.task!)));
  app.querySelectorAll<HTMLElement>("[data-action]").forEach((element) => element.addEventListener("click", () => void action(element.dataset.action!)));
  app.querySelectorAll<HTMLElement>("[data-graph]").forEach((element) => element.addEventListener("click", () => { const action = element.dataset.graph; if (action === "zoom-in") graphScale = Math.min(1.8, graphScale + .15); if (action === "zoom-out") graphScale = Math.max(.55, graphScale - .15); if (action === "reset") { graphScale = 1; graphPan = { x: 0, y: 0 }; } if (action === "fit") { graphScale = .82; graphPan = { x: 10, y: 10 }; } render(); }));
  const viewport = app.querySelector<HTMLElement>("#graph-viewport");
  viewport?.addEventListener("pointerdown", (event) => { if ((event.target as HTMLElement).closest("button")) return; dragging = true; dragStart = { x: event.clientX, y: event.clientY }; panStart = { ...graphPan }; viewport.setPointerCapture(event.pointerId); });
  viewport?.addEventListener("pointermove", (event) => { if (!dragging) return; graphPan = { x: panStart.x + event.clientX - dragStart.x, y: panStart.y + event.clientY - dragStart.y }; const canvas = viewport.querySelector<HTMLElement>(".graph-canvas"); if (canvas) canvas.style.transform = `translate(${graphPan.x}px,${graphPan.y}px) scale(${graphScale})`; });
  viewport?.addEventListener("pointerup", () => { dragging = false; });
  viewport?.addEventListener("wheel", (event) => { event.preventDefault(); graphScale = Math.max(.55, Math.min(1.8, graphScale + (event.deltaY < 0 ? .08 : -.08))); const canvas = viewport.querySelector<HTMLElement>(".graph-canvas"); if (canvas) canvas.style.transform = `translate(${graphPan.x}px,${graphPan.y}px) scale(${graphScale})`; }, { passive: false });
  viewport?.addEventListener("keydown", (event) => { const tasks = snapshot?.tasks ?? []; const index = tasks.findIndex((task) => task.id === selectedTask); if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); selectTask(tasks[(index + 1 + tasks.length) % tasks.length]?.id ?? tasks[0]?.id ?? ""); } if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); selectTask(tasks[(index - 1 + tasks.length) % tasks.length]?.id ?? tasks[0]?.id ?? ""); } });
}
async function action(name: string) { try { if (name === "reload") return refresh(); if (name === "stop") snapshot = await window.ontonStudio.stopRun(); if (name === "choose-gameplan") snapshot = await window.ontonStudio.chooseGameplan(); toast = name === "stop" ? "Cancellation requested." : toast; render(); } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); render(); } }
async function refresh() { try { snapshot = await window.ontonStudio.getSnapshot(); error = snapshot.error ?? ""; if (!selectedTask) selectedTask = snapshot.tasks[0]?.id ?? ""; render(); } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); render(); } }
void refresh();
window.ontonStudio.onEvent((next) => { snapshot = next; if (!selectedTask) selectedTask = next.tasks[0]?.id ?? ""; render(); });
