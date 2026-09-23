import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStandardChecker } from "../server/judge/standard-checkers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

interface FixtureDef {
  id: string;
  checker: "C1" | "C2" | "C3" | "C4" | "C5";
  description: string;
  expected: Buffer;
  actual: Buffer;
}

const FIXTURES: FixtureDef[] = [
  // --- BAI5 Original 10 Tests ---
  { id: "bai5_test00", checker: "C1", description: "BAI5 test00: number 4 with CRCRLF", expected: Buffer.from("4\r\r\n"), actual: Buffer.from("4") },
  { id: "bai5_test01", checker: "C1", description: "BAI5 test01: number 6 with CRCRLF", expected: Buffer.from("6\r\r\n"), actual: Buffer.from("6") },
  { id: "bai5_test02", checker: "C1", description: "BAI5 test02: number 7 with CRCRLF", expected: Buffer.from("7\r\r\n"), actual: Buffer.from("7") },
  { id: "bai5_test03", checker: "C1", description: "BAI5 test03: number 11 with CRCRLF", expected: Buffer.from("11\r\r\n"), actual: Buffer.from("11") },
  { id: "bai5_test04", checker: "C1", description: "BAI5 test04: number 18 with CRCRLF", expected: Buffer.from("18\r\r\n"), actual: Buffer.from("18") },
  { id: "bai5_test05", checker: "C1", description: "BAI5 test05: number 53 with CRCRLF", expected: Buffer.from("53\r\r\n"), actual: Buffer.from("53") },
  { id: "bai5_test06", checker: "C1", description: "BAI5 test06: number 144 with CRCRLF", expected: Buffer.from("144\r\r\n"), actual: Buffer.from("144") },
  { id: "bai5_test07", checker: "C1", description: "BAI5 test07: number 232 with CRCRLF", expected: Buffer.from("232\r\r\n"), actual: Buffer.from("232") },
  { id: "bai5_test08", checker: "C1", description: "BAI5 test08: number 258 with CRCRLF", expected: Buffer.from("258\r\r\n"), actual: Buffer.from("258") },
  { id: "bai5_test09", checker: "C1", description: "BAI5 test09: number 270 with no newline", expected: Buffer.from("270"), actual: Buffer.from("270") },

  // --- C1: LinesWordsIgnoreCase ---
  { id: "c1_empty_both_ac", checker: "C1", description: "C1: both files empty", expected: Buffer.from(""), actual: Buffer.from("") },
  { id: "c1_empty_expected_wa", checker: "C1", description: "C1: empty expected vs non-empty actual", expected: Buffer.from(""), actual: Buffer.from("hello") },
  { id: "c1_empty_actual_wa", checker: "C1", description: "C1: non-empty expected vs empty actual", expected: Buffer.from("hello"), actual: Buffer.from("") },
  { id: "c1_crlf_at_eof", checker: "C1", description: "C1: CRLF at EOF matches plain word", expected: Buffer.from("144\r\n"), actual: Buffer.from("144") },
  { id: "c1_lf_at_eof", checker: "C1", description: "C1: LF at EOF matches plain word", expected: Buffer.from("144\n"), actual: Buffer.from("144") },
  { id: "c1_cr_at_eof", checker: "C1", description: "C1: solitary CR at EOF matches plain word", expected: Buffer.from("144\r"), actual: Buffer.from("144") },
  { id: "c1_case_insensitive_ac", checker: "C1", description: "C1: case insensitive matching across words on line", expected: Buffer.from("Hello World"), actual: Buffer.from("hello world") },
  { id: "c1_trailing_blank_lines_ac", checker: "C1", description: "C1: trailing blank lines and spaces on actual output ignored", expected: Buffer.from("144"), actual: Buffer.from("144\r\n\r\n   \r\n") },
  { id: "c1_leading_blank_line_wa", checker: "C1", description: "C1: leading blank line on output alters line numbering -> WA at line 1", expected: Buffer.from("144"), actual: Buffer.from("\r\n144") },
  { id: "c1_middle_crcrlf_mismatch", checker: "C1", description: "C1: CRCRLF in middle creates empty line; a\\r\\r\\nb vs a\\r\\nb differs at line 2", expected: Buffer.from("a\r\r\nb"), actual: Buffer.from("a\r\nb") },
  { id: "c1_middle_crcrlf_match", checker: "C1", description: "C1: a\\r\\r\\nb vs a\\r\\n\\r\\nb matches as 3 lines with empty line 2", expected: Buffer.from("a\r\r\nb"), actual: Buffer.from("a\r\n\r\nb") },
  { id: "c1_extra_lines_wa", checker: "C1", description: "C1: actual output has extra line", expected: Buffer.from("144"), actual: Buffer.from("144\nextra") },
  { id: "c1_leading_spaces_ac", checker: "C1", description: "C1: leading spaces on line ignored", expected: Buffer.from("hello"), actual: Buffer.from("   hello") },
  { id: "c1_leading_tabs_ac", checker: "C1", description: "C1: leading tabs on line ignored", expected: Buffer.from("hello"), actual: Buffer.from("\t\thello") },
  { id: "c1_middle_spaces_ac", checker: "C1", description: "C1: multiple middle spaces match single space", expected: Buffer.from("a b"), actual: Buffer.from("a     b") },
  { id: "c1_middle_tabs_ac", checker: "C1", description: "C1: tabs between words match spaces", expected: Buffer.from("a b"), actual: Buffer.from("a\t\tb") },
  { id: "c1_trailing_spaces_tabs_ac", checker: "C1", description: "C1: trailing spaces and tabs on line ignored", expected: Buffer.from("hello"), actual: Buffer.from("hello \t  ") },
  { id: "c1_solitary_cr_middle_match", checker: "C1", description: "C1: solitary CR in middle separates lines", expected: Buffer.from("a\r\nb"), actual: Buffer.from("a\rb") },
  { id: "c1_solitary_lf_middle_match", checker: "C1", description: "C1: solitary LF in middle separates lines", expected: Buffer.from("a\r\nb"), actual: Buffer.from("a\nb") },
  { id: "c1_direction_reversal_extra_expected_line", checker: "C1", description: "C1: expected has extra line missing in actual", expected: Buffer.from("a\r\nb"), actual: Buffer.from("a") },
  { id: "c1_vt_treated_as_char_match", checker: "C1", description: "C1: vertical tab (0x0B) is not delimiter in Themis, treated as word char", expected: Buffer.from("a\x0Bb"), actual: Buffer.from("a\x0Bb") },
  { id: "c1_ff_treated_as_char_match", checker: "C1", description: "C1: form feed (0x0C) is not delimiter in Themis, treated as word char", expected: Buffer.from("a\x0Cb"), actual: Buffer.from("a\x0Cb") },
  { id: "c1_bom_treated_as_raw_bytes_match", checker: "C1", description: "C1: UTF-8 BOM treated as raw bytes", expected: Buffer.from("\xEF\xBB\xBFhello"), actual: Buffer.from("\xEF\xBB\xBFhello") },
  { id: "c1_non_ascii_bytes_match", checker: "C1", description: "C1: non-ASCII UTF-8 bytes match identically", expected: Buffer.from("tiếng việt"), actual: Buffer.from("tiếng việt") },
  { id: "c1_non_ascii_bytes_diff_wa", checker: "C1", description: "C1: non-ASCII byte difference produces WA", expected: Buffer.from("tiếng"), actual: Buffer.from("tiéng") },

  // --- C2: LinesWordsCase ---
  { id: "c2_empty_both_ac", checker: "C2", description: "C2: both files empty", expected: Buffer.from(""), actual: Buffer.from("") },
  { id: "c2_case_sensitive_wa", checker: "C2", description: "C2: case sensitive mismatch at line 1", expected: Buffer.from("Hello World"), actual: Buffer.from("hello world") },
  { id: "c2_case_sensitive_ac", checker: "C2", description: "C2: exact case match with extra whitespace on line", expected: Buffer.from("Hello World"), actual: Buffer.from("  \tHello   \tWorld  ") },
  { id: "c2_middle_crcrlf_match", checker: "C2", description: "C2: CRCRLF matches blank line with case sensitive text", expected: Buffer.from("Line1\r\r\nLine3"), actual: Buffer.from("Line1\r\n\r\nLine3") },
  { id: "c2_direction_reversal_extra_expected", checker: "C2", description: "C2: expected has extra line missing in actual", expected: Buffer.from("Line1\r\nLine2"), actual: Buffer.from("Line1") },
  { id: "c2_non_ascii_bytes_match", checker: "C2", description: "C2: non-ASCII Vietnamese text matches with exact case", expected: Buffer.from("Hà Nội"), actual: Buffer.from("Hà Nội") },

  // --- C3: WordsIgnoreCase ---
  { id: "c3_empty_both_ac", checker: "C3", description: "C3: both files empty", expected: Buffer.from(""), actual: Buffer.from("") },
  { id: "c3_empty_expected_wa", checker: "C3", description: "C3: empty expected vs word actual", expected: Buffer.from(""), actual: Buffer.from("word") },
  { id: "c3_empty_actual_wa", checker: "C3", description: "C3: word expected vs empty actual", expected: Buffer.from("word"), actual: Buffer.from("") },
  { id: "c3_words_across_lines_ac", checker: "C3", description: "C3: words across different line structures with case insensitivity", expected: Buffer.from("hello\r\nworld"), actual: Buffer.from("HELLO world") },
  { id: "c3_word_mismatch_first", checker: "C3", description: "C3: word mismatch reported at first differing word even if count differs", expected: Buffer.from("a b c"), actual: Buffer.from("a x c d") },
  { id: "c3_word_count_difference", checker: "C3", description: "C3: prefix matches but word count differs (actual longer)", expected: Buffer.from("a b"), actual: Buffer.from("a b c") },
  { id: "c3_direction_reversal_expected_longer", checker: "C3", description: "C3: prefix matches but word count differs (expected longer)", expected: Buffer.from("a b c"), actual: Buffer.from("a b") },
  { id: "c3_multiple_whitespace_types_ac", checker: "C3", description: "C3: multiple mixed whitespace types across lines", expected: Buffer.from("Alpha Beta Gamma"), actual: Buffer.from("  alpha\t\r\n  beta\r\n\r  gamma  ") },
  { id: "c3_vt_as_word_char", checker: "C3", description: "C3: VT (0x0B) is part of word, matches case-folded", expected: Buffer.from("a\x0Bb"), actual: Buffer.from("A\x0Bb") },

  // --- C4: WordsCase ---
  { id: "c4_empty_both_ac", checker: "C4", description: "C4: both files empty", expected: Buffer.from(""), actual: Buffer.from("") },
  { id: "c4_empty_expected_wa", checker: "C4", description: "C4: empty expected vs word actual", expected: Buffer.from(""), actual: Buffer.from("word") },
  { id: "c4_empty_actual_wa", checker: "C4", description: "C4: word expected vs empty actual", expected: Buffer.from("word"), actual: Buffer.from("") },
  { id: "c4_case_sensitive_wa", checker: "C4", description: "C4: case sensitive word mismatch", expected: Buffer.from("hello world"), actual: Buffer.from("HELLO world") },
  { id: "c4_case_sensitive_ac", checker: "C4", description: "C4: exact case words across different lines", expected: Buffer.from("Hello\r\nworld"), actual: Buffer.from("Hello\tworld") },
  { id: "c4_direction_reversal_expected_longer", checker: "C4", description: "C4: prefix matches but expected has extra word", expected: Buffer.from("Alpha Beta Gamma"), actual: Buffer.from("Alpha Beta") },
  { id: "c4_multiple_whitespace_types_ac", checker: "C4", description: "C4: multiple whitespace types with exact case", expected: Buffer.from("Alpha Beta Gamma"), actual: Buffer.from("\tAlpha\r\n\r\n  Beta \r  Gamma\n") },

  // --- C5: Binary ---
  { id: "c5_empty_both_ac", checker: "C5", description: "C5: binary comparison of two empty files (0 bytes)", expected: Buffer.from(""), actual: Buffer.from("") },
  { id: "c5_identical_bytes_ac", checker: "C5", description: "C5: binary comparison of raw bytes including nulls and high bytes", expected: Buffer.from([0x00, 0x0d, 0x0a, 0xff]), actual: Buffer.from([0x00, 0x0d, 0x0a, 0xff]) },
  { id: "c5_first_byte_mismatch_wa", checker: "C5", description: "C5: mismatch at byte 1", expected: Buffer.from([0xff, 0x01, 0x02]), actual: Buffer.from([0x00, 0x01, 0x02]) },
  { id: "c5_mid_byte_mismatch_wa", checker: "C5", description: "C5: mismatch at byte 2", expected: Buffer.from([0x01, 0xaa, 0x03]), actual: Buffer.from([0x01, 0xbb, 0x03]) },
  { id: "c5_last_byte_mismatch_wa", checker: "C5", description: "C5: mismatch at byte 3", expected: Buffer.from([0x01, 0x02, 0xfe]), actual: Buffer.from([0x01, 0x02, 0xff]) },
  { id: "c5_byte_mismatch_wa", checker: "C5", description: "C5: mismatch at byte 2 with previews", expected: Buffer.from([0x00, 0x01, 0x02, 0x03]), actual: Buffer.from([0x00, 0x09, 0x02, 0x03]) },
  { id: "c5_length_mismatch_wa", checker: "C5", description: "C5: different file length when common prefix identical (actual longer)", expected: Buffer.from([0x00, 0x01]), actual: Buffer.from([0x00, 0x01, 0x02]) },
  { id: "c5_length_mismatch_expected_longer_wa", checker: "C5", description: "C5: different file length when common prefix identical (expected longer)", expected: Buffer.from([0x01, 0x02, 0x03, 0x04]), actual: Buffer.from([0x01, 0x02]) },
  { id: "c5_length_mismatch_actual_longer_wa", checker: "C5", description: "C5: different file length when common prefix identical (actual longer by 2)", expected: Buffer.from([0x01, 0x02]), actual: Buffer.from([0x01, 0x02, 0x03, 0x04]) },
  { id: "c5_nul_and_high_bytes_ac", checker: "C5", description: "C5: binary match with NUL and high bytes (0x00, 0xFF, 0x80, 0x7F)", expected: Buffer.from([0x00, 0x00, 0xff, 0xff, 0x80, 0x7f]), actual: Buffer.from([0x00, 0x00, 0xff, 0xff, 0x80, 0x7f]) },
];

const CHECKER_DLLS: Record<string, string> = {
  C1: "C1LinesWordsIgnoreCase.dll",
  C2: "C2LinesWordsCase.dll",
  C3: "C3WordsIgnoreCase.dll",
  C4: "C4WordsCase.dll",
  C5: "C5Binary.dll",
};

const DLL_HASHES: Record<string, string> = {
  C1: "96145B8E1E74B32D8ED995439871FB771FA0FEFBAF502AF6217E53918F3FCB12",
  C2: "94AAFCDABC491ED85FDF0485D74B7F44609317B158BCEC813A65337C7DC0AA7F",
  C3: "4E2EA751CB78BE300FF00CDEA329C2F2A36D064C7E56AA55B6B4D0D7EB598F94",
  C4: "1A5545B42C01C894F60F8C6517986580368A92B6868A1CE2D76FDDDFC9F95BE8",
  C5: "DC463A5786B379450D2E68BF9C4F758C44E94FBCAEC4CD27595C8E76AA26689A",
};

const C5_BLOCKER_EXPLANATION =
  "Delphi off-by-one loop bug in C5Binary.dll: The binary comparison loop is compiled from 'for i := 0 to FileSize do', which executes FileSize + 1 times in Pascal. On the (FileSize + 1)-th iteration, it reads past EOF, raising STATUS_ACCESS_VIOLATION at address 0x00000000. Delphi catches the exception and returns score 0.0000 with 'Kết quả KHÁC đáp án!'. 0-byte files fail CreateFileMappingW with Win32 error 1006. Hence original C5Binary.dll cannot return AC.";

function main() {
  console.log("=== Generating and Validating Expanded Themis C1-C5 Corpus ===");

  const harnessExe = path.join(projectRoot, "tools", "themis-oracle", "themis_oracle_harness.exe");
  const themisJudgersDir = "C:\\Themis\\~judgers";
  const hasOracle = fs.existsSync(harnessExe) && fs.existsSync(themisJudgersDir);
  console.log(`[oracle] Oracle available: ${hasOracle}`);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-corpus-gen-"));
  const workDir = path.join(tempRoot, "work");
  const ansDir = path.join(tempRoot, "ans");
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(ansDir, { recursive: true });

  const corpusFixtures: any[] = [];
  const oracleResults: any[] = [];

  try {
    for (const f of FIXTURES) {
      // 1. Run JudgeDesk Node checker
      const nodeRes = runStandardChecker(f.checker, f.expected, f.actual);

      // 2. Run Oracle harness if available
      let oracleRawScore: number | null = null;
      let oracleRawComment: string | null = null;
      let oracleVerdict: "AC" | "WA" | "BLOCKED" = "BLOCKED";
      let oracleBlocker: string | null = null;

      if (hasOracle) {
        if (f.checker === "C5") {
          // Document exact Delphi blocker for C5
          oracleBlocker = C5_BLOCKER_EXPLANATION;
          oracleVerdict = "BLOCKED";
        } else {
          const dllPath = path.join(themisJudgersDir, CHECKER_DLLS[f.checker]);
          const testFile = "TEST.OUT";
          fs.writeFileSync(path.join(workDir, testFile), f.actual);
          fs.writeFileSync(path.join(ansDir, testFile), f.expected);

          const run = spawnSync(harnessExe, [dllPath, workDir, ansDir, testFile, "PROB"], {
            encoding: "utf8",
          });

          const stdout = run.stdout || "";
          for (const line of stdout.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.startsWith("SCORE:")) {
              oracleRawScore = parseFloat(trimmed.slice(6).trim());
            } else if (trimmed.startsWith("COMMENT:")) {
              oracleRawComment = trimmed.slice(8).trim();
            } else if (trimmed.startsWith("VERDICT:")) {
              oracleVerdict = trimmed.slice(8).trim() as "AC" | "WA";
            }
          }

          // Verify Oracle verdict matches JudgeDesk semantic verdict
          assert.equal(
            oracleVerdict,
            nodeRes.status,
            `[${f.id}] Themis Oracle verdict mismatch: Oracle=${oracleVerdict}, JudgeDesk=${nodeRes.status}`,
          );
        }
      }

      const fixtureRecord = {
        id: f.id,
        checker: f.checker,
        description: f.description,
        expectedBase64: f.expected.toString("base64"),
        actualBase64: f.actual.toString("base64"),
        expectedVerdict: nodeRes.status,
        expectedMessage: nodeRes.message,
        themisOracle: {
          verdict: oracleVerdict,
          rawScore: oracleRawScore,
          rawComment: oracleRawComment,
          blocker: oracleBlocker,
        },
      };

      corpusFixtures.push(fixtureRecord);

      oracleResults.push({
        id: f.id,
        checker: f.checker,
        fixtureInputBytes: {
          expectedBase64: f.expected.toString("base64"),
          actualBase64: f.actual.toString("base64"),
        },
        themisOracle: {
          dll: CHECKER_DLLS[f.checker],
          dllSha256: DLL_HASHES[f.checker],
          invoked: hasOracle && f.checker !== "C5",
          rawScore: oracleRawScore,
          rawComment: oracleRawComment,
          verdict: oracleVerdict,
          blocker: oracleBlocker,
        },
        judgedesk: {
          verdict: nodeRes.status,
          message: nodeRes.message,
        },
      });

      console.log(
        `  [${f.checker}] ${f.id.padEnd(42)} -> ${nodeRes.status.padEnd(3)} | ${nodeRes.message} (Oracle: ${oracleVerdict})`,
      );
    }

    // Write corpus
    const corpusPayload = {
      version: "2.0.0",
      description: "Hardened Themis C1-C5 Test Corpus with bound Oracle evidence",
      fixturesCount: corpusFixtures.length,
      fixtures: corpusFixtures,
    };
    const corpusPath = path.join(projectRoot, "judgers", "fixtures", "themis-c1-c5-corpus.json");
    fs.writeFileSync(corpusPath, JSON.stringify(corpusPayload, null, 2) + "\n");
    console.log(`\n✔ Wrote expanded corpus (${corpusFixtures.length} fixtures) to: ${corpusPath}`);

    // Write Oracle result artifact
    const oraclePayload = {
      manifestVersion: "1.0.0",
      timestamp: new Date().toISOString(),
      platform: "win32-x86",
      dllHashes: DLL_HASHES,
      harnessBuild: {
        compiler: "gcc (MinGW.org GCC-9.2.0-1) 9.2.0",
        flags: "-O2 -mconsole -lshell32",
        source: "tools/themis-oracle/themis_oracle_harness.c",
      },
      c5BlockerExplanation: C5_BLOCKER_EXPLANATION,
      totalFixtures: oracleResults.length,
      validatedC1toC4Fixtures: oracleResults.filter((r) => r.themisOracle.invoked).length,
      blockedC5Fixtures: oracleResults.filter((r) => r.checker === "C5").length,
      results: oracleResults,
    };
    const oracleResultPath = path.join(projectRoot, "judgers", "fixtures", "themis-oracle-results.json");
    fs.writeFileSync(oracleResultPath, JSON.stringify(oraclePayload, null, 2) + "\n");
    console.log(`✔ Wrote machine-readable Oracle results to: ${oracleResultPath}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main();
