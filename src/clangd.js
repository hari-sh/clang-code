const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const fg = require("fast-glob");

function usage() {
  console.error("usage: node clang.js ROOT_DIR");
  return 2;
}

function filesUnder(root) {
  return fg.sync("**/*.{c,cc,cpp,cxx,h,hh,hpp,hxx}", {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/{.git,.hg,.svn,build,out,.cache,node_modules}/**"],
  });
}

/*
 * clang -Xclang -ast-dump=json produces a JSON AST.
 *
 * We walk the AST and collect declarations that have:
 *   - a name
 *   - a source location
 *
 * This replaces clangd's documentSymbol request.
 */
function collectSymbolsFromAST(ast, file, out = [], state = { currentFile: path.resolve(file) }) {
  if (!ast || typeof ast !== "object") {
    return out;
  }

  const prevFile = state.currentFile;
  if (ast.loc && ast.loc.file) {
    state.currentFile = path.resolve(ast.loc.file);
  }

  const kind = ast.kind;

  // Declaration kinds that are useful as index symbols.
  const symbolKinds = new Set([
    "FunctionDecl",
    "CXXMethodDecl",
    "CXXConstructorDecl",
    "CXXDestructorDecl",
    "VarDecl",
    "FieldDecl",
    "RecordDecl",
    "CXXRecordDecl",
    "EnumDecl",
    "EnumConstantDecl",
    "TypedefDecl",
    "TypeAliasDecl",
    "NamespaceDecl",
    "ClassTemplateDecl",
    "FunctionTemplateDecl",
  ]);

  const targetFileAbs = path.resolve(file);

  if (
    symbolKinds.has(kind) &&
    ast.name &&
    ast.loc &&
    ast.loc.line !== undefined &&
    !ast.isImplicit &&
    state.currentFile === targetFileAbs
  ) {
    out.push([
      ast.name,
      file,
      ast.loc.line,
    ]);
  }

  if (Array.isArray(ast.inner)) {
    for (const child of ast.inner) {
      collectSymbolsFromAST(child, file, out, state);
    }
  }

  state.currentFile = prevFile;
  return out;
}

function runClang(file, clangCmd = "clang") {
  return new Promise((resolve, reject) => {
    const ext = path.extname(file).toLowerCase();
    const args = ["-Xclang", "-ast-dump=json", "-fsyntax-only"];
    if ([".cpp", ".hpp", ".cc", ".hh", ".cxx", ".hxx", ".h"].includes(ext)) {
      args.push("-x", "c++");
    }
    args.push(file);

    const clang = spawn(clangCmd, args);

    let stdout = "";
    let stderr = "";

    clang.stdout.on("data", (data) => {
      stdout += data;
    });

    clang.stderr.on("data", (data) => {
      stderr += data;
    });

    clang.on("error", (err) => {
      reject(err);
    });

    clang.on("close", (code) => {
      if (stdout.trim()) {
        try {
          const ast = JSON.parse(stdout);
          resolve(ast);
          return;
        } catch (err) {
          // Ignore JSON parse error and proceed to handle process exit code
        }
      }

      if (code !== 0) {
        reject(
          new Error(
            `clang failed for ${file} (exit code ${code})\n${stderr}`
          )
        );
        return;
      }

      reject(new Error(`Failed to parse clang AST for ${file}`));
    });
  });
}

async function getClangSymbols(root, clangCmd = "clang", onProgress, onSymbol) {
  const rootAbs = path.resolve(root);
  const files = filesUnder(rootAbs);

  let processed = 0;
  const CONCURRENCY = 3;

  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const chunk = files.slice(i, i + CONCURRENCY);

    await Promise.all(
      chunk.map(async (file) => {
        let ast;

        try {
          ast = await runClang(file, clangCmd);
        } catch (err) {
          console.error(`Failed to get symbols for ${file}:`, err.message);
          return;
        }

        const collected = collectSymbolsFromAST(ast, file);

        if (onSymbol) {
          for (const item of collected) {
            await onSymbol(item[0], item[1], item[2]);
          }
        }

        processed++;

        if (onProgress) {
          onProgress(processed, files.length);
        }
      })
    );
  }

  return { files };
}

async function main() {
  const rootArg = process.argv[2];

  if (!rootArg) {
    process.exitCode = usage();
    return;
  }

  const root = path.resolve(rootArg);

  await getClangSymbols(
    root,
    "clang",
    null,
    (name, symbolFile, line) => {
      console.log(`${name}\t${symbolFile}\t${line}`);
    }
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = {
  getClangSymbols,
  getClangdSymbols: getClangSymbols,
  filesUnder,
  collectSymbolsFromAST,
};