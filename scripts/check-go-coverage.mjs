import { readFile } from 'node:fs/promises';

try {
  const [path, requested = '80'] = process.argv.slice(2);
  const threshold = Number(requested);
  if (!path || !Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new Error('Usage: check-go-coverage.mjs <profile> <threshold 0..100>');
  }
  const lines = (await readFile(path, 'utf8')).trim().split(/\r?\n/);
  if (!/^mode: (set|count|atomic)$/.test(lines.shift() ?? '')) {
    throw new Error('Invalid or empty Go coverage profile');
  }
  let total = 0;
  let covered = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const match = /^.+:\d+\.\d+,\d+\.\d+ (\d+) (\d+)$/.exec(line);
    if (!match) throw new Error('Invalid Go coverage record');
    const statements = Number(match[1]);
    const hits = Number(match[2]);
    if (!Number.isSafeInteger(statements) || !Number.isSafeInteger(hits)) {
      throw new Error('Invalid Go coverage count');
    }
    total += statements;
    if (hits > 0) covered += statements;
  }
  if (total === 0 || !Number.isSafeInteger(total)) throw new Error('Coverage profile has no valid statements');
  const percentage = covered / total * 100;
  console.log(`Go statement coverage: ${percentage.toFixed(2)}% (${covered}/${total})`);
  if (percentage < threshold) throw new Error(`Coverage is below ${threshold}%`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Coverage check failed');
  process.exitCode = 1;
}
