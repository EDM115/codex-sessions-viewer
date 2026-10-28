// Bundled source uses only Node builtins, Nitro needs no external worker entrypoint or TS loader
export const HISTORY_SNAPSHOT_WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { options, retainOnly, retireKeep, publish = true } = workerData;
function ownedDirectory(directory) {
  const s = fs.lstatSync(directory);
  if (!s.isDirectory() || s.isSymbolicLink()) throw Error('Expected an owned regular generation directory');
}
function within(root, target) {
  const part = path.relative(path.resolve(root),path.resolve(target));
  return part === '' || (!part.startsWith('..' + path.sep) && part !== '..' && !path.isAbsolute(part));
}
function removeOwnedGeneration(candidate) {
  const generations = path.join(options.snapshotRoot,'generations');
  ownedDirectory(options.snapshotRoot);
  ownedDirectory(generations);
  ownedDirectory(candidate);
  if (!within(fs.realpathSync(generations),fs.realpathSync(candidate)) || within(candidate,options.sourceDatabase) || within(candidate,options.sourceWal)) return;
  const children = fs.readdirSync(candidate);
  if (children.some((child) => !/^thread_history_1\.sqlite(?:-wal|-shm|-journal)?$/.test(child))) return;
  for (const child of children) observe(path.join(candidate,child));
  fs.rmSync(candidate,{ recursive: true, force: true });
}
function retire() {
  if (!fs.existsSync(options.snapshotRoot)) return;
  ownedDirectory(options.snapshotRoot);
  const generations = path.join(options.snapshotRoot,'generations');
  if (!fs.existsSync(generations)) return;
  ownedDirectory(generations);
  const keep = new Set(retireKeep);
  try { const current = JSON.parse(fs.readFileSync(path.join(options.snapshotRoot,'current.json'),'utf8')); if (typeof current.generationId === 'string') keep.add(current.generationId); } catch {}
  for (const name of fs.readdirSync(generations)) {
    const match = /^(?:\.([0-9a-f-]{36})\.tmp|([0-9a-f-]{36}))$/.exec(name);
    const id = match && (match[1] || match[2]);
    if (!id || keep.has(id)) continue;
    const candidate = path.join(generations,name);
    try {
      removeOwnedGeneration(candidate);
    } catch {}
  }
  for (const name of fs.readdirSync(options.snapshotRoot)) {
    const match = /^\.current-([0-9a-f-]{36})\.tmp$/.exec(name);
    if (!match || keep.has(match[1])) continue;
    const candidate = path.join(options.snapshotRoot,name);
    try { observe(candidate); if (path.resolve(candidate) !== path.resolve(options.sourceDatabase) && path.resolve(candidate) !== path.resolve(options.sourceWal)) fs.unlinkSync(candidate); } catch {}
  }
}
function observe(file, optional = false) {
  try {
    const s = fs.lstatSync(file, { bigint: true });
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n) throw Error('Expected an unlinked regular file');
    return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String).join(':');
  } catch (e) { if (optional && e.code === 'ENOENT') return null; throw e; }
}
function hash(file) {
  const digest = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try { let bytes; while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, bytes)); }
  finally { fs.closeSync(fd); }
  return digest.digest('hex');
}
function capabilities(db) {
  const columns = (table) => new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map((row) => row.name));
  const turns = columns('thread_turns');
  const items = columns('thread_items');
  const projection = columns('thread_history_projection_state');
  const indexed = (table, prefix) => db.prepare('PRAGMA index_list(' + table + ')').all().filter((row) => !row.partial).some((row) => {
    const names = db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(row.name).map((part) => part.name);
    return prefix.every((name, index) => names[index] === name);
  });
  const requiredTurns = ['thread_id','turn_id','rollout_ordinal','status','started_at','completed_at','duration_ms','first_user_item_id','final_agent_item_id'];
  const requiredItems = ['thread_id','turn_id','item_id','rollout_ordinal','item_json'];
  const requiredProjection = ['thread_id','next_rollout_byte_offset','next_rollout_ordinal'];
  const supported = requiredTurns.every((c) => turns.has(c)) && requiredItems.every((c) => items.has(c)) && requiredProjection.every((c) => projection.has(c))
    && indexed('thread_turns',['thread_id','rollout_ordinal']) && indexed('thread_turns',['thread_id','turn_id'])
    && indexed('thread_items',['thread_id','turn_id','rollout_ordinal']) && indexed('thread_history_projection_state',['thread_id']);
  if (!supported) throw Error('Unsupported history schema or required page indexes');
  return { supported, updatedAtOrdinal: items.has('updated_at_ordinal'), turnEndOrdinal: turns.has('rollout_end_ordinal'), itemLifecycle: items.has('started_at_ms') && items.has('completed_at_ms') };
}
function validate(databasePath, recover) {
  observe(databasePath);
  const db = new DatabaseSync(databasePath, { readOnly: !recover, allowExtension: false, timeout: 1000 });
  try {
    db.enableDefensive(true);
    db.exec('PRAGMA trusted_schema = OFF');
    if (recover) { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.exec('PRAGMA journal_mode = DELETE'); }
    db.exec('PRAGMA query_only = ON');
    const checked = db.prepare('PRAGMA quick_check').all();
    if (checked.length !== 1 || checked[0].quick_check !== 'ok') throw Error('Invalid copied SQLite database');
    return capabilities(db);
  } finally { db.close(); }
}
function retained() {
  ownedDirectory(options.snapshotRoot);
  const manifest = JSON.parse(fs.readFileSync(path.join(options.snapshotRoot,'current.json'),'utf8'));
  if (!/^[0-9a-f-]{36}$/.test(manifest.generationId) || !/^[a-f0-9]{64}$/.test(manifest.digest)) throw Error('Invalid history manifest');
  const databasePath = path.join(options.snapshotRoot,'generations',manifest.generationId,'thread_history_1.sqlite');
  ownedDirectory(path.join(options.snapshotRoot,'generations'));
  ownedDirectory(path.dirname(databasePath));
  const before = observe(databasePath);
  const caps = validate(databasePath, false);
  const digest = hash(databasePath);
  if (digest !== manifest.digest || before !== observe(databasePath)) throw Error('Retained owned snapshot changed');
  return { databasePath, digest, generationId: manifest.generationId, observation: before, capabilities: caps };
}
let temporary;
let temporaryOwned = false;
try {
  if (retireKeep) { retire(); parentPort.postMessage({ status: 'unavailable', snapshot: null, diagnostics: [] }); }
  else if (retainOnly) { parentPort.postMessage({ status: 'retained', snapshot: retained(), diagnostics: [] }); }
  else {
    const generationId = workerData.generationId || randomUUID();
    if (!/^[0-9a-f-]{36}$/.test(generationId)) throw Error('Invalid owned generation identity');
    const generations = path.join(options.snapshotRoot,'generations');
    temporary = path.join(generations, '.' + generationId + '.tmp');
    const generation = path.join(generations, generationId);
    const before = [observe(options.sourceDatabase), observe(options.sourceWal, true)];
    fs.mkdirSync(options.snapshotRoot, { recursive: true, mode: 0o700 });
    ownedDirectory(options.snapshotRoot);
    fs.mkdirSync(generations, { recursive: true, mode: 0o700 });
    ownedDirectory(generations);
    fs.mkdirSync(temporary, { mode: 0o700 });
    temporaryOwned = true;
    const copied = path.join(temporary, 'thread_history_1.sqlite');
    fs.copyFileSync(options.sourceDatabase, copied, fs.constants.COPYFILE_EXCL);
    if (before[1] !== null) fs.copyFileSync(options.sourceWal, copied + '-wal', fs.constants.COPYFILE_EXCL);
    if (JSON.stringify(before) !== JSON.stringify([observe(options.sourceDatabase), observe(options.sourceWal, true)])) throw Error('History source changed during copy');
    const caps = validate(copied, true);
    const digest = hash(copied);
    fs.renameSync(temporary,generation);
    temporary = undefined;
    const databasePath = path.join(generation,'thread_history_1.sqlite');
    const snapshot = { databasePath, digest, generationId, observation: observe(databasePath), capabilities: caps };
    if (publish) {
      const manifestPath = path.join(options.snapshotRoot,'.current-' + generationId + '.tmp');
      fs.writeFileSync(manifestPath, JSON.stringify({ generationId, digest }), { mode: 0o600 });
      fs.renameSync(manifestPath,path.join(options.snapshotRoot,'current.json'));
    }
    parentPort.postMessage({ status: 'created', snapshot, diagnostics: [] });
  }
} catch (error) {
  if (temporary && temporaryOwned) { try { removeOwnedGeneration(temporary); } catch {} }
  const diagnostics = [String(error.message ?? error)];
  if (retireKeep) parentPort.postMessage({ status: 'unavailable', snapshot: null, diagnostics });
  else {
    try { parentPort.postMessage({ status: 'retained', snapshot: retained(), diagnostics }); }
    catch { parentPort.postMessage({ status: 'unavailable', snapshot: null, diagnostics }); }
  }
}
`;
