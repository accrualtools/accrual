// Renders every SVG in public/ to a PNG beside it.
//
// This exists because the PNGs were once rendered at a single hard-coded
// 1600x900, which is right for the share cards and wrong for everything else:
// the banner has a 1500x500 viewBox and came out stretched, with no error to
// say so. An SVG already carries its intended size, so read it from the file
// instead of passing one in.

import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const run = promisify(execFile);
const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function intrinsicSize(svg) {
  const box = svg.match(/viewBox="\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/);
  if (box) return { width: Math.round(+box[3]), height: Math.round(+box[4]) };

  const width = svg.match(/\bwidth="(\d+)"/)?.[1];
  const height = svg.match(/\bheight="(\d+)"/)?.[1];
  if (width && height) return { width: +width, height: +height };

  return null;
}

async function main() {
  const files = (await readdir(publicDir)).filter((f) => f.endsWith('.svg')).sort();
  let rendered = 0;

  for (const file of files) {
    const svg = await readFile(join(publicDir, file), 'utf8');
    const size = intrinsicSize(svg);
    if (!size) {
      console.error(`  ${file.padEnd(20)} skipped, no viewBox or explicit size`);
      continue;
    }

    const out = file.replace(/\.svg$/, '.png');
    await run('rsvg-convert', [
      '-w', String(size.width),
      '-h', String(size.height),
      join(publicDir, file),
      '-o', join(publicDir, out),
    ]);
    console.log(`  ${out.padEnd(20)} ${size.width}x${size.height}`);
    rendered += 1;
  }

  console.log(`\n${rendered} of ${files.length} svg files rendered at their own size`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  await main();
}
