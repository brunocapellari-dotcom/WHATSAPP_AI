import { mkdir, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const assets = [
  ['src/security/document-parser-worker.mjs', 'dist/src/security/document-parser-worker.mjs'],
];

for (const [from, to] of assets) {
  const target = resolve(to);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(from), target);
}
