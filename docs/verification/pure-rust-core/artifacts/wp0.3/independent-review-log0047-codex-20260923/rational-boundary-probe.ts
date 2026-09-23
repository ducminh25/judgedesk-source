import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRational, addRational, createRational } from "../../../../../../shared/rational.js";
import { calculateProblemSummary } from "../../../../../../server/judge/scoring.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const inputs = ["9007199254740991", "9007199254740992", "9007199254740993", "9007199254740994"];
const parsed = inputs.map((input) => ({ input, rational: parseRational(input) }));
const sums = [
  ["9007199254740991", "1"],
  ["9007199254740990", "1/3", "1/2", "1/6"],
  ["9007199254740990", "1/3", "1/6", "1/2"],
].map((values) => ({
  values,
  result: values.reduce((total, value) => addRational(total, parseRational(value)), createRational(0)),
}));
const summary = calculateProblemSummary({
  compileStatus: "OK",
  testCases: [{ name: "01", status: "AC", score: 9007199254740991 } as never,
    { name: "02", status: "AC", score: 1 } as never],
  testDirectories: ["01", "02"],
  config: { testScores: { "01": "9007199254740991", "02": "1" } },
});
const output = `${JSON.stringify({ parsed, sums, summary }, null, 2)}\n`;
fs.writeFileSync(path.join(here, "rational-boundary-probe.json"), output);
process.stdout.write(output);
