// package.json is the contract with anyone installing this, and nothing checked
// it. A bin that is not executable, a subpath export pointing at a file that was
// renamed, or a README missing from `files` are all failures that only appear
// after publishing, on someone else's machine.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

test('every path in exports resolves to a file that exists', async () => {
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    const file = join(root, target);
    const s = await stat(file).catch(() => null);
    assert.ok(s?.isFile(), `exports["${subpath}"] points at ${target}, which is not a file`);
  }
});

test('every export other than package.json actually loads', async () => {
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    if (target.endsWith('.json')) continue;
    // The MCP server reads stdin on import, so loading it must not hang or throw.
    const mod = await import(join(root, target));
    assert.equal(typeof mod, 'object', `exports["${subpath}"] did not load`);
  }
});

test('every bin exists, is executable, and starts with a shebang', async () => {
  for (const [name, target] of Object.entries(pkg.bin)) {
    const file = join(root, target);
    const text = await readFile(file, 'utf8');
    assert.match(text, /^#!\/usr\/bin\/env node\n/, `bin ${name} has no usable shebang`);
    // Without the executable bit, npm's symlink is created and then fails with
    // EACCES the first time anyone runs it.
    await assert.doesNotReject(
      access(file, constants.X_OK),
      `bin ${name} (${target}) is not executable: chmod +x it`
    );
  }
});

test('the files array covers everything the package needs to run', async () => {
  // src/ alone is not enough: the bins live outside it, and a package with no
  // README installs as four opaque directories.
  for (const needed of ['src', 'bin', 'mcp', 'README.md', 'LICENSE']) {
    assert.ok(pkg.files.includes(needed), `files is missing ${needed}`);
  }
  for (const entry of pkg.files) {
    const s = await stat(join(root, entry)).catch(() => null);
    assert.ok(s, `files lists ${entry}, which does not exist`);
  }
});

test('every bin path is inside a directory that gets published', () => {
  const published = pkg.files.map((f) => f.replace(/\/$/, ''));
  for (const [name, target] of Object.entries(pkg.bin)) {
    const top = target.replace(/^\.\//, '').split('/')[0];
    assert.ok(
      published.includes(top),
      `bin ${name} lives in ${top}/, which files does not publish`
    );
  }
});

test('every export path is inside a directory that gets published', () => {
  const published = pkg.files.map((f) => f.replace(/\/$/, ''));
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    const rel = target.replace(/^\.\//, '');
    if (!rel.includes('/')) continue; // package.json itself is always included
    const top = rel.split('/')[0];
    assert.ok(
      published.includes(top),
      `exports["${subpath}"] lives in ${top}/, which files does not publish`
    );
  }
});

test('the package declares a Node version that supports what it uses', () => {
  // node --test with a glob and Object.hasOwn both need 20 or newer.
  assert.match(pkg.engines.node, />=\s*(2[0-9]|[3-9][0-9])/);
});

test('the package tells a reader where to find the source and report a bug', () => {
  // The whole credibility claim is "zero dependencies, read it yourself". Without
  // a repository link the npm page gives a reader no way to do that.
  assert.match(pkg.repository?.url ?? '', /^git\+https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/);
  assert.match(pkg.bugs?.url ?? '', /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues$/);
});

test('the declared licence ships as a file, and the two agree', async () => {
  // "license": "MIT" in package.json is metadata, not a grant. Without the text
  // in the tarball nobody has been given terms, and a reader who checks cannot
  // confirm the README's claim.
  assert.equal(pkg.license, 'MIT');
  const text = await readFile(join(root, 'LICENSE'), 'utf8');
  assert.match(text, /^MIT License/, 'LICENSE does not start as an MIT licence');
  assert.match(text, /THE SOFTWARE IS PROVIDED "AS IS"/, 'LICENSE is missing the warranty disclaimer');
});

test('the README documents every CLI command the binary accepts', async () => {
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  const cli = await readFile(join(root, 'bin/accrual.mjs'), 'utf8');
  // Commands are the keys of the `commands` object literal in the CLI. Stop at
  // the closing brace: past it lives the dispatcher, whose local names are not
  // commands.
  const start = cli.indexOf('const commands = {');
  assert.notEqual(start, -1, 'could not find the commands object in the CLI');
  const end = cli.indexOf('\n};', start);
  assert.notEqual(end, -1, 'the commands object is not closed the way this test expects');
  const block = cli.slice(start, end);
  const names = [...block.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1]).filter((n) => n !== 'help');
  assert.ok(names.length >= 8, `parsed only ${names.join(', ')} from the CLI`);
  for (const n of names) {
    assert.match(readme, new RegExp(`accrual ${n}\\b`), `README does not show \`accrual ${n}\``);
  }
});

test('the README documents every MCP tool the server advertises', async () => {
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  const server = await readFile(join(root, 'mcp/server.mjs'), 'utf8');
  const tools = [...server.matchAll(/^ {4}name: '([a-z_]+)',$/gm)].map((m) => m[1]);
  assert.ok(tools.length >= 13, `parsed only ${tools.length} tools from the server`);
  for (const t of tools) {
    assert.ok(readme.includes(t), `README does not mention the ${t} tool`);
  }
  assert.match(
    readme,
    new RegExp(`\\b${tools.length === 13 ? 'Thirteen' : String(tools.length)}\\b`, 'i'),
    'the README tool count does not match the server'
  );
});

test('the README and the MCP config it suggests agree with the declared bin', async () => {
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  for (const name of Object.keys(pkg.bin)) {
    assert.ok(readme.includes(name), `README never mentions the ${name} bin`);
  }
});

test('npm test works on the oldest Node the package claims to support', async () => {
  // The script was `node --test "test/**/*.test.mjs"`. Node only learned glob
  // patterns for --test in 22, so on the Node 20 that engines advertises it
  // failed with "Could not find", and `npm test` -- the one command the README
  // tells a reader to run to check the test count -- ran nothing at all. CI on
  // the engines floor is what caught it, after it had already shipped.
  const floor = Number(pkg.engines.node.match(/(\d+)/)[1]);
  const script = pkg.scripts.test;

  if (floor < 22) {
    assert.ok(
      !script.includes('**'),
      `the test script uses a glob, which node --test only supports from 22; engines allows ${floor}`
    );
  }

  // Whatever the form, it has to actually reach every test file.
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(join(root, 'test'))).filter((f) => f.endsWith('.test.mjs'));
  assert.ok(files.length >= 8, `expected the full suite, found ${files.length} files`);

  // And the pattern has to reach every file. Checked statically: the shell
  // expands it before Node sees it, so spawning the script here would either
  // recurse into this file or measure something other than resolution. The
  // end-to-end proof is CI running this same script on the engines floor.
  const pattern = script.match(/(\S*test\S*\.mjs)/)?.[1]?.replace(/"/g, '');
  assert.ok(pattern, `cannot tell which files the test script runs: ${script}`);

  const matcher = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\\\*\//g, '(?:.*/)?').replace(/\*/g, '[^/]*')}$`
  );
  const unmatched = files.filter((f) => !matcher.test(`test/${f}`));
  assert.deepEqual(
    unmatched,
    [],
    `the pattern ${pattern} never reaches: ${unmatched.join(', ')}`
  );
});

test('the test count advertised to humans and agents is the real one', async () => {
  // This claim has gone stale three times already (37, then 58, then 64 were all
  // being advertised while the suite had moved on). A number nobody checks is a
  // number that lies, and "verified by N tests" is the one claim a reader cannot
  // verify without running the suite. So count the tests and hold every surface
  // that quotes a figure to it.
  const { readdir } = await import('node:fs/promises');
  const dir = join(root, 'test');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.test.mjs'));
  let total = 0;
  for (const f of files) {
    const text = await readFile(join(dir, f), 'utf8');
    total += [...text.matchAll(/^test\(/gm)].length;
  }
  assert.ok(total > 0, 'counted no tests, so the count regex is wrong');

  const surfaces = [
    'README.md',
    'public/llms.txt',
    'public/agent.json',
    'public/index.html',
    'public/banner.svg',
    'public/card-agent.svg',
    'assets/banner.svg',
  ];
  for (const rel of surfaces) {
    const text = await readFile(join(root, rel), 'utf8');
    // Any figure attached to the word "tests", or the "N / N" scoreboard.
    const quoted = [
      ...text.matchAll(/(\d+)(?:\s*(?:\/|of)\s*\d+)?\s*(?:<\/?[a-z]+>\s*)?tests\b/gi),
      ...text.matchAll(/<dd>(\d+)\s*\/\s*\d+<\/dd>/g),
    ].map((m) => Number(m[1]));
    assert.ok(quoted.length > 0, `${rel} quotes no test count, so this test cannot guard it`);
    for (const n of quoted) {
      assert.equal(n, total, `${rel} advertises ${n} tests but the suite has ${total}`);
    }
  }
});
