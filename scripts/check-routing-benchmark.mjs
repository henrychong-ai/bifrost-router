import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const artifactRoot = resolve('.ci-artifacts/benchmarks/routing');
const runs = 3;
const maximumRegression = 0.15;
const baselines = {
  'deep exact hit': 2.2371,
  'deep root-wildcard hit': 4.6129,
  'deep miss': 4.6129,
};

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
await mkdir(artifactRoot, { recursive: true });
const measurements = Object.fromEntries(Object.keys(baselines).map(name => [name, []]));

for (let index = 1; index <= runs; index += 1) {
  const outputPath = resolve(artifactRoot, `run-${index}.json`);
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const completed = spawnSync(
    command,
    [
      'exec',
      'vitest',
      'bench',
      '--run',
      'test/performance/route-lookup.bench.ts',
      '--outputJson',
      outputPath,
    ],
    { env: { ...process.env, CI: '1' }, stdio: 'inherit' },
  );
  if (completed.status !== 0) process.exit(completed.status ?? 1);
  const report = JSON.parse(await readFile(outputPath, 'utf8'));
  for (const benchmark of report.files.flatMap(file =>
    file.groups.flatMap(group => group.benchmarks),
  )) {
    if (benchmark.name in measurements) measurements[benchmark.name].push(benchmark.mean);
  }
}

const results = Object.entries(baselines).map(([name, baselineMeanMs]) => {
  const values = measurements[name];
  if (values.length !== runs) throw new Error(`Expected ${runs} measurements for ${name}`);
  const medianMeanMs = median(values);
  const maximumMeanMs = baselineMeanMs * (1 + maximumRegression);
  return {
    name,
    runMeansMs: values,
    medianMeanMs,
    baselineMeanMs,
    maximumMeanMs,
    regressionPercent: ((medianMeanMs - baselineMeanMs) / baselineMeanMs) * 100,
    passed: medianMeanMs <= maximumMeanMs,
  };
});
await writeFile(
  resolve(artifactRoot, 'summary.json'),
  `${JSON.stringify({ maximumRegressionPercent: 15, results }, null, 2)}\n`,
);
for (const result of results) {
  console.log(
    `${result.name}: ${result.medianMeanMs.toFixed(4)} ms median; ` +
      `baseline ${result.baselineMeanMs.toFixed(4)} ms; ` +
      `change ${result.regressionPercent.toFixed(2)}%; ` +
      `limit ${result.maximumMeanMs.toFixed(4)} ms`,
  );
}
if (!results.every(result => result.passed)) process.exitCode = 1;
