import { readdir, readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const directory = resolve('docs');
for (const name of await readdir(directory)) {
  if (!name.endsWith('.md')) continue;
  const path = resolve(directory, name);
  const source = await readFile(path, 'utf8');
  for (const [, href] of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    if (/^(https?:|#)/.test(href)) continue;
    await access(resolve(dirname(path), href.split('#')[0]));
  }
}
console.log('Documentation links verified.');
