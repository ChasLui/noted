import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build, transform } from 'esbuild';

const root = process.cwd();
const srcDir = join(root, 'src');
const distDir = join(root, 'dist');

await rm(distDir, { force: true, recursive: true });
await mkdir(distDir, { recursive: true });

await build({
  bundle: true,
  entryPoints: [join(srcDir, 'main.js')],
  format: 'esm',
  legalComments: 'none',
  logLevel: 'info',
  minify: true,
  outfile: join(distDir, 'main.js'),
  sourcemap: false,
  target: ['chrome120']
});

const index = await readFile(join(srcDir, 'index.html'), 'utf8');
await writeFile(join(distDir, 'index.html'), index, 'utf8');

for (const file of ['icon.svg']) {
  const contents = await readFile(join(srcDir, file));
  await writeFile(join(distDir, file), contents);
}

const css = await readFile(join(srcDir, 'styles.css'), 'utf8');
const minifiedCss = await transform(css, { loader: 'css', minify: true });
await writeFile(join(distDir, 'styles.css'), minifiedCss.code, 'utf8');
