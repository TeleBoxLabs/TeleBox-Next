import inspector from 'node:inspector/promises';
import fs from 'node:fs';

const session = inspector.Session();
session.connect();

// Enable heap profiler
await session.post('HeapProfiler.enable');

// Take heap snapshot
const chunks = [];
const { heapSnapshotStream } = await session.post('HeapProfiler.takeHeapSnapshot', null, true);
// Actually use the streaming approach
const snapshotPath = '/root/telebox-next/assets/health/profiler/snapshots/heap-' + Date.now() + '.heapsnapshot';

// Use the callback-based approach
import { Session as SyncSession } from 'node:inspector';

const syncSession = new SyncSession();
syncSession.connect();

const writeStream = fs.createWriteStream(snapshotPath);

await new Promise((resolve, reject) => {
  syncSession.post('HeapProfiler.enable', (err) => {
    if (err) return reject(err);
    
    syncSession.post('HeapProfiler.takeHeapSnapshot', null, (err, result) => {
      if (err) return reject(err);
      resolve();
    });
    
    // Collect chunks
    let chunkData = [];
    syncSession.on('HeapProfiler.addHeapSnapshotChunk', (m) => {
      chunkData.push(m.params.chunk);
    });
    
    // When snapshot is done, write to file
    syncSession.on('HeapProfiler.reportHeapSnapshotProgress', (m) => {
      if (m.params.finished) {
        const fullData = chunkData.join('');
        fs.writeFileSync(snapshotPath, fullData);
        console.log('Snapshot saved to', snapshotPath);
        console.log('Size:', (fullData.length / 1024 / 1024).toFixed(1), 'MB');
        resolve();
      }
    });
  });
});

syncSession.disconnect();
process.exit(0);
