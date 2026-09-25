const fs = require('fs').promises;
const fssync = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { getDB, initDB, cleanDB, closeDB, openDB, batchWriteIntoDB, BatchWriter, tokenize, elapsedTime } = require('./database');

const { getClangdSymbols } = require('./clangd');
const exts = new Set(['.c', '.cpp', '.h', '.hpp', '.cc', '.hh', '.cxx', '.hxx']);

async function getSourceFiles(dir, root, out = []) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (['node_modules', '.git', 'dist', 'build', '.cache', 'out'].includes(e.name)) continue;
            await getSourceFiles(fullPath, root, out);
        } else if (exts.has(path.extname(e.name))) {
            out.push(path.relative(root, fullPath));
        }
    }
    return out;
}



async function runClang(root, channel, clangCmd) {
    channel.appendLine('Indexing symbols with clang...');
    const batchSize = 200000;
    const batchWriter = new BatchWriter(batchSize, (processed) => {
        channel.appendLine(`${processed} symbols processed...`);
    });

    await getClangdSymbols(root, clangCmd, (processed, total) => {
        if (processed % 100 === 0 || processed === total) {
            channel.appendLine(`${processed}/${total} files processed by clang...`);
        }
    }, async (tagName, absFile, lineNo) => {
        if (!tagName || !absFile || isNaN(lineNo)) {
            return;
        }

        const relativeFile = path.relative(root, absFile);

        await batchWriter.add({
            type: 'put',
            key: `tag:${tagName}`,
            value: {
                file: relativeFile,
                line: lineNo
            }
        });
    });

    await batchWriter.flush();
    channel.appendLine('All symbols indexed with clang...');
}

async function parseToTagsFile(root, channel, exeCmds) {
    channel.appendLine('Finding Number of files to be indexed...');
    const files = await getSourceFiles(root, root);
    channel.appendLine(`Found ${files.length} source files(s) to index...`);
    await runClang(root, channel, exeCmds.clang || exeCmds.clangd || 'clang');
}

async function assignIdsToVariables(channel) {
    const db = getDB();
    channel.appendLine('Creating Tags DataBase...');

    let totalTags = 0;
    const buckets = [];
    for await (const key of db.keys({ gte: 'tag:', lt: 'tag;' })) {
        const tag = key.slice(4);
        const len = tag.length;
        if (!buckets[len]) buckets[len] = [];
        buckets[len].push(tag);
        totalTags++;
    }

    const idWriter = new BatchWriter(200000, (processed) => {
        channel.appendLine(`${processed}/${totalTags} IDs assigned...`);
    });
    let ind = 0;
    const tokenMap = new Map();

    for (let b = 0; b < buckets.length; b++) {
        const bucket = buckets[b];
        if (!bucket) continue;

        for (let i = 0; i < bucket.length; i++) {
            const varname = bucket[i];
            const varid = ind + 1;
            await idWriter.add({ type: 'put', key: `id:${varid}`, value: varname });
            const tokens = new Set(tokenize(varname));
            for (const token of tokens) {
                let ids = tokenMap.get(token);
                if (!ids) {
                    ids = [];
                    tokenMap.set(token, ids);
                }
                ids.push(varid);
            }
            ind++;
        }
    }
    await idWriter.flush();

    const tokenWriter = new BatchWriter(50000, (processed) => {
        channel.appendLine(`${processed}/${tokenMap.size} tokens processed...`);
    });
    for (const [token, ids] of tokenMap) {
        await tokenWriter.add({ type: 'put', key: `token:${token}`, value: ids });
    }
    await tokenWriter.flush();
}


async function parseAndStoreTags(channel, root, exeCmds) {
    channel.show();
    const start = performance.now();
    await cleanDB();
    await openDB();
    await parseToTagsFile(root, channel, exeCmds);
    await assignIdsToVariables(channel);
    channel.appendLine('Post processing symbols...');
    channel.appendLine('Tags DataBase created successfully...');
    elapsedTime(start, performance.now(), channel);
}

module.exports = {
    parseAndStoreTags
};

if (require.main === module) {
    const { initDB, closeDB } = require('./database');
    const argv = process.argv;

    const channel = {
        appendLine: (msg) => console.log(msg),
        show: () => {},
        hide: () => {}
    };

    const exeCmds = {
        clang: 'clang',
        clangd: 'clang'
    };

    const root = argv[2];
    if (root) {
        (async () => {
            try {
                channel.appendLine(`Initializing database at ${root}...`);
                initDB(root);
                await parseAndStoreTags(channel, root, exeCmds);
                closeDB();
            } catch (err) {
                console.error("Error during execution:", err);
            }
        })();
    } else {
        console.error('Please provide a root directory.');
    }
}
