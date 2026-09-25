#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const fg = require("fast-glob");
const { pathToFileURL } = require("url");
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require("vscode-jsonrpc/node");

function usage() {
  console.error("usage: node clangd.js ROOT_DIR");
  return 2;
}

function uri(file) {
  return pathToFileURL(path.resolve(file)).href;
}

function filesUnder(root) {
  return fg.sync("**/*.{c,cc,cpp,cxx,h,hh,hpp,hxx}", {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/{.git,.hg,.svn,build,out,.cache}/**"],
  });
}

function collectSymbols(file, symbols, out = []) {
  for (const symbol of symbols || []) {
    const range = symbol.selectionRange || symbol.location?.range;
    if (range) out.push([symbol.name, file, range.start.line + 1]);
    collectSymbols(file, symbol.children, out);
  }
  return out;
}

async function getClangdSymbols(root, clangdCmd = "clangd", onProgress, onSymbol) {
  const rootAbs = path.resolve(root);
  const files = filesUnder(rootAbs);

  const clangd = spawn(clangdCmd, ["-j=4", "--background-index=false", "--log=error"], {
    stdio: ["pipe", "pipe", "ignore"],
  });

  const lsp = createMessageConnection(new StreamMessageReader(clangd.stdout), new StreamMessageWriter(clangd.stdin));
  lsp.listen();

  await lsp.sendRequest("initialize", { processId: process.pid, rootUri: uri(rootAbs), capabilities: {} });
  lsp.sendNotification("initialized", {});

  let processed = 0;
  const CONCURRENCY = 3;

  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const chunk = files.slice(i, i + CONCURRENCY);

    await Promise.all(chunk.map(async (file) => {
      let content;
      try {
        content = await fs.promises.readFile(file, "utf8");
      } catch {
        return;
      }

      lsp.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: uri(file),
          languageId: path.extname(file) === ".c" ? "c" : "cpp",
          version: 1,
          text: content,
        },
      });

      let symbols = [];
      try {
        symbols = await lsp.sendRequest("textDocument/documentSymbol", {
          textDocument: { uri: uri(file) },
        });
      } catch (err) {
        console.error(`Failed to get symbols for ${file}:`, err.message);
      }

      const collected = collectSymbols(file, symbols);
      if (onSymbol) {
        for (const item of collected) {
          await onSymbol(item[0], item[1], item[2]);
        }
      }

      lsp.sendNotification("textDocument/didClose", {
        textDocument: { uri: uri(file) }
      });

      processed++;
      if (onProgress) {
        onProgress(processed, files.length);
      }
    }));
  }

  lsp.sendNotification("exit", {});
  clangd.kill();

  return { files };
}

async function main() {
  const rootArg = process.argv[2];
  if (!rootArg) {
    process.exitCode = usage();
    return;
  }

  const root = path.resolve(rootArg);
  await getClangdSymbols(root, "clangd", null, (name, symbolFile, line) => {
    console.log(`${name}\t${symbolFile}\t${line}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = {
  getClangdSymbols,
  filesUnder,
  collectSymbols
};
