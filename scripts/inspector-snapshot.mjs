// Take a heap snapshot via node:inspector Session (in-process connection)
// Usage: node scripts/inspector-snapshot.mjs [port]
import { Session } from 'node:inspector';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const port = parseInt(process.argv[2] || '9230', 10);
const snapshotDir = '/root/telebox-next/assets/health/profiler/snapshots';
fs.mkdirSync(snapshotDir, { recursive: true });

// 1. Get WebSocket URL from inspector
const wsUrl = await new Promise((resolve, reject) => {
  const req = http.get({ hostname: '127.0.0.1', port, path: '/json' }, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      try {
        const targets = JSON.parse(data);
        const target = targets.find(t => t.type === 'node') || targets[0];
        if (target?.webSocketDebuggerUrl) resolve(target.webSocketDebuggerUrl);
        else reject(new Error('No inspector target found'));
      } catch (e) { reject(e); }
    });
  });
  req.on('error', reject);
  req.setTimeout(5000, () => req.destroy(new Error('timeout')));
});

console.log('Connecting to:', wsUrl);

// 2. Connect via WebSocket using built-in WebSocket
const snapshotPath = path.join(snapshotDir, `heap-${Date.now()}.heapsnapshot`);
const chunks = [];
let msgId = 0;
const pending = new Map();
let snapshotDone = false;

const ws = new WebSocket(wsUrl);

function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

ws.onmessage = (event) => {
  const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
  
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
  
  if (msg.method === 'HeapProfiler.addHeapSnapshotChunk') {
    chunks.push(msg.params.chunk);
  }
  
  if (msg.method === 'HeapProfiler.reportHeapSnapshotProgress') {
    if (msg.params.finished) {
      snapshotDone = true;
    }
  }
};

ws.onerror = (e) => {
  console.error('WebSocket error:', e.message || e);
  process.exit(1);
};

ws.onopen = async () => {
  console.log('Connected, taking heap snapshot...');
  try {
    await send('HeapProfiler.enable');
    // takeHeapSnapshot resolves when snapshot is complete
    await send('HeapProfiler.takeHeapSnapshot', { reportProgress: true });
    
    // Wait a bit for any remaining chunks
    await new Promise(r => setTimeout(r, 500));
    
    if (chunks.length === 0) {
      console.error('No chunks received!');
      process.exit(1);
    }
    
    const fullData = chunks.join('');
    fs.writeFileSync(snapshotPath, fullData);
    const sizeMB = (fullData.length / 1024 / 1024).toFixed(1);
    console.log(`Snapshot saved: ${snapshotPath} (${sizeMB} MB, ${chunks.length} chunks)`);
    ws.close();
    process.exit(0);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
};

setTimeout(() => {
  console.error(`Timeout (60s) - chunks: ${chunks.length}, done: ${snapshotDone}`);
  if (chunks.length > 0) {
    const fullData = chunks.join('');
    fs.writeFileSync(snapshotPath, fullData);
    console.log(`Partial snapshot saved: ${snapshotPath} (${(fullData.length / 1024 / 1024).toFixed(1)} MB)`);
  }
  process.exit(1);
}, 60000);
