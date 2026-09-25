const path = require('path');

const fssync = require('fs');

const prebuildsDir = path.join(__dirname, 'prebuilds');
const isProd = fssync.existsSync(prebuildsDir);

if (isProd) {
  // Prod mode: patch node-gyp-build to use local prebuilds safely bounded by filesystem presence
  const nodeGypBuild = require('node-gyp-build');
  const originalNodeGypBuild = nodeGypBuild;
  const nodeGypBuildPath = require.resolve('node-gyp-build');
  require.cache[nodeGypBuildPath].exports = function (p) {
    return originalNodeGypBuild(p || prebuildsDir);
  };
}

const { ClassicLevel } = require('classic-level');

const fs = require('fs').promises;
function elapsedTime(start, end, channel) {
    const sec = ((end - start) / 1000).toFixed(3);
    if (sec < 60) {
        const secRounded = Math.floor(sec);
        const millisec = Math.round((sec % 1) * 1000);
        channel.appendLine(`Elapsed: ${secRounded} seconds ${millisec} ms`);
    } else {
        const mins = Math.floor(sec / 60);
        const remainingSec = Math.floor(sec % 60);
        const millisec = Math.round((sec % 1) * 1000);
        channel.appendLine(`Elapsed: ${mins} minutes ${remainingSec} seconds ${millisec} ms`);
    }
}

const tokenize = (name) => {
  return name
    .replace(/\.[a-zA-Z0-9]+$/, '')         // remove trailing file extensions like .c, .h, .cpp
    .replace(/([a-z])([A-Z])/g, '$1 $2')    // camelCase → split
    .replace(/[_\-\.\/]+/g, ' ')            // snake_case, kebab-case, dot-separated, paths
    .replace(/[^a-zA-Z0-9 ]/g, '')          // remove other symbols
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
};
const { getTopIntersections } = require('./search');

let db;
let dbpath;

function initDB(rootPath) {
  if (!dbpath) {
    dbpath = path.join(rootPath, 'tagsdb');
  }
  if (!db) {
    // Increase internal write buffer to 64MB (default is 4MB) to prevent immediate memtable compactions during huge batch writes
    db = new ClassicLevel(dbpath, { 
      valueEncoding: 'json',
      writeBufferSize: 64 * 1024 * 1024 
    });
  }
  return db;
}

function getDB() {
  if (!db) throw new Error('DB is not initialized.');
  return db;
}

function closeDB() {
  if (!db) throw new Error('DB is not initialized.');
  db.close();
}

async function openDB() {
  if (!db) throw new Error('DB is not initialized.');
  await db.open();
}

async function cleanDB() {
  try {
    // 1. Close DB if handle provided
    if (db) {
      try { await db.close(); } catch (_) { }
    }

    // 2. Fast path: try deleting entire folder
    try {
      await fs.rm(dbpath, { recursive: true, force: true });
      return; // done
    } catch (_) {
      // fall through to selective delete
    }

    // 3. Slow path: delete inside, skip locked .log files
    try {
      const entries = await fs.readdir(dbpath);
      for (const file of entries) {
        const full = path.join(dbpath, file);

        try {
          await fs.rm(full, { recursive: true, force: true });
        } catch (err) {
          // Skip locked log files silently
          if (file.endsWith(".log")) {
            continue;
          }
          // Ignore all errors as requested
          continue;
        }
      }
    } catch (_) {
      // folder missing — ignore silently
    }
  } catch (_) {
    // final safety blanket, ignore everything
  }
}


async function getValueFromDb(key) {
  try {
    const value = await db.get(key);
    return value;
  } catch (err) {
    if (err.notFound) {
      return null;
    } else {
      throw err;
    }
  }
}

async function batchWriteIntoDB(data) {
  try {
    await db.batch(data);
  } catch (err) {
    console.error('Batch write failed:', err);
  }
}

class BatchWriter {
    constructor(batchSize, onFlush) {
        this.batchSize = batchSize;
        this.onFlush = onFlush;
        this.ops = new Array(batchSize);
        this.index = 0;
        this.processed = 0;
    }

    async add(op) {
        this.ops[this.index++] = op;
        if (this.index >= this.batchSize) {
            await this.flush();
        }
    }

    async flush() {
        if (this.index > 0) {
            const flushOps = this.index === this.batchSize ? this.ops : this.ops.slice(0, this.index);
            await batchWriteIntoDB(flushOps);
            this.processed += this.index;
            if (this.onFlush) {
                this.onFlush(this.processed);
            }
            this.ops = new Array(this.batchSize);
            this.index = 0;
        }
    }
}

async function getIds(words, signal, limit = 20) {
  const groups = await Promise.all(words.map(async (word) => {
    if (signal?.aborted) { const e = new Error('Aborted'); e.name = 'AbortError'; throw e; }
    const ilist = [];
    for await (const [key, value] of db.iterator({ gte: `token:${word}`, lt: `token:${word}~` })) {
      if (signal?.aborted) { const e = new Error('Aborted'); e.name = 'AbortError'; throw e; }
      ilist.push(value);
    }
    return ilist;
  }));
  return getTopIntersections(groups, signal, limit);
}


const searchQuery = async (query, signal, limit = 20) => {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const ids = await getIds(terms, signal, limit);
  if (signal?.aborted) { const e = new Error('Aborted'); e.name = 'AbortError'; throw e; }

  const rawResults = await Promise.all(ids.map(async (id) => {
    try {
      const variableName = await db.get(`id:${id}`);
      const meta = await db.get(`tag:${variableName}`);
      return { label: variableName, description: meta?.file || '' };
    } catch {
      console.log('Unable to get db value');
      return null;
    }
  }));

  return rawResults.filter(Boolean);
};

module.exports = { initDB, getDB, openDB, cleanDB, closeDB, getValueFromDb, batchWriteIntoDB, searchQuery, elapsedTime, tokenize, BatchWriter };
