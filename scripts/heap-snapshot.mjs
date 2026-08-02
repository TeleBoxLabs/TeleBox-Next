// Take a heap snapshot of the telebox-next process via the V8 inspector protocol
// Usage: node scripts/heap-snapshot.mjs <pid>
import { Session } from 'node:inspector';
import fs from 'node:fs';
import path from 'node:path';

const pid = parseInt(process.argv[2], 10);
if (!pid) {
  console.error('Usage: node scripts/heap-snapshot.mjs <pid>');
  process.exit(1);
}

// Enable inspector on the target process
process._debugProcess(pid);

// Wait for inspector to be ready
await new Promise(r => setTimeout(r, 2000));

// Get the WebSocket URL from the inspector
const http = await import('node:http');
const wsUrl = await new Promise((resolve, reject) => {
  http.get('http://127.0.0.1:9229/json', (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      try {
        const targets = JSON.parse(data);
        const target = targets.find(t => t.title === 'telebox-next' || t.type === 'node');
        resolve(target ? target.webSocketDebuggerUrl : targets[0]?.webSocketDebuggerUrl);
      } catch (e) {
        reject(e);
      }
    });
  }).on('error', reject);
});

if (!wsUrl) {
  console.error('No inspector target found');
  process.exit(1);
}

console.log('Connecting to:', wsUrl);

// Connect via WebSocket
const { WebSocket } = await import('node:ws');
// Use undici WebSocket or global WebSocket
const ws = new WebSocket(wsUrl);

const snapshotPath = path.join(
  '/root/telebox-next/assets/health/profiler/snapshots',
  `heap-${Date.now()}.heapsnapshot`
);

let msgId = 0;
const pending = new Map();

function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const chunks = [];

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
  
  if (msg.method === 'HeapProfiler.addHeapSnapshotChunk') {
    chunks.push(msg.params.chunk);
  }
  
  if (msg.method === 'HeapProfiler.reportHeapSnapshotProgress' && msg.params.finished) {
    const fullData = chunks.join('');
    fs.writeFileSync(snapshotPath, fullData);
    console.log(`Snapshot saved: ${snapshotPath} (${(fullData.length / 1024 / 1024).toFixed(1)} MB)`);
    ws.close();
    process.exit(0);
  }
});

ws.on('open', async () => {
  console.log('Connected, taking heap snapshot...');
  await send('HeapProfiler.enable');
  await send('HeapProfiler.takeHeapSnapshot', { reportProgress: true });
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
  process.exit(1);
});

// Timeout after 30s
setTimeout(() => {
  console.error('Timeout waiting for snapshot');
  process.exit(1);
}, 30000);
