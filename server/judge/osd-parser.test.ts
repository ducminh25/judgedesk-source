import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseOsdFileName, sanitizeContestantName } from "./osd-parser.js";

describe("osd-parser", () => {
  const validProblems = ["SUM", "GCD", "BAI1", "PALIND"];

  describe("valid Themis file formats", () => {
    it("accepts the dotless names written by themis-web-interface", () => {
      for (const [extension, language] of [
        ["cpp", "cpp"], ["pas", "pascal"], ["py", "python"], ["java", "java"],
      ]) {
        const parsed = parseOsdFileName(`0[HS01][SUM]${extension}`, validProblems);
        assert.equal(parsed.valid, true, parsed.errorReason);
        assert.equal(parsed.contestant, "HS01");
        assert.equal(parsed.problem, "SUM");
        assert.equal(parsed.extension, extension);
        assert.equal(parsed.language, language);
      }
    });

    it("preserves safe Unicode identities in legacy submissions", () => {
      const parsed = parseOsdFileName("0[ThíSinh01][sum]CPP", validProblems);
      assert.equal(parsed.valid, true, parsed.errorReason);
      assert.equal(parsed.contestant, "ThíSinh01");
      assert.equal(parsed.problem, "SUM");
      assert.equal(parsed.extension, "cpp");
    });
    it("parses simple [Contestant][Problem].cpp", () => {
      const parsed = parseOsdFileName("[HS01][SUM].cpp", validProblems);
      assert.equal(parsed.valid, true);
      assert.equal(parsed.contestant, "HS01");
      assert.equal(parsed.problem, "SUM");
      assert.equal(parsed.extension, "cpp");
      assert.equal(parsed.language, "cpp");
    });

    it("parses file with prefix (e.g. timestamp or client prefix)", () => {
      const parsed = parseOsdFileName("20260821_143000[LeVanA][BAI1].py", validProblems);
      assert.equal(parsed.valid, true);
      assert.equal(parsed.contestant, "LeVanA");
      assert.equal(parsed.problem, "BAI1");
      assert.equal(parsed.language, "python");
    });

    it("parses Pascal submission and resolves case-insensitive problem name", () => {
      const parsed = parseOsdFileName("001[Mon][gcd].pas", validProblems);
      assert.equal(parsed.valid, true);
      assert.equal(parsed.contestant, "Mon");
      assert.equal(parsed.problem, "GCD");
      assert.equal(parsed.language, "pascal");
    });

    it("parses C submission", () => {
      const parsed = parseOsdFileName("[Test1234][palind].c", validProblems);
      assert.equal(parsed.valid, true);
      assert.equal(parsed.contestant, "Test1234");
      assert.equal(parsed.problem, "PALIND");
      assert.equal(parsed.language, "c");
    });
  });

  describe("invalid file formats and rejections", () => {
    it("does not remap hostile identities or accept path-shaped file names", () => {
      for (const name of [
        "0[../HS01][SUM]cpp", "0[HS01][../SUM]cpp",
        "../0[HS01][SUM]cpp", "0[HS01][SUM]cpp\n",
        "0[HS01 ][SUM]cpp", "0[CON][SUM]cpp", "0[HS01][SUM:stream]cpp",
        "0[../HS01][SUM].cpp", "0[HS01][../SUM].cpp",
        "../0[HS01][SUM].cpp", "0[HS01][SUM].cpp\n",
        "0[HS01 ][SUM].cpp", "0[CON][SUM].cpp", "0[HS01][SUM:stream].cpp",
      ]) {
        assert.equal(parseOsdFileName(name, validProblems).valid, false, name);
      }
    });

    it("rejects dotless executable and compound suffixes", () => {
      for (const name of ["0[HS01][SUM]exe", "0[HS01][SUM]cpp.exe", "0[HS01][SUM]cpp.tmp"]) {
        assert.equal(parseOsdFileName(name, validProblems).valid, false, name);
      }
    });
    it("rejects non-standard filenames", () => {
      const parsed1 = parseOsdFileName("SUM.cpp", validProblems);
      assert.equal(parsed1.valid, false);

      const parsed2 = parseOsdFileName("[HS01].cpp", validProblems);
      assert.equal(parsed2.valid, false);

      const parsed3 = parseOsdFileName("HS01_SUM.cpp", validProblems);
      assert.equal(parsed3.valid, false);
    });

    it("rejects unsupported extensions such as .zip or .exe", () => {
      const parsedZip = parseOsdFileName("[HS01][SUM].zip", validProblems);
      assert.equal(parsedZip.valid, false);
      assert.match(parsedZip.errorReason || "", /UNSUPPORTED_LANGUAGE/);

      const parsedExe = parseOsdFileName("[HS01][SUM].exe", validProblems);
      assert.equal(parsedExe.valid, false);
      assert.match(parsedExe.errorReason || "", /UNSUPPORTED_LANGUAGE/);
    });

    it("rejects problem not in active contest", () => {
      const parsed = parseOsdFileName("[HS01][UNKNOWN_PROB].cpp", validProblems);
      assert.equal(parsed.valid, false);
      assert.match(parsed.errorReason || "", /PROBLEM_NOT_FOUND/);
    });

    it("keeps sanitization helpers but rejects identities that would be remapped", () => {
      assert.equal(sanitizeContestantName("../../evil"), "evil");
      assert.equal(sanitizeContestantName("student/../../name"), "student_name");
      const parsed = parseOsdFileName("[../../hacker][SUM].cpp", validProblems);
      // OSD identities must be rejected, not silently mapped onto another account.
      assert.equal(parsed.valid, false);
      assert.match(parsed.errorReason || "", /INVALID_CONTESTANT_NAME/);
    });

    it("rejects contestant name containing only invalid characters", () => {
      const parsed = parseOsdFileName("[.../.../][SUM].cpp", validProblems);
      assert.equal(parsed.valid, false);
      assert.match(parsed.errorReason || "", /INVALID_CONTESTANT_NAME/);
    });
  });
});
