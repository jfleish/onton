import type { AgentStatus, StudioAgent, StudioEvent, StudioSnapshot, StudioTask } from "./adapter.js";

const icons: Record<string, string> = { dashboard: "◈", gameplan: "⌘", agents: "◎", timeline: "◷", transcript: "▤", approvals: "✓" };
const app = document.querySelector<HTMLDivElement>("#app")!;
let snapshot: StudioSnapshot;
let page = "dashboard";
let selectedTask = "task-2";
let selectedAgent = "agent-2";
let toast = "";

const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]!));
const statusLabel = (s: string) => s[0].toUpperCase() + s.slice(1);
const task = (id: string) => snapshot.tasks.find((item) => item.id === id)!;
const agent = (id: string) => snapshot.agents.find((item) => item.id === id)!;

function navItem(id: string, label: string) {
  return `<button class="nav-item ${page === id ? "active" : ""}" data-page="${id}"><span class="nav-icon">${icons[id]}</span>${label}</button>`;
}
function badge(value: string, tone = value) { return `<span class="badge ${tone}">${esc(statusLabel(value))}</span>`; }
function taskCard(item: StudioTask) {
  return `<button class="task-card ${selectedTask === item.id ? "selected" : ""}" data-task="${item.id}">
    <div class="task-head"><span class="task-id">${item.id.toUpperCase()}</span>${badge(item.status)}</div>
    <strong>${esc(item.title)}</strong><span class="task-owner">${esc(item.owner)} · ${item.progress}% complete</span>
    <div class="progress"><i class="progress-fill progress-${item.progress}"></i></div>
  </button>`;
}
function agentCard(item: StudioAgent) {
  return `<button class="agent-card" data-agent="${item.id}"><span class="avatar accent-${item.id}">${item.name.slice(0, 1)}</span><span class="agent-copy"><strong>${esc(item.name)}</strong><small>${esc(item.role)}</small></span>${badge(item.status)}<span class="chevron">›</span></button>`;
}
function eventRow(item: StudioEvent) {
  return `<div class="event-row"><span class="event-dot ${item.kind}"></span><div><strong>${esc(item.title)}</strong><p>${esc(item.detail)}</p></div><time>${esc(item.time)}</time></div>`;
}
function graph() {
  const positions: Record<string, [number, number]> = { "task-1": [95, 100], "task-2": [315, 100], "task-3": [535, 100], "task-4": [205, 255], "task-5": [425, 255] };
  const lines = snapshot.tasks.flatMap((t) => t.dependsOn.map((dep) => { const [x1, y1] = positions[dep]; const [x2, y2] = positions[t.id]; return `<path d="M${x1 + 76} ${y1 + 35} C${x1 + 140} ${y1 + 35} ${x2 - 40} ${y2 + 35} ${x2} ${y2 + 35}"/>`; })).join("");
  return `<div class="graph"><svg viewBox="0 0 700 355" aria-label="Gameplan dependency graph">${lines}</svg>${snapshot.tasks.map((t) => { const [x, y] = positions[t.id]; return `<button class="graph-node ${t.status} pos-${t.id} ${selectedTask === t.id ? "selected" : ""}" data-task="${t.id}"><span>${t.id.replace("task-", "0")}</span><strong>${esc(t.title)}</strong><small>${statusLabel(t.status)}</small></button>`; }).join("")}</div>`;
}
function taskInspector() {
  const current = task(selectedTask);
  return `<aside class="inspector"><div class="eyebrow">TASK INSPECTOR</div><h2>${esc(current.title)}</h2><p class="muted">${esc(current.detail)}</p><div class="inspector-grid"><span>Owner</span><strong>${esc(current.owner)}</strong><span>Progress</span><strong>${current.progress}%</strong><span>Depends on</span><strong>${current.dependsOn.length ? current.dependsOn.join(", ") : "None"}</strong></div><button class="primary" data-action="focus-agent">Open agent thread <span>→</span></button></aside>`;
}
function dashboard() {
  return `<section class="page"><div class="page-title"><div><div class="eyebrow">CONTROL ROOM / PROJECT OVERVIEW</div><h1>Good morning, operator.</h1><p class="subtitle">Your orchestration is moving. Two agents are active across the current gameplan.</p></div><button class="primary" data-action="simulate">Run simulation <span>⌘↵</span></button></div><div class="metrics"><div><span>Active agents</span><strong>${snapshot.agents.filter((a) => a.status === "working").length}<small>/ ${snapshot.agents.length}</small></strong><em class="up">↑ 2 since yesterday</em></div><div><span>Plan completion</span><strong>64%</strong><em class="up">↑ 12% this run</em></div><div><span>Elapsed time</span><strong>18m <small>42s</small></strong><em>simulated run</em></div><div><span>Needs attention</span><strong>1</strong><em class="warning">Approval waiting</em></div></div><div class="content-grid"><div class="panel wide"><div class="panel-head"><div><div class="eyebrow">LIVE GAMEPLAN</div><h2>Dependency flow</h2></div><button class="text-button" data-page="gameplan">Expand graph ↗</button></div>${graph()}</div><div class="panel"><div class="panel-head"><div><div class="eyebrow">AGENT FLEET</div><h2>On the ground</h2></div><button class="text-button" data-page="agents">View all</button></div><div class="agent-list">${snapshot.agents.slice(0, 3).map(agentCard).join("")}</div></div></div><div class="content-grid lower"><div class="panel"><div class="panel-head"><div><div class="eyebrow">RUN STREAM</div><h2>Latest events</h2></div><button class="text-button" data-page="timeline">Open log</button></div>${snapshot.events.slice(0, 4).map(eventRow).join("")}</div><div class="panel attention"><div class="eyebrow">ATTENTION REQUIRED</div><h2>Research direction is ready</h2><p>Atlas has prepared a decision point. Review the proposed approach before the next wave starts.</p><button class="primary" data-page="approvals">Review recommendation <span>→</span></button></div></div></section>`;
}
function pageContent() {
  if (page === "gameplan") return `<section class="page"><div class="page-title"><div><div class="eyebrow">VISUAL GAMEPLAN</div><h1>Execution map</h1><p class="subtitle">Trace dependencies and inspect what each agent is unblocking.</p></div><span class="badge simulated">Simulated data</span></div><div class="panel graph-panel">${graph()}</div>${taskInspector()}</section>`;
  if (page === "agents") return `<section class="page"><div class="page-title"><div><div class="eyebrow">AGENT FLEET</div><h1>Agents in the loop</h1><p class="subtitle">Every worker, its intent, and the work currently in flight.</p></div></div><div class="agents-layout"><div class="panel agent-directory">${snapshot.agents.map(agentCard).join("")}</div><div class="panel transcript-preview">${transcript(agent(selectedAgent))}</div></div></section>`;
  if (page === "timeline") return `<section class="page"><div class="page-title"><div><div class="eyebrow">RUN TIMELINE</div><h1>What happened</h1><p class="subtitle">A legible record of decisions, transitions, and milestones.</p></div><button class="text-button" data-action="clear-toast">Export event log ↗</button></div><div class="panel timeline">${snapshot.events.map(eventRow).join("")}</div></section>`;
  if (page === "transcript") return `<section class="page"><div class="page-title"><div><div class="eyebrow">TRANSCRIPT INSPECTOR</div><h1>Agent conversations</h1><p class="subtitle">Read the reasoning context without losing the system state.</p></div></div><div class="agents-layout"><div class="panel agent-directory">${snapshot.agents.map(agentCard).join("")}</div><div class="panel transcript-preview">${transcript(agent(selectedAgent))}</div></div></section>`;
  if (page === "approvals") return `<section class="page"><div class="page-title"><div><div class="eyebrow">HUMAN OVERSIGHT</div><h1>Decision queue</h1><p class="subtitle">The system pauses here by design. Your call shapes the next wave.</p></div><span class="badge warning">1 requires review</span></div><div class="panel approval-card"><div class="approval-mark">✦</div><div><div class="eyebrow">RECOMMENDATION FROM ATLAS</div><h2>Use a staged adapter boundary</h2><p>Atlas recommends isolating the orchestration protocol behind a versioned adapter before connecting live workers. This keeps the UI stable while the Windows process layer is hardened.</p><div class="approval-meta"><span>Confidence <strong>87%</strong></span><span>Impact <strong>Medium</strong></span><span>Requested <strong>2m ago</strong></span></div><div class="button-row"><button class="primary" data-action="approve">Approve recommendation <span>↵</span></button><button class="secondary" data-action="snooze">Snooze</button></div></div></div></section>`;
  return dashboard();
}
function transcript(item: StudioAgent) {
  const lines = snapshot.transcripts[item.id] ?? [];
  return `<div class="transcript-head"><span class="avatar accent-${item.id}">${item.name.slice(0, 1)}</span><div><h2>${esc(item.name)}</h2><p>${esc(item.role)} · ${badge(item.status)}</p></div></div><div class="chat">${lines.map((line, i) => `<div class="message ${i % 2 ? "agent-message" : "system-message"}"><span>${i % 2 ? item.name : "SYSTEM"}</span><p>${esc(line)}</p></div>`).join("")}</div><div class="composer"><input placeholder="Ask about this run..."/><button class="primary" data-action="send">Send</button></div>`;
}
function render() {
  app.innerHTML = `<nav class="sidebar"><div class="brand"><span class="brand-mark">✦</span><span>onton <b>studio</b></span></div><div class="nav-section"><span class="nav-label">WORKSPACE</span>${navItem("dashboard", "Dashboard")}${navItem("gameplan", "Gameplan")}${navItem("agents", "Agents")}${navItem("timeline", "Timeline")}${navItem("transcript", "Transcripts")}</div><div class="nav-section bottom"><span class="nav-label">OPERATIONS</span>${navItem("approvals", "Approvals")}<div class="runtime"><span class="pulse"></span><span><b>Simulation mode</b><small>Backend disconnected</small></span></div></div></nav><main><header class="topbar"><div class="crumb"><span class="dot"></span><strong>${esc(snapshot.project.name)}</strong><span>/</span><span>${esc(snapshot.project.branch)}</span></div><div class="top-actions"><span class="simulated-pill">● SIMULATED RUN</span><button class="icon-button" data-action="help">?</button><span class="avatar user">OP</span></div></header>${pageContent()}${toast ? `<div class="toast">${esc(toast)}</div>` : ""}</main>`;
  app.querySelectorAll<HTMLElement>("[data-page]").forEach((el) => el.addEventListener("click", () => { page = el.dataset.page!; render(); }));
  app.querySelectorAll<HTMLElement>("[data-task]").forEach((el) => el.addEventListener("click", () => { selectedTask = el.dataset.task!; if (page === "dashboard") page = "gameplan"; render(); }));
  app.querySelectorAll<HTMLElement>("[data-agent]").forEach((el) => el.addEventListener("click", () => { selectedAgent = el.dataset.agent!; page = "transcript"; render(); }));
  app.querySelectorAll<HTMLElement>("[data-action]").forEach((el) => el.addEventListener("click", () => action(el.dataset.action!)));
}
function action(name: string) { if (name === "simulate") toast = "Simulation queued — no real agents will be started."; else if (name === "approve") toast = "Approved in simulation. Atlas can continue when the backend is connected."; else if (name === "snooze") toast = "Approval snoozed for 15 minutes."; else if (name === "send") toast = "Transcript messaging is simulated in this milestone."; else if (name === "help") toast = "Studio foundation · adapter v1.0"; else if (name === "focus-agent") { page = "transcript"; selectedAgent = task(selectedTask).owner === "Atlas" ? "agent-2" : "agent-1"; } render(); setTimeout(() => { toast = ""; render(); }, 3200); }

window.ontonStudio.getSnapshot().then((data) => { snapshot = data; render(); });
