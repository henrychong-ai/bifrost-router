import { captureUnifiedTrafficResponse } from '../src/index';

const iterations = 100_000;
const runCount = 5;
const maximumIncrementalNanosecondsPerOperation = 1_000;
let nextCalls = 0;

const context = {
  env: { UNIFIED_TRAFFIC_MODE: 'off' },
  req: {
    url: 'https://example.com/public/path?campaign=benchmark',
    path: '/public/path',
    header: () => 'Mozilla/5.0',
  },
};
const next = async () => {
  nextCalls += 1;
};
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function measureBaseline(): Promise<number> {
  const startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1) await next();
  return ((performance.now() - startedAt) * 1_000_000) / iterations;
}

async function measureInstrumented(): Promise<number> {
  const startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    await captureUnifiedTrafficResponse(context as never, next);
  }
  return ((performance.now() - startedAt) * 1_000_000) / iterations;
}

for (let index = 0; index < 10_000; index += 1) {
  await next();
  await captureUnifiedTrafficResponse(context as never, next);
}
const samples = [];
for (let run = 0; run < runCount; run += 1) {
  const baseline = await measureBaseline();
  const instrumented = await measureInstrumented();
  samples.push({ baseline, instrumented, incremental: Math.max(0, instrumented - baseline) });
}
const baseline = median(samples.map(sample => sample.baseline));
const instrumented = median(samples.map(sample => sample.instrumented));
const incremental = median(samples.map(sample => sample.incremental));
const expectedNextCalls = 20_000 + iterations * runCount * 2;
console.log(
  `Unified capture disabled middleware: ${instrumented.toFixed(2)} ns/op ` +
    `(${incremental.toFixed(2)} ns/op incremental; limit ` +
    `${maximumIncrementalNanosecondsPerOperation.toLocaleString()} ns/op; ` +
    `baseline ${baseline.toFixed(2)} ns/op; 0 scheduled writes)`,
);
if (nextCalls !== expectedNextCalls || incremental > maximumIncrementalNanosecondsPerOperation) {
  process.exitCode = 1;
}
