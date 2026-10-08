/**
 * Route-lookup regression gate (`pnpm run benchmark:routing:gate`).
 *
 * v1.40.0: each lookup is compared with a reference pass measured in the SAME
 * run (test/performance/route-lookup.bench.ts): the latency model's own reads
 * with no lookup logic. Machine load slows both sides alike, so the gate no
 * longer fails on a busy machine with unchanged routing code, as the fixed
 * millisecond baselines it replaces did (seen at load average 17-30). A lookup
 * fails when the median, over three runs, of its mean divided by its
 * reference's mean passes its baseline ratio by more than 15%: an extra round
 * of reads, or more time between reads, still shows.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const artifactRoot = resolve('.ci-artifacts/benchmarks/routing');
const runs = 3;
const maximumRegression = 0.15;
const ONE_READ = 'reference: one KV read';
const TWO_ROUNDS = 'reference: two KV rounds';
/**
 * Each lookup, its reference, and its expected ratio to it: 1, since the
 * lookup's own work is small next to a 2 ms read (measured at 0.95-1.13 per
 * run, medians 0.99-1.09, at load average 20).
 */
const benchmarks = {
  'deep exact hit': { reference: ONE_READ, baselineRatio: 1 },
  'deep root-wildcard hit': { reference: TWO_ROUNDS, baselineRatio: 1 },
  'deep miss': { reference: TWO_ROUNDS, baselineRatio: 1 },
};

const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
await mkdir(artifactRoot, { recursive: true });
/** Per benchmark, the mean of each run, references included. */
const means = Object.fromEntries(
  [...Object.keys(benchmarks), ONE_READ, TWO_ROUNDS].map(name => [name, []]),
);

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
    if (benchmark.name in means) means[benchmark.name].push(benchmark.mean);
  }
}

for (const [name, values] of Object.entries(means)) {
  if (values.length !== runs) throw new Error(`Expected ${runs} measurements for ${name}`);
}

const results = Object.entries(benchmarks).map(([name, { reference, baselineRatio }]) => {
  const runRatios = means[name].map((mean, index) => mean / means[reference][index]);
  const medianRatio = median(runRatios);
  const maximumRatio = baselineRatio * (1 + maximumRegression);
  return {
    name,
    reference,
    runMeansMs: means[name],
    referenceRunMeansMs: means[reference],
    runRatios,
    medianRatio,
    baselineRatio,
    maximumRatio,
    regressionPercent: ((medianRatio - baselineRatio) / baselineRatio) * 100,
    passed: medianRatio <= maximumRatio,
  };
});
await writeFile(
  resolve(artifactRoot, 'summary.json'),
  `${JSON.stringify({ maximumRegressionPercent: maximumRegression * 100, results }, null, 2)}\n`,
);
for (const result of results) {
  console.log(
    `${result.name}: ${median(result.runMeansMs).toFixed(4)} ms median; ` +
      `${result.medianRatio.toFixed(4)}x its reference (${result.reference}); ` +
      `baseline ${result.baselineRatio.toFixed(2)}x; ` +
      `change ${result.regressionPercent.toFixed(2)}%; ` +
      `limit ${result.maximumRatio.toFixed(4)}x`,
  );
}
if (!results.every(result => result.passed)) process.exitCode = 1;
