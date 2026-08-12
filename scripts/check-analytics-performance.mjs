import { spawnSync } from 'node:child_process';

const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const completed = spawnSync(
  command,
  ['exec', 'vitest', 'run', 'test/performance/analytics-performance.test.ts', '--reporter=verbose'],
  {
    env: { ...process.env, CI: '1', VITE_RUN_ANALYTICS_PERFORMANCE_GATE: '1' },
    encoding: 'utf8',
  },
);

process.stdout.write(completed.stdout ?? '');
process.stderr.write(completed.stderr ?? '');
if (completed.status !== 0) process.exit(completed.status ?? 1);

const marker = 'ANALYTICS_PERFORMANCE_JSON:';
const line = (completed.stdout ?? '').split('\n').find(candidate => candidate.includes(marker));
if (!line) throw new Error('analytics benchmark result marker was not emitted');
const result = JSON.parse(line.slice(line.indexOf(marker) + marker.length));
if (!result.passed || result.runTimesMs.length !== 3) process.exitCode = 1;
console.log(
  `Analytics summary: ${result.medianMs.toFixed(2)} ms median ` +
    `(${result.runTimesMs.map(value => value.toFixed(2)).join(', ')} ms; ` +
    `limit ${result.maximumMedianMs.toFixed(2)} ms).`,
);
