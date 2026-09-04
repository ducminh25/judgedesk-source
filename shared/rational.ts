export interface Rational {
  n: number;
  d: number;
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

export function createRational(n: number, d: number = 1): Rational {
  if (d === 0 || !Number.isFinite(n) || !Number.isFinite(d)) {
    return { n: 0, d: 1 };
  }
  let num = Math.round(n);
  let den = Math.round(d);
  if (den < 0) {
    num = -num;
    den = -den;
  }
  const divisor = gcd(num, den) || 1;
  return {
    n: num / divisor,
    d: den / divisor,
  };
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
    const trimmed = input.trim();
    if (!trimmed) return { n: 0, d: 1 };
    if (trimmed.includes("/")) {
      const parts = trimmed.split("/");
      if (parts.length === 2) {
        const num = parseFloat(parts[0]);
        const den = parseFloat(parts[1]);
        if (!Number.isNaN(num) && !Number.isNaN(den) && den !== 0) {
          return divideRational(parseRational(num), parseRational(den));
        }
      }
    }
    const num = parseFloat(trimmed);
    if (!Number.isNaN(num)) {
      return parseRational(num);
    }
  }
  return { n: 0, d: 1 };
}

export function addRational(a: Rational, b: Rational): Rational {
  return createRational(a.n * b.d + b.n * a.d, a.d * b.d);
}

export function subtractRational(a: Rational, b: Rational): Rational {
  return createRational(a.n * b.d - b.n * a.d, a.d * b.d);
}

export function multiplyRational(a: Rational, b: Rational): Rational {
  return createRational(a.n * b.n, a.d * b.d);
}

export function divideRational(a: Rational, b: Rational): Rational {
  if (b.n === 0) return { n: 0, d: 1 };
  return createRational(a.n * b.d, a.d * b.n);
}

export function rationalToNumber(r: Rational): number {
  return r.d === 0 ? 0 : r.n / r.d;
}

export function isTerminatingDecimal(denominator: number): boolean {
  if (denominator <= 0) return false;
  let d = denominator;
  while (d % 2 === 0) d /= 2;
  while (d % 5 === 0) d /= 5;
  return d === 1;
}

export function formatRational(r: Rational, maxDecimals: number = 2): string {
  if (r.n === 0) return "0";
  if (r.d === 1) return `${r.n}`;
  
  if (isTerminatingDecimal(r.d)) {
    const val = r.n / r.d;
    const factor = Math.pow(10, maxDecimals);
    if (Math.round(val * factor) === val * factor) {
      return parseFloat(val.toFixed(maxDecimals)).toString();
    }
  }

  return `${r.n}/${r.d}`;
}

export function formatScore(score: unknown, maxDecimals: number = 2): string {
  if (score === null || score === undefined || score === "") return "-";
  const r = parseRational(score);
  return formatRational(r, maxDecimals);
}

export function toCanonicalPointValue(r: Rational): number | string {
  if (r.d === 1) return r.n;
  if (isTerminatingDecimal(r.d)) {
    const val = r.n / r.d;
    if (Math.round(val * 10_000) === val * 10_000) {
      return parseFloat(val.toFixed(4));
    }
  }
  return `${r.n}/${r.d}`;
}
