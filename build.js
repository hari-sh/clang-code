const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const targets = [
  'darwin-x64+arm64',
  'linux-x64',
  'win32-x64',
  'win32-ia32'
];

for (const target of targets) {
  const src = path.join('node_modules/classic-level/prebuilds', target, 'classic-level.node');
  const destDir = path.join('dist/prebuilds', target);
  const dest = path.join(destDir, 'classic-level.node');

  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`Copied ${src} → ${dest}`);
}

esbuild.build({
  entryPoints: ['src/main.js'],
  bundle: true,
  minify: true,
  sourcemap: false,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/main.js',
  external: ['vscode', 'node-gyp-build'],
  banner: {
    js: `// Bundled VSCode extension with classic-level and node-gyp-build`,
  },
}).then(() => {
  console.log('Build complete: dist/main.js');
}).catch(e => {
  console.error(e);
  process.exit(1);
});
