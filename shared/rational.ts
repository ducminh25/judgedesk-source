export interface Rational {
  n: number | string;
  d: number | string;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_RATIONAL_TEXT_LENGTH = 1024;

function asComponent(value: bigint): number | string {
  return value >= -MAX_SAFE && value <= MAX_SAFE ? Number(value) : value.toString();
}

function asBigInt(value: number | string | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string") {
    if (value.length > MAX_RATIONAL_TEXT_LENGTH || !/^[+-]?\d+$/.test(value)) {
      throw new RangeError("Invalid rational component");
    }
    return BigInt(value);
  }
  if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
    throw new RangeError("Rational component must be a safe integer");
  }
  return BigInt(value);
}

function gcdExact(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const remainder = x % y;
    x = y;
    y = remainder;
  }
  return x;
}

function exactRational(n: bigint, d: bigint): Rational {
  if (d === 0n) return { n: 0, d: 1 };
  const sign = d < 0n ? -1n : 1n;
  const numerator = n * sign;
  const denominator = d * sign;
  const divisor = gcdExact(numerator, denominator) || 1n;
  const reducedNumerator = numerator / divisor;
  const reducedDenominator = denominator / divisor;
  if (reducedNumerator.toString().length > MAX_RATIONAL_TEXT_LENGTH
    || reducedDenominator.toString().length > MAX_RATIONAL_TEXT_LENGTH) {
    throw new RangeError("Rational magnitude out of bounds");
  }
  return { n: asComponent(reducedNumerator), d: asComponent(reducedDenominator) };
}

export function gcd(a: number, b: number): number {
  let x = Math.trunc(Math.abs(a));
  let y = Math.trunc(Math.abs(b));
  while (y > 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x;
}

export function createRational(n: number | string | bigint, d: number | string | bigint = 1): Rational {
  if ((typeof n === "number" && !Number.isFinite(n))
    || (typeof d === "number" && !Number.isFinite(d))) {
    return { n: 0, d: 1 };
  }
  const numerator = typeof n === "number" ? Math.round(n) : n;
  const denominator = typeof d === "number" ? Math.round(d) : d;
  return exactRational(asBigInt(numerator), asBigInt(denominator));
}

export function floatToRational(x: number, maxDen: number = 100000): Rational {
  if (Number.isInteger(x)) return { n: x, d: 1 };
  const sign = x < 0 ? -1 : 1;
  let val = Math.abs(x);
  let h1 = 1, h2 = 0;
  let k1 = 0, k2 = 1;
  let b = val;
  do {
    const a = Math.floor(b);
    let aux = h1;
    h1 = a * h1 + h2;
    h2 = aux;
    aux = k1;
    k1 = a * k1 + k2;
    k2 = aux;
    b = 1 / (b - a);
  } while (Math.abs(val - h1 / k1) > 1e-9 && k1 <= maxDen && Number.isFinite(b));

  return createRational(sign * h1, k1);
}

export function parseRational(input: unknown): Rational {
  if (input === null || input === undefined || input === "") {
    return { n: 0, d: 1 };
  }
  if (typeof input === "object" && input !== null && "n" in input && "d" in input) {
    const r = input as Rational;
    return createRational(r.n, r.d);
  }
  if (typeof input === "number") {
    if (Number.isNaN(input) || !Number.isFinite(input)) return { n: 0, d: 1 };
    if (Number.isInteger(input) && !Number.isSafeInteger(input)) {
      throw new RangeError("Unsafe numeric score; provide an exact string");
    }
    const nearestInt = Math.round(input);
    if (Math.abs(input - nearestInt) < 1e-9) {
      return { n: nearestInt, d: 1 };
    }
    const rounded6 = Math.round(input * 1e6) / 1e6;
    if (Math.abs(input - rounded6) < 1e-8) {
      return floatToRational(rounded6);
    }
    return floatToRational(input);
  }
  if (typeof input === "string") {
    const trimmed = input.trim().replace(/,/g, ".");
    if (!trimmed) return { n: 0, d: 1 };
    if (trimmed.length > MAX_RATIONAL_TEXT_LENGTH) {
      throw new RangeError("Rational text too long");
    }
    if (trimmed.includes("/")) {
      const parts = trimmed.split("/");
      if (parts.length === 2) {
        const numerator = parseRational(parts[0]);
        const denominator = parseRational(parts[1]);
        return divideRational(numerator, denominator);
      }
    }
    const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(trimmed);
    if (!match) return { n: 0, d: 1 };
    const fraction = match[3] ?? match[4] ?? "";
    const exponent = match[5] ? Number(match[5]) : 0;
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) {
      throw new RangeError("Rational decimal exponent out of bounds");
    }
    const signedDigits = BigInt(`${match[1]}${match[2] ?? "0"}${fraction}`);
    const shift = exponent - fraction.length;
    return shift >= 0
      ? exactRational(signedDigits * 10n ** BigInt(shift), 1n)
      : exactRational(signedDigits, 10n ** BigInt(-shift));
  }
  return { n: 0, d: 1 };
}

export function addRational(a: Rational, b: Rational): Rational {
  return exactRational(asBigInt(a.n) * asBigInt(b.d) + asBigInt(b.n) * asBigInt(a.d), asBigInt(a.d) * asBigInt(b.d));
}

export function subtractRational(a: Rational, b: Rational): Rational {
  return exactRational(asBigInt(a.n) * asBigInt(b.d) - asBigInt(b.n) * asBigInt(a.d), asBigInt(a.d) * asBigInt(b.d));
}

export function compareRational(a: Rational, b: Rational): number {
  const delta = asBigInt(a.n) * asBigInt(b.d) - asBigInt(b.n) * asBigInt(a.d);
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}

export function multiplyRational(a: Rational, b: Rational): Rational {
  return exactRational(asBigInt(a.n) * asBigInt(b.n), asBigInt(a.d) * asBigInt(b.d));
}

export function divideRational(a: Rational, b: Rational): Rational {
  if (asBigInt(b.n) === 0n) return { n: 0, d: 1 };
  return exactRational(asBigInt(a.n) * asBigInt(b.d), asBigInt(a.d) * asBigInt(b.n));
}

export function rationalToNumber(r: Rational): number {
  const value = asBigInt(r.d) === 0n ? 0 : Number(r.n) / Number(r.d);
  if (!Number.isFinite(value)) throw new RangeError("Score presentation is out of numeric range");
  return value;
}

export function rationalToRoundedNumber(r: Rational, decimalPlaces: number): number {
  return rationalToNumber(roundRational(r, decimalPlaces));
}

function roundRational(r: Rational, decimalPlaces: number): Rational {
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 10) {
    throw new RangeError("Invalid score display precision");
  }
  const scale = 10n ** BigInt(decimalPlaces);
  const numerator = asBigInt(r.n) * scale;
  const denominator = asBigInt(r.d);
  if (denominator <= 0n) throw new RangeError("Invalid score denominator");
  let rounded = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder > 0n && remainder * 2n >= denominator) ++rounded;
  if (remainder < 0n && -remainder * 2n > denominator) --rounded;
  return exactRational(rounded, scale);
}

/** Decimal-only wire presentation; never use this rounded text for scoring. */
export function formatRationalDecimal(r: Rational, decimalPlaces: number): string {
  const rounded = roundRational(r, decimalPlaces);
  const decimal = exactTerminatingDecimal(rounded, decimalPlaces);
  if (decimal === null) throw new RangeError("Invalid decimal score");
  if (decimalPlaces === 0) return decimal;
  const [whole, fraction = ""] = decimal.split(".");
  return `${whole}.${fraction.padEnd(decimalPlaces, "0")}`;
}

export function isCanonicalRational(value: unknown): value is Rational {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || !("n" in record) || !("d" in record)) return false;
  const validComponent = (component: unknown): component is number | string => typeof component === "number"
    ? Number.isSafeInteger(component)
    : typeof component === "string" && component.length <= MAX_RATIONAL_TEXT_LENGTH && /^-?\d+$/.test(component);
  if (!validComponent(record.n) || !validComponent(record.d)) return false;
  try {
    if (BigInt(record.d) <= 0n) return false;
    const reduced = createRational(record.n, record.d);
    rationalToNumber(reduced);
    return String(reduced.n) === String(record.n) && String(reduced.d) === String(record.d);
  } catch {
    return false;
  }
}

export function isTerminatingDecimal(denominator: number | string): boolean {
  let d = asBigInt(denominator);
  if (d <= 0n) return false;
  while (d % 2n === 0n) d /= 2n;
  while (d % 5n === 0n) d /= 5n;
  return d === 1n;
}

function exactTerminatingDecimal(r: Rational, maxDecimals: number): string | null {
  if (!Number.isInteger(maxDecimals) || maxDecimals < 0 || maxDecimals > 1000) return null;
  let denominator = asBigInt(r.d);
  if (denominator <= 0n) return null;
  let twos = 0;
  let fives = 0;
  while (denominator % 2n === 0n) {
    denominator /= 2n;
    ++twos;
  }
  while (denominator % 5n === 0n) {
    denominator /= 5n;
    ++fives;
  }
  if (denominator !== 1n) return null;
  const places = Math.max(twos, fives);
  if (places > maxDecimals) return null;
  const scaled = asBigInt(r.n) * 10n ** BigInt(places) / asBigInt(r.d);
  if (places === 0) return scaled.toString();
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(places + 1, "0");
  const whole = digits.slice(0, -places);
  const fraction = digits.slice(-places).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function formatRational(r: Rational, maxDecimals: number = 4): string {
  if (r.n === 0) return "0";
  const decimal = exactTerminatingDecimal(r, maxDecimals);
  if (decimal !== null) return decimal;
  return `${r.n}/${r.d}`;
}

export function formatScore(score: unknown, maxDecimals: number = 4): string {
  if (score === null || score === undefined || score === "") return "-";
  const r = parseRational(score);
  return formatRational(r, maxDecimals);
}

export function toCanonicalPointValue(r: Rational): number | string {
  if (r.d === 1) return r.n;
  const decimal = exactTerminatingDecimal(r, 4);
  if (decimal !== null) {
    const numeric = Number(decimal);
    return Number.isFinite(numeric) && numeric.toString() === decimal ? numeric : decimal;
  }
  return `${r.n}/${r.d}`;
}
