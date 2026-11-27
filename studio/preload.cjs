const { contextBridge } = require('electron');

const snapshot = Object.freeze({
  project: { name: 'Onton Windows Port', branch: 'windows-native-port', updatedAt: 'just now' },
  tasks: [
    { id: 'task-1', title: 'Map orchestration boundary', owner: 'Nova', status: 'done', dependsOn: [], progress: 100, detail: 'Define the typed contract between Studio and the orchestration runtime.' },
    { id: 'task-2', title: 'Harden process capture', owner: 'Atlas', status: 'running', dependsOn: ['task-1'], progress: 72, detail: 'Investigate Windows stdio behavior without starting live agents.' },
    { id: 'task-3', title: 'Build release validation', owner: 'Mira', status: 'done', dependsOn: ['task-1'], progress: 100, detail: 'Verify portable artifacts from a clean extracted directory.' },
    { id: 'task-4', title: 'Review adapter protocol', owner: 'Nova', status: 'queued', dependsOn: ['task-2'], progress: 28, detail: 'Review versioning, events, and approval semantics.' },
    { id: 'task-5', title: 'Approve next wave', owner: 'You', status: 'blocked', dependsOn: ['task-2', 'task-3'], progress: 0, detail: 'Human approval is required before orchestration can continue.' }
  ],
  agents: [
    { id: 'agent-1', name: 'Nova', role: 'Systems architect', status: 'waiting', taskId: 'task-4', accent: '#8b7cff', lastEvent: 'Mapped adapter boundary' },
    { id: 'agent-2', name: 'Atlas', role: 'Windows specialist', status: 'working', taskId: 'task-2', accent: '#36cfc9', lastEvent: 'Analyzing stdio handles' },
    { id: 'agent-3', name: 'Mira', role: 'Release engineer', status: 'idle', taskId: 'task-3', accent: '#f3a65b', lastEvent: 'Portable ZIP validated' },
    { id: 'agent-4', name: 'Iris', role: 'Quality analyst', status: 'blocked', taskId: 'task-5', accent: '#ed6f91', lastEvent: 'Waiting for approval' }
  ],
  events: [
    { id: 'e1', time: '09:42:18', kind: 'milestone', title: 'Dependency map updated', detail: 'Nova connected adapter protocol to release validation.', agentId: 'agent-1' },
    { id: 'e2', time: '09:41:52', kind: 'agent', title: 'Atlas is investigating', detail: 'Windows stdio capture is still under review.', agentId: 'agent-2' },
    { id: 'e3', time: '09:39:07', kind: 'approval', title: 'Approval requested', detail: 'A staged adapter boundary is ready for your review.', agentId: 'agent-4' },
    { id: 'e4', time: '09:35:44', kind: 'system', title: 'Simulation started', detail: 'Fixture run started — no real agents or subprocesses launched.' },
    { id: 'e5', time: '09:34:11', kind: 'milestone', title: 'Release artifact verified', detail: 'Windows ZIP startup checks completed.', agentId: 'agent-3' }
  ],
  transcripts: {
    'agent-1': ['I mapped the boundary into a versioned adapter so the cockpit can evolve independently.', 'The next useful seam is event streaming: snapshots for hydration, events for live updates.'],
    'agent-2': ['I am isolating the Windows stdio behavior before any live orchestration is allowed.', 'The current fixture keeps this run simulated. I will report a concrete native finding, not a retry loop.'],
    'agent-3': ['The extracted ZIP launches onton, worker, and setsid with the MinGW runtime bundled.', 'Coordinator startup is now passing its usage smoke test.'],
    'agent-4': ['I am paused until a human approves the staged adapter direction.']
  }
});

contextBridge.exposeInMainWorld('ontonStudio', {
  adapterVersion: '1.0',
  getSnapshot: async () => snapshot
});
