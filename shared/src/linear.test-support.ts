/**
 * Test support for the linear-scan rewrites (v1.39.0): exhaustive short
 * inputs to compare a rewrite with the regex it replaces, and a growth-ratio
 * check that fails a polynomial implementation without a wall-clock budget
 * (a time limit passes on a fast machine and fails on a loaded one). Not part
 * of the package build (tsconfig excludes `*.test-support.ts`).
 */

/** Every string over `alphabet` up to `maxLength` characters. */
export function allStrings(alphabet: readonly string[], maxLength: number): string[] {
  const out = [''];
  let level = [''];
  for (let length = 1; length <= maxLength; length += 1) {
    level = level.flatMap(prefix => alphabet.map(char => prefix + char));
    out.push(...level);
  }
  return out;
}

/** Time per call of `run()`, the best of three batches of at least 2 ms each. */
function timePerCall(run: () => unknown): number {
  let best = Number.POSITIVE_INFINITY;
  for (let batch = 0; batch < 3; batch += 1) {
    let calls = 0;
    const started = performance.now();
    let elapsed = 0;
    do {
      run();
      calls += 1;
      elapsed = performance.now() - started;
    } while (elapsed < 2);
    best = Math.min(best, elapsed / calls);
  }
  return best;
}

/** The middle value of `values` (an odd count): the one with half the rest below it. */
function median(values: readonly number[]): number {
  const middle = Math.floor(values.length / 2);
  for (const candidate of values) {
    const below = values.filter(value => value < candidate).length;
    const equal = values.filter(value => value === candidate).length;
    if (below <= middle && middle < below + equal) return candidate;
  }
  return Number.NaN;
}

/**
 * How much slower `fn` runs on an input `factor` times longer: about `factor`
 * for a linear scan, about `factor`² for a quadratic one. `makeInput(n)`
 * builds a worst-case input of length about n. The median of five ratios,
 * each from timings of both sizes taken back to back, so a burst of load
 * during one sample moves neither the result nor the test.
 */
export function growthRatio(
  fn: (input: string) => unknown,
  makeInput: (size: number) => string,
  size = 20_000,
  factor = 8,
): number {
  const small = makeInput(size);
  const large = makeInput(size * factor);
  const ratios: number[] = [];
  for (let sample = 0; sample < 5; sample += 1) {
    ratios.push(timePerCall(() => fn(large)) / timePerCall(() => fn(small)));
  }
  return median(ratios);
}

/**
 * The bound a growth ratio must stay under: four times the linear ratio (8),
 * generous for a loaded machine, and half the quadratic one (64).
 */
export const LINEAR_GROWTH_LIMIT = 32;
