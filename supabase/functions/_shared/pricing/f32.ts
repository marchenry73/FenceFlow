/**
 * Float discipline.
 *
 * Kotlin holds most of the geometry and the run spec as Float (32-bit); the
 * JVM computes each + - * / and sqrt on Floats as a correctly rounded 32-bit
 * result. JavaScript only has doubles, but a double operation on two values
 * that are exactly representable in float32, rounded back to float32 with
 * Math.fround, gives the identical bit pattern for those five operations --
 * that is a theorem about double rounding (53 >= 2*24 + 2 bits), not a hope.
 * So every Float that enters the port is loaded through f32(), and every
 * arithmetic result that Kotlin would hold in a Float is passed back through
 * it before it is used again. Money and quantities are Double on the phone
 * and stay plain doubles here.
 */
export const f32 = (x: number): number => Math.fround(x);

/**
 * Kotlin's `coerceAtLeast(min)`: `if (this < min) min else this`.
 *
 * Not Math.max. The two agree everywhere except -0 and NaN, and the whole
 * reason this file exists is to agree with the phone everywhere.
 */
export function coerceAtLeast(x: number, min: number): number {
  return x < min ? min : x;
}

/**
 * `kotlin.math.ceil(x).roundToInt()`, the idiom the engine uses for every
 * bay, panel and picket count. ceil of a float32 value is itself a float32
 * value, and roundToInt of an integral value is the identity, so the double
 * arithmetic here lands on the same integer.
 */
export function ceilRoundToInt(x: number): number {
  return Math.round(Math.ceil(x));
}

/** `Iterable<Float>.sum()`: a Float accumulator, starting at 0f, in list order. */
export function floatSum(values: readonly number[]): number {
  let sum = 0;
  for (const v of values) sum = f32(sum + v);
  return sum;
}

/** `Iterable<Double>.sum()` / `sumOf`: a Double accumulator, starting at 0.0, in list order. */
export function doubleSum(values: readonly number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum;
}

/**
 * `java.lang.Float.compare` / `Double.compare`, which `compareBy` uses for
 * numeric keys: a total order where -0.0 sorts before 0.0 and NaN sorts
 * after everything and equal to itself.
 */
export function compareIeee(a: number, b: number): number {
  if (a < b) return -1;
  if (a > b) return 1;
  const aNaN = Number.isNaN(a);
  const bNaN = Number.isNaN(b);
  if (aNaN || bNaN) return aNaN === bNaN ? 0 : aNaN ? 1 : -1;
  const aNeg = Object.is(a, -0);
  const bNeg = Object.is(b, -0);
  return aNeg === bNeg ? 0 : aNeg ? -1 : 1;
}

/** `java.lang.String.compareTo`: UTF-16 code unit order, which is also what `<` does to JS strings. */
export function compareString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `java.lang.Boolean.compareTo`: false before true. */
export function compareBoolean(a: boolean, b: boolean): number {
  return a === b ? 0 : a ? 1 : -1;
}

/**
 * `minWithOrNull(comparator)`: the first element among equal minima. Kotlin
 * only replaces its candidate when the comparator says the candidate is
 * strictly greater, so an earlier element keeps its place on a tie.
 */
export function minWithOrNull<T>(items: readonly T[], comparator: (a: T, b: T) => number): T | null {
  if (items.length === 0) return null;
  let min = items[0];
  for (let i = 1; i < items.length; i++) {
    const e = items[i];
    if (comparator(min, e) > 0) min = e;
  }
  return min;
}

/** `sortedWith(comparator)`: a stable copy-sort, which Array.prototype.sort has been since ES2019. */
export function sortedWith<T>(items: readonly T[], comparator: (a: T, b: T) => number): T[] {
  return items.slice().sort(comparator);
}
