import assert from "node:assert/strict";
import test from "node:test";
import {
  addRational,
  createRational,
  divideRational,
  floatToRational,
  formatRational,
  formatRationalDecimal,
  formatScore,
  gcd,
  multiplyRational,
  parseRational,
  rationalToNumber,
  toCanonicalPointValue,
} from "./rational.js";

test("decimal protocol presentation rounds rationals without losing large integers", () => {
  assert.equal(formatRationalDecimal(createRational(1, 8), 6), "0.125000");
  assert.equal(formatRationalDecimal(createRational(1, 3), 6), "0.333333");
  assert.equal(formatRationalDecimal(createRational(2, 3), 6), "0.666667");
  assert.equal(formatRationalDecimal(parseRational("9007199254740993.125"), 6), "9007199254740993.125000");
  assert.equal(formatRationalDecimal(createRational(-1, 8), 2), "-0.12");
  assert.equal(formatRationalDecimal(createRational(0), 0), "0");
  assert.throws(() => formatRationalDecimal(createRational(1), 11), /precision/);
});

test("gcd calculates greatest common divisor", () => {
  assert.equal(gcd(12, 18), 6);
  assert.equal(gcd(100, 25), 25);
  assert.equal(gcd(7, 13), 1);
  assert.equal(gcd(-6, 8), 2);
});

test("createRational simplifies fractions and handles signs", () => {
  assert.deepEqual(createRational(6, 4), { n: 3, d: 2 });
  assert.deepEqual(createRational(-6, 4), { n: -3, d: 2 });
  assert.deepEqual(createRational(6, -4), { n: -3, d: 2 });
  assert.deepEqual(createRational(-6, -4), { n: 3, d: 2 });
  assert.deepEqual(createRational(0, 5), { n: 0, d: 1 });
});

test("parseRational parses integers, decimals, fractions and IEEE float epsilons", () => {
  assert.deepEqual(parseRational("1/3"), { n: 1, d: 3 });
  assert.deepEqual(parseRational("5/3"), { n: 5, d: 3 });
  assert.deepEqual(parseRational("2"), { n: 2, d: 1 });
  assert.deepEqual(parseRational("0.5"), { n: 1, d: 2 });
  assert.deepEqual(parseRational("3.5"), { n: 7, d: 2 });
  assert.deepEqual(parseRational("0.35"), { n: 7, d: 20 });

  // Floating point precision epsilon snapping
  assert.deepEqual(parseRational(2.99999999999999), { n: 3, d: 1 });
  assert.deepEqual(parseRational(3.499999999999987), { n: 7, d: 2 });
});

test("string integers beyond the safe Number range retain their exact value", () => {
  assert.deepEqual(parseRational("9007199254740993"), { n: "9007199254740993", d: 1 });
  assert.throws(() => parseRational(9007199254740993), /Unsafe numeric score/);
  assert.throws(() => parseRational("1".repeat(1025)), /Rational text too long/);
});

test("fraction accumulation at the safe-integer boundary is order independent", () => {
  const orders = [
    ["1/3", "1/2", "1/6", "9007199254740990"],
    ["9007199254740990", "1/3", "1/2", "1/6"],
  ];
  for (const values of orders) {
    const sum = values.reduce((total, value) => addRational(total, parseRational(value)), createRational(0));
    assert.deepEqual(sum, { n: 9007199254740991, d: 1 });
  }
});

test("decimal strings are parsed exactly before arithmetic", () => {
  const sum = addRational(parseRational("0.1"), parseRational("0.2"));
  assert.deepEqual(sum, { n: 3, d: 10 });
  assert.deepEqual(parseRational("1.25e-2"), { n: 1, d: 80 });
  assert.deepEqual(parseRational(".5"), { n: 1, d: 2 });
  assert.deepEqual(parseRational("-.5"), { n: -1, d: 2 });
  assert.deepEqual(parseRational("1."), { n: 1, d: 1 });
  assert.deepEqual(parseRational(".5e-2"), { n: 1, d: 200 });
});

test("parseRational normalizes decimal commas in numbers and fractions", () => {
  assert.deepEqual(parseRational("2,5"), { n: 5, d: 2 });
  assert.deepEqual(parseRational(" 2,5 "), { n: 5, d: 2 });
  assert.deepEqual(parseRational("2,5/5"), { n: 1, d: 2 });
  assert.deepEqual(parseRational(",5"), { n: 1, d: 2 });
  assert.deepEqual(parseRational("-,5"), { n: -1, d: 2 });
  assert.deepEqual(parseRational("1,"), { n: 1, d: 1 });
  assert.deepEqual(parseRational("1,25e-2"), { n: 1, d: 80 });
});

test("formatting and config serialization keep large terminating fractions exact", () => {
  const value = parseRational("9007199254740993/2");
  assert.equal(formatRational(value), "4503599627370496.5");
  assert.equal(toCanonicalPointValue(value), "4503599627370496.5");
});

test("numeric presentation rejects nonfinite magnitudes", () => {
  assert.throws(() => rationalToNumber(parseRational("1e1000")), /presentation.*range/i);
});

test("fraction operations work accurately without floating point drift", () => {
  const oneThird = parseRational("1/3");
  
  // 1/3 * 6 = 2
  const timesSix = multiplyRational(oneThird, createRational(6));
  assert.deepEqual(timesSix, { n: 2, d: 1 });
  assert.equal(formatRational(timesSix), "2");

  // 1/3 * 5 = 5/3
  const timesFive = multiplyRational(oneThird, createRational(5));
  assert.deepEqual(timesFive, { n: 5, d: 3 });
  assert.equal(formatRational(timesFive), "5/3");

  // Summing 6 tests of 1/3
  let sum = createRational(0);
  for (let i = 0; i < 6; ++i) {
    sum = addRational(sum, oneThird);
  }
  assert.equal(formatRational(sum), "2");

  // Summing 10 tests of 0.35 (3.5)
  const point35 = parseRational("0.35");
  let sumPoint35 = createRational(0);
  for (let i = 0; i < 10; ++i) {
    sumPoint35 = addRational(sumPoint35, point35);
  }
  assert.equal(formatRational(sumPoint35), "3.5");
});

test("formatScore formats terminating decimals, repeating fractions, and floats cleanly", () => {
  // Integers
  assert.equal(formatScore(2), "2");
  assert.equal(formatScore("2"), "2");
  assert.equal(formatScore(0), "0");

  // Terminating decimals (<= 2 places)
  assert.equal(formatScore(0.5), "0.5");
  assert.equal(formatScore(3.5), "3.5");
  assert.equal(formatScore(1.25), "1.25");
  assert.equal(formatScore("0.35"), "0.35");

  // IEEE 754 precision bug cases from user screenshot
  assert.equal(formatScore(2.99999999999999), "3");
  assert.equal(formatScore(3.499999999999987), "3.5");

  // Terminating decimals up to 4 places (e.g. 1/40 = 0.025, 141/40 = 3.525)
  assert.equal(formatScore({ n: 1, d: 40 }), "0.025");
  assert.equal(formatScore({ n: 141, d: 40 }), "3.525");
  assert.equal(formatScore("0.025"), "0.025");

  // Repeating fractions
  assert.equal(formatScore("1/3"), "1/3");
  assert.equal(formatScore("5/3"), "5/3");
  assert.equal(formatScore("10/3"), "10/3");
  assert.equal(formatScore("1/6"), "1/6");
});
