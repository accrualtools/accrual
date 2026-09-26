// Assemble public/ from src/. One source of truth: the browser, the CLI, the
// MCP server and the site all run the same functions. Nothing is hand-copied.

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');
await mkdir(pub, { recursive: true });

const banner = (name) =>
  `// ${name} — served verbatim from src/. accrual is MIT licensed.\n` +
  `// No network calls, no key material, no signing. Read it before you run it.\n\n`;

// The browser bundle is the two modules concatenated with their cross-import
// removed, so the site loads one file and still runs the tested code.
const daycount = await readFile(join(root, 'src/daycount.mjs'), 'utf8');
const accrue = await readFile(join(root, 'src/accrue.mjs'), 'utf8');
const amortise = await readFile(join(root, 'src/amortise.mjs'), 'utf8');

// Cross-imports are dropped because everything lands in one scope. Anything
// still importing from ./ after this would be a silent break, so it is checked
// below rather than assumed.
const dropLocalImports = (source) =>
  source.replace(
    /^import\s+\{[^}]*\}\s+from\s+'\.\/[^']+';\s*$/gm,
    '// (imported functions are defined above in this bundle)'
  );

const bundleParts = [daycount, accrue, amortise].map(dropLocalImports);

for (const [i, part] of bundleParts.entries()) {
  const leftover = part.match(/^import\s.*$/m);
  if (leftover) {
    throw new Error(`bundle part ${i} still imports: ${leftover[0]}`);
  }
}

await writeFile(
  join(pub, 'accrual.mjs'),
  banner('accrual.mjs') + bundleParts.join('\n\n'),
  'utf8'
);

// A shebang is only valid on line 1, so the banner has to go after it rather
// than above it. Getting this wrong produces a file that serves fine over HTTP
// and then fails to run, which is worse than an obvious break.
function withBanner(source, name) {
  if (source.startsWith('#!')) {
    const nl = source.indexOf('\n');
    return source.slice(0, nl + 1) + banner(name) + source.slice(nl + 1);
  }
  return banner(name) + source;
}

// The MCP server is published as-is, with its relative import rewritten to the
// bundle so a reader can run the served copy without the repo.
const mcp = await readFile(join(root, 'mcp/server.mjs'), 'utf8');
await writeFile(
  join(pub, 'mcp.mjs'),
  withBanner(mcp.replace("'../src/index.mjs'", "'./accrual.mjs'"), 'mcp.mjs'),
  'utf8'
);

const cli = await readFile(join(root, 'bin/accrual.mjs'), 'utf8');
await writeFile(
  join(pub, 'cli.mjs'),
  withBanner(cli.replace("'../src/index.mjs'", "'./accrual.mjs'"), 'cli.mjs'),
  'utf8'
);

const files = ['accrual.mjs', 'mcp.mjs', 'cli.mjs'];
for (const f of files) {
  const { size } = await stat(join(pub, f));
  console.log(`${f.padEnd(14)} ${String(size).padStart(7)} B`);
}

// Every published file must actually parse as a module. Serving a file that
// 200s and then throws on execution is the failure mode this catches.
const { execFileSync } = await import('node:child_process');
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', join(pub, f)], { stdio: 'pipe' });
  } catch (err) {
    console.error(`\nFAIL ${f} does not parse:\n${err.stderr?.toString() || err.message}`);
    process.exit(1);
  }
}
console.log('\nall published files parse');
