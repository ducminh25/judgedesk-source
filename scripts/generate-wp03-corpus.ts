import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { listRegisteredLanguageProfiles } from "../server/languages/registry.js";
import { isCurrentReleaseToolchainKind } from "../server/toolchains/release-scope.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpusRoot = process.env.CORPUS_ROOT_OVERRIDE
  ? path.resolve(process.env.CORPUS_ROOT_OVERRIDE)
  : path.join(repoRoot, "server", "test-fixtures", "corpus");
const staticDir = path.join(corpusRoot, "static");
const generatedDir = path.join(corpusRoot, "generated");
const manifestPath = process.env.CORPUS_MANIFEST_OVERRIDE
  ? path.resolve(process.env.CORPUS_MANIFEST_OVERRIDE)
  : path.join(repoRoot, "docs", "verification", "pure-rust-core", "corpus-manifest.json");
const EMPTY_DIRECTORY_MARKER = ".judgedesk-empty";

// Derive production release profile-to-extension mappings
const RELEASE_PROFILE_EXTENSIONS = new Map<string, Set<string>>();
for (const reg of listRegisteredLanguageProfiles()) {
  if (isCurrentReleaseToolchainKind(reg.toolchainKind)) {
    const exts = new Set<string>();
    for (const ext of reg.profile.extensions) {
      exts.add(ext.replace(/^\./, "").toLowerCase());
    }
    RELEASE_PROFILE_EXTENSIONS.set(reg.profile.ref.id, exts);
  }
}

if (!process.argv.includes("--check")) {
  fs.mkdirSync(staticDir, { recursive: true });
  fs.mkdirSync(generatedDir, { recursive: true });
}

function sha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex").toLowerCase();
}

function createStoredZip(filename: string, contentBuf: Buffer): Buffer {
  const nameBuf = Buffer.from(filename, "utf8");
  const crc = zlib.crc32(contentBuf);
  const size = contentBuf.length;

  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(10, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8); // Store
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0x0021, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(size, 18);
  local.writeUInt32LE(size, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  nameBuf.copy(local, 30);

  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x031e, 4);
  central.writeUInt16LE(10, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0x0021, 12);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(size, 20);
  central.writeUInt32LE(size, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42); // offset
  nameBuf.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + contentBuf.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([local, contentBuf, central, eocd]);
}

interface FileEntry {
  path: string;
  role: string;
  size?: number;
  sha256?: string;
  expectedAbsence?: boolean;
  emptyDirectory?: boolean;
}

interface ScoreDescriptor {
  numerator: string;
  denominator: string;
  display: number;
}

interface TestCaseResult {
  name: string;
  verdict: string;
  checkerMessage: string | null;
  score: ScoreDescriptor;
}

interface GroupEffect {
  groupId: string;
  resolvedVerdict: string;
  dependenciesMet: boolean;
  score: ScoreDescriptor;
}

interface CorpusCase {
  id: string;
  tags: string[];
  languageProfileId: string;
  extension: string;
  platforms: string[];
  ioMode: string;
  fixtureRoot: string;
  expectedCompileOutcome: string;
  expectedProblemVerdict: string;
  expectedMaxScore: ScoreDescriptor;
  expectedScore: ScoreDescriptor;
  provenance: string;
  tests: TestCaseResult[];
  files: FileEntry[];
  groupEffects?: GroupEffect[];
}

const cases: CorpusCase[] = [];

function write(dir: string, file: string, content: string | Buffer): void {
  if (process.argv.includes("--check")) return;
  const full = path.join(dir, file);
  const parent = path.dirname(full);
  fs.mkdirSync(parent, { recursive: true });
  const tmp = path.join(parent, `.${path.basename(full)}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, full);
}

function addCase(c: CorpusCase, builder: (dir: string) => void): void {
  // Validate release profile and extension binding
  if (!RELEASE_PROFILE_EXTENSIONS.has(c.languageProfileId)) {
    throw new Error(`Profile ${c.languageProfileId} is not an active release toolchain profile`);
  }
  const allowedExts = RELEASE_PROFILE_EXTENSIONS.get(c.languageProfileId);
  if (!allowedExts) {
    throw new Error(`Allowed extensions not found for profile ${c.languageProfileId}`);
  }
  const normalizedExt = c.extension.replace(/^\./, "").toLowerCase();
  if (!allowedExts.has(normalizedExt)) {
    throw new Error(`Profile ${c.languageProfileId} does not support extension .${normalizedExt} (allowed: ${Array.from(allowedExts).join(", ")})`);
  }

  const dir = path.join(corpusRoot, c.fixtureRoot);
  if (!process.argv.includes("--check")) {
    fs.mkdirSync(dir, { recursive: true });
    builder(dir);
  } else {
    if (!fs.existsSync(dir)) {
      throw new Error(`[Check] Missing directory: ${dir}`);
    }
  }

  for (const f of c.files) {
    if (f.expectedAbsence) {
      continue;
    }
    const filePath = path.join(dir, f.path);
    if (f.emptyDirectory) {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isDirectory()) {
        throw new Error(`Missing declared empty testcase directory: ${filePath}`);
      }
      const entries = fs.readdirSync(filePath);
      if (entries.length !== 1 || entries[0] !== EMPTY_DIRECTORY_MARKER) {
        throw new Error(`Declared empty testcase directory has unexpected entries: ${filePath}`);
      }
      continue;
    }
    if (!fs.existsSync(filePath)) {
      if (!process.argv.includes("--check")) {
        throw new Error(`Missing expected file during generation: ${filePath}`);
      }
    } else {
      const buf = fs.readFileSync(filePath);
      f.size = buf.length;
      f.sha256 = sha256(buf);
    }
  }

  c.files.sort((a, b) => a.path.localeCompare(b.path));
  cases.push(c);
}

// 1. C++ AC Stdio
addCase({
  id: "cpp_ac_stdio",
  tags: ["cpp", "ac", "stdio"],
  languageProfileId: "cpp-legacy-v1",
  extension: "cpp",
  platforms: ["all"],
  ioMode: "stdio",
  fixtureRoot: "static/cpp_ac_stdio",
  expectedCompileOutcome: "SUCCESS",
  expectedProblemVerdict: "AC",
  expectedMaxScore: { numerator: "1", denominator: "1", display: 1 },
  expectedScore: { numerator: "1", denominator: "1", display: 1 },
  provenance: "Node standard stdio check.",
  tests: [
    { name: "01", verdict: "AC", checkerMessage: "single line", score: { numerator: "1", denominator: "1", display: 1 } }
  ],
  files: [
    { path: "Config.cfg", role: "config" },
    { path: "solution.cpp", role: "source" },
    { path: "tests/01.in", role: "input" },
    { path: "tests/01.out", role: "answer" }
  ]
}, (dir) => {
  write(dir, "Config.cfg", JSON.stringify({ useStdIO: true }));
  write(dir, "solution.cpp", "#include <iostream>\nusing namespace std;\nint main() { int a; cin >> a; cout << a; return 0; }\n");
  write(dir, "tests/01.in", "42\n");
  write(dir, "tests/01.out", "42\n");
});

// 2. C WA File
addCase({
  id: "c_wa_file",
  tags: ["c", "wa", "file"],
  languageProfileId: "c-gcc14",
  extension: "c",
  platforms: ["all"],
  ioMode: "file",
  fixtureRoot: "static/c_wa_file",
  expectedCompileOutcome: "SUCCESS",
  expectedProblemVerdict: "WA",
  expectedMaxScore: { numerator: "1", denominator: "1", display: 1 },
  expectedScore: { numerator: "0", denominator: "1", display: 0 },
  provenance: "Node standard file check.",
  tests: [
    { name: "01", verdict: "WA", checkerMessage: "Wrong answer at line 1", score: { numerator: "0", denominator: "1", display: 0 } }
  ],
  files: [
    { path: "Config.cfg", role: "config" },
    { path: "solution.c", role: "source" },
    { path: "tests/01.in", role: "input" },
    { path: "tests/01.out", role: "answer" }
  ]
}, (dir) => {
  write(dir, "Config.cfg", JSON.stringify({ useStdIO: false, inputFile: "input.txt", outputFile: "output.txt" }));
  write(dir, "solution.c", "#include <stdio.h>\nint main() { FILE *fin = fopen(\"input.txt\", \"r\"); FILE *fout = fopen(\"output.txt\", \"w\"); int a; fscanf(fin, \"%d\", &a); fprintf(fout, \"%d\", a + 1); return 0; }\n");
  write(dir, "tests/01.in", "42\n");
  write(dir, "tests/01.out", "42\n");
});

// 3. Python TLE Stdio
addCase({
  id: "python_tle_stdio",
  tags: ["python", "tle", "stdio"],
  languageProfileId: "python-cpython312",
  extension: "py",
  platforms: ["all"],
  ioMode: "stdio",
  fixtureRoot: "static/python_tle_stdio",
  expectedCompileOutcome: "SUCCESS",
  expectedProblemVerdict: "TLE",
  expectedMaxScore: { numerator: "1", denominator: "1", display: 1 },
  expectedScore: { numerator: "0", denominator: "1", display: 0 },
  provenance: "Node time limit exceeded.",
  tests: [
    { name: "01", verdict: "TLE", checkerMessage: null, score: { numerator: "0", denominator: "1", display: 0 } }
  ],
  files: [
    { path: "Config.cfg", role: "config" },
    { path: "solution.py", role: "source" },
    { path: "tests/01.in", role: "input" },
    { path: "tests/01.out", role: "answer" }
  ]
}, (dir) => {
  write(dir, "Config.cfg", JSON.stringify({ useStdIO: true }));
  write(dir, "solution.py", "while True: pass\n");
  write(dir, "tests/01.in", "42\n");
  write(dir, "tests/01.out", "42\n");
});

// 4. Pascal PE File
addCase({
  id: "pascal_pe_file",
  tags: ["pascal", "pe", "file"],
  languageProfileId: "pascal-fpc322",
  extension: "pas",
  platforms: ["all"],
  ioMode: "file",
  fixtureRoot: "static/pascal_pe_file",
  expectedCompileOutcome: "SUCCESS",
  expectedProblemVerdict: "PE",
  expectedMaxScore: { numerator: "1", denominator: "1", display: 1 },
  expectedScore: { numerator: "0", denominator: "1", display: 0 },
  provenance: "Node presentation error via yesno checker expecting exact format.",
  tests: [
    { name: "01", verdict: "PE", checkerMessage: "YES or NO expected, but MAYBE found", score: { numerator: "0", denominator: "1", display: 0 } }
  ],
  files: [
    { path: "Config.cfg", role: "config" },
    { path: "solution.pas", role: "source" },
    { path: "tests/01.in", role: "input" },
    { path: "tests/01.out", role: "answer" }
  ]
}, (dir) => {
  write(dir, "Config.cfg", JSON.stringify({ useStdIO: false, inputFile: "in.txt", outputFile: "out.txt", checkerType: "polygon:yesno" }));
  write(dir, "solution.pas", "var a: integer; fin, fout: text; begin assign(fin, 'in.txt'); reset(fin); read(fin, a); assign(fout, 'out.txt'); rewrite(fout); write(fout, 'maybe'); close(fin); close(fout); end.");
  write(dir, "tests/01.in", "42\n");
  write(dir, "tests/01.out", "YES\n");
});

// 5. Java RE Stdio
addCase({
  id: "java_re_stdio",
  tags: ["java", "re", "stdio"],
  languageProfileId: "java-temurin21",
  extension: "java",
  platforms: ["all"],
  ioMode: "stdio",
  fixtureRoot: "static/java_re_stdio",
  expectedCompileOutcome: "SUCCESS",
  expectedProblemVerdict: "RE",
  expectedMaxScore: { numerator: "1", denominator: "1", display: 1 },
  expectedScore: { numerator: "0", denominator: "1", display: 0 },
  provenance: "Node runtime error.",
  tests: [
    { name: "01", verdict: "RE", checkerMessage: null, score: { numerator: "0", denominator: "1", display: 0 } }
  ],
  files: [
    { path: "Config.cfg", role: "config" },
    { path: "Main.java", role: "source" },
    { path: "tests/01.in", role: "input" },
    { path: "tests/01.out", role: "answer" }
  ]
}, (dir) => {
  write(dir, "Config.cfg", JSON.stringify({ useStdIO: true }));
  write(dir, "Main.java", "public class Main { public static void main(String[] args) { System.exit(1); } }\n");
  write(dir, "tests/01.in", "42\n");
  write(dir, "tests/01.out", "42\n");
});

// 6. Scratch AC
addCase({
  id: "scratch_ac",
  tags: ["scratch", "ac"],
  languageProfileId: "scratch-turbowarp-v1",
  extension: "sb3",
  platforms: ["all"],
  ioMode: "stdio",
  fixtureRoot: "static/scratch_ac",
  expectedCompileOutcome: "SUCCESS",
  expectedProblemVerdict: "AC",
  expectedMaxScore: { numerator: "1", denominator: "1", display: 1 },
  expectedScore: { numerator: "1", denominator: "1", display: 1 },
  provenance: "Node Scratch valid ZIP project.",
  tests: [
    { name: "01", verdict: "AC", checkerMessage: "single line", score: { numerator: "1", denominator: "1", display: 1 } }
  ],
  files: [
    { path: "Config.cfg", role: "config" },
    { path: "project.sb3", role: "source" },
    { path: "tests/01.in", role: "input" },
    { path: "tests/01.out", role: "answer" }
  ]
}, (dir) => {
  const sb3Json = JSON.stringify({
    targets: [
      {
        isStage: true,
        name: "Stage",
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        comments: {},
        currentCostume: 0,
        costumes: [
          {
            name: "backdrop1",
            dataFormat: "svg",
            assetId: "cd21514d0531fdffb22204e0ec5ed84a",
            md5ext: "cd21514d0531fdffb22204e0ec5ed84a.svg",
            rotationCenterX: 240,
            rotationCenterY: 180
          }
        ],
        sounds: [],
        volume: 100,
        layerOrder: 0
      },
      {
        isStage: false,
        name: "Sprite1",
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {
          start: {
            opcode: "event_whenflagclicked",
            next: "ask",
            parent: null,
            inputs: {},
            fields: {},
            shadow: false,
            topLevel: true
          },
          ask: {
            opcode: "sensing_askandwait",
            next: "say",
            parent: "start",
            inputs: {
              QUESTION: [1, [10, ""]]
            },
            fields: {},
            shadow: false,
            topLevel: false
          },
          say: {
            opcode: "looks_say",
            next: null,
            parent: "ask",
            inputs: {
              MESSAGE: [3, "ans", [10, ""]]
            },
            fields: {},
            shadow: false,
            topLevel: false
          },
          ans: {
            opcode: "sensing_answer",
            next: null,
            parent: "say",
            inputs: {},
            fields: {},
            shadow: false,
            topLevel: false
          }
        },
        comments: {},
        currentCostume: 0,
        costumes: [
          {
            name: "costume1",
            dataFormat: "svg",
            assetId: "bcf454acf82e4504149f7ffe07081dbc",
            md5ext: "bcf454acf82e4504149f7ffe07081dbc.svg",
            rotationCenterX: 48,
            rotationCenterY: 50
          }
        ],
        sounds: [],
        volume: 100,
        layerOrder: 1,
        visible: true,
        x: 0,
        y: 0,
        size: 100,
        direction: 90,
        draggable: false,
        rotationStyle: "all around"
      }
    ],
    monitors: [],
    extensions: [],
    meta: {
      semver: "3.0.0",
      vm: "0.2.0",
      agent: ""
    }
  });
  write(dir, "Config.cfg", JSON.stringify({ useStdIO: true }));
  write(dir, "project.sb3", createStoredZip("project.json", Buffer.from(sb3Json, "utf8")));
  write(dir, "tests/01.in", "42\n");
  write(dir, "tests/01.out", "42\n");
});

// 7. C++ CE
addCase({
  id: "cpp_ce",
  tags: ["cpp", "ce"],
  languageProfileId: "cpp-legacy-v1",
  extension: "cpp",
  platforms: ["all"],
  ioMode: "stdio",
  fixtureRoot: "static/cpp_ce",
  expectedCompileOutcome: "CE",
  expectedProblemVerdict: "CE",
  expectedMaxScore: { numerator: "0", denominator: "1", display: 0 },
  expectedScore: { numerator: "0", denominator: "1", display: 0 },
  provenance: "Node compile error.",
  tests: [],
  files: [
    { path: "Config.cfg", role: "config" },
    { path: "solution.cpp", role: "source" }
  ]
}, (dir) => {
  write(dir, "Config.cfg", JSON.stringify({ useStdIO: true }));
  write(dir, "solution.cpp", "invalid cpp code\n");
});

// 8. Python Custom Checker Testlib Partial
addCase({
  id: "python_custom_checker",
  tags: ["python", "custom_checker", "partial", "groups", "testlib"],
  languageProfileId: "python-cpython312",
  extension: "py",
  platforms: ["all"],
  ioMode: "stdio",
  fixtureRoot: "static/python_custom_checker",
  expectedCompileOutcome: "SUCCESS",
  expectedProblemVerdict: "PARTIAL",
  expectedMaxScore: { numerator: "100", denominator: "1", display: 100 },
  expectedScore: { numerator: "50", denominator: "1", display: 50 },
  provenance: "Node custom checker with partial score via testlib format (exit 7). Stored configuration declares root Polygon fields.",
  tests: [
    { name: "01", verdict: "PARTIAL", checkerMessage: "points 0.5", score: { numerator: "50", denominator: "1", display: 50 } }
  ],
  groupEffects: [
    { groupId: "0", dependenciesMet: true, resolvedVerdict: "PARTIAL", score: { numerator: "50", denominator: "1", display: 50 } }
  ],
  files: [
    { path: "Config.cfg", role: "config" },
    { path: "solution.py", role: "source" },
    { path: "check.cpp", role: "checker" },
    { path: "tests/01.in", role: "input" },
    { path: "tests/01.out", role: "answer" }
  ]
}, (dir) => {
  write(dir, "solution.py", "print(42)\n");
  write(dir, "check.cpp", "#include <iostream>\nint main() { std::cout << \"points 0.5\\n\"; return 7; }\n");
  write(dir, "Config.cfg", JSON.stringify({
    useStdIO: true,
    checkerType: "check.cpp",
    defaultScore: 100,
    enableGroups: true,
    groups: { "0": { policy: "EACH_TEST" } },
    tests: { "01": { group: "0", points: 100 } }
  }));
  write(dir, "tests/01.in", "42\n");
  write(dir, "tests/01.out", "42\n");
});

// 9. Interactive AC (C++)
addCase({
  id: "cpp_interactor",
  tags: ["cpp", "ac", "interactor"],
  languageProfileId: "cpp-legacy-v1",
  extension: "cpp",
  platforms: ["all"],
  ioMode: "stdio",
  fixtureRoot: "static/cpp_interactor",
  expectedCompileOutcome: "SUCCESS",
  expectedProblemVerdict: "AC",
  expectedMaxScore: { numerator: "1", denominator: "1", display: 1 },
  expectedScore: { numerator: "1", denominator: "1", display: 1 },
  provenance: "Node interactive testcase protocol via dual-pipe interactor.",
  tests: [
    { name: "01", verdict: "AC", checkerMessage: "ok", score: { numerator: "1", denominator: "1", display: 1 } }
  ],
  files: [
    { path: "Config.cfg", role: "config" },
    { path: "solution.cpp", role: "source" },
    { path: "interactor.cpp", role: "interactor" },
    { path: "tests/01.in", role: "input" },
    { path: "tests/01.out", role: "answer", expectedAbsence: true }
  ]
}, (dir) => {
  write(dir, "solution.cpp", "#include <iostream>\nint main() { int x; std::cin >> x; std::cout << x * 2 << std::endl; return 0; }\n");
  write(dir, "interactor.cpp", "#include <iostream>\n#include <fstream>\nint main(int argc, char** argv) { std::ifstream fin(argv[1]); int x; fin >> x; std::cout << x << std::endl; int y; std::cin >> y; if (y == x * 2) { std::cerr << \"ok\\n\"; return 0; } return 1; }\n");
  write(dir, "Config.cfg", JSON.stringify({ isInteractive: true, interactor: "interactor.cpp", useStdIO: true }));
  write(dir, "tests/01.in", "21\n");
});

// 10. Generated Case Collision and Empty Folder
addCase({
  id: "edge_case_structure",
  tags: ["edge", "generated", "python", "je", "pathology"],
  languageProfileId: "python-cpython312",
  extension: "py",
  platforms: ["all"],
  ioMode: "stdio",
  fixtureRoot: "generated/edge_case_structure",
  expectedCompileOutcome: "SUCCESS",
  expectedProblemVerdict: "JE",
  expectedMaxScore: { numerator: "1", denominator: "1", display: 1 },
  expectedScore: { numerator: "0", denominator: "1", display: 0 },
  provenance: "Missing interactor leads to JE. Virtual structure exercises case collision and long path boundaries.",
  tests: [
    { name: "collision.in", verdict: "JE", checkerMessage: "Cannot resolve interactor path", score: { numerator: "0", denominator: "1", display: 0 } }
  ],
  files: [
    { path: "Config.cfg", role: "config" },
    { path: "solution.py", role: "source" },
    { path: "tests/empty", role: "folder", emptyDirectory: true },
    { path: "tests/empty/.judgedesk-empty", role: "structure-marker" },
    { path: "virtual-structure.json", role: "descriptor" }
  ]
}, (dir) => {
  write(dir, "Config.cfg", JSON.stringify({ isInteractive: true, interactor: "missing.cpp", useStdIO: true }));
  write(dir, "solution.py", "pass\n");
  write(dir, "tests/empty/.judgedesk-empty", "No testcase inputs or outputs belong in this directory.\n");
  write(dir, "virtual-structure.json", JSON.stringify({
    kind: "case_collision_and_long_path",
    virtualFiles: [
      { path: "tests/collision.in", content: "a" },
      { path: "tests/Collision.in", content: "b" },
      { path: "tests/" + "A".repeat(200) + ".in", content: "c" }
    ]
  }));
});

// 11. C MLE Stdio
addCase({
  id: "c_mle_stdio",
  tags: ["c", "mle", "stdio"],
  languageProfileId: "c-gcc14",
  extension: "c",
  platforms: ["all"],
  ioMode: "stdio",
  fixtureRoot: "static/c_mle_stdio",
  expectedCompileOutcome: "SUCCESS",
  expectedProblemVerdict: "MLE",
  expectedMaxScore: { numerator: "1", denominator: "1", display: 1 },
  expectedScore: { numerator: "0", denominator: "1", display: 0 },
  provenance: "Node memory limit exceeded (allocate beyond limit).",
  tests: [
    { name: "01", verdict: "MLE", checkerMessage: null, score: { numerator: "0", denominator: "1", display: 0 } }
  ],
  files: [
    { path: "Config.cfg", role: "config" },
    { path: "solution.c", role: "source" },
    { path: "tests/01.in", role: "input" },
    { path: "tests/01.out", role: "answer" }
  ]
}, (dir) => {
  write(dir, "Config.cfg", JSON.stringify({ useStdIO: true, memoryLimit: 8 }));
  write(dir, "solution.c", "#include <stdlib.h>\nint main() { while(1) malloc(1024*1024); return 0; }\n");
  write(dir, "tests/01.in", "42\n");
  write(dir, "tests/01.out", "42\n");
});

// 12. Python OLE Stdio
addCase({
  id: "python_ole_stdio",
  tags: ["python", "ole", "stdio"],
  languageProfileId: "python-cpython312",
  extension: "py",
  platforms: ["all"],
  ioMode: "stdio",
  fixtureRoot: "static/python_ole_stdio",
  expectedCompileOutcome: "SUCCESS",
  expectedProblemVerdict: "OLE",
  expectedMaxScore: { numerator: "1", denominator: "1", display: 1 },
  expectedScore: { numerator: "0", denominator: "1", display: 0 },
  provenance: "Node output limit exceeded.",
  tests: [
    { name: "01", verdict: "OLE", checkerMessage: null, score: { numerator: "0", denominator: "1", display: 0 } }
  ],
  files: [
    { path: "Config.cfg", role: "config" },
    { path: "solution.py", role: "source" },
    { path: "tests/01.in", role: "input" },
    { path: "tests/01.out", role: "answer" }
  ]
}, (dir) => {
  write(dir, "Config.cfg", JSON.stringify({ useStdIO: true }));
  write(dir, "solution.py", "while True: print('A' * 1024 * 1024)\n");
  write(dir, "tests/01.in", "42\n");
  write(dir, "tests/01.out", "42\n");
});

// 13. Python Checker (Testlib AC)
addCase({
  id: "python_checker_ac",
  tags: ["python", "ac", "custom_checker"],
  languageProfileId: "python-cpython312",
  extension: "py",
  platforms: ["all"],
  ioMode: "stdio",
  fixtureRoot: "static/python_checker_ac",
  expectedCompileOutcome: "SUCCESS",
  expectedProblemVerdict: "AC",
  expectedMaxScore: { numerator: "1", denominator: "1", display: 1 },
  expectedScore: { numerator: "1", denominator: "1", display: 1 },
  provenance: "Python checker running correctly.",
  tests: [
    { name: "01", verdict: "AC", checkerMessage: "OK", score: { numerator: "1", denominator: "1", display: 1 } }
  ],
  files: [
    { path: "Config.cfg", role: "config" },
    { path: "solution.py", role: "source" },
    { path: "check.py", role: "checker" },
    { path: "tests/01.in", role: "input" },
    { path: "tests/01.out", role: "answer" }
  ]
}, (dir) => {
  write(dir, "Config.cfg", JSON.stringify({ useStdIO: true, checkerType: "check.py" }));
  write(dir, "solution.py", "print(42)\n");
  write(dir, "check.py", "import sys\nprint('OK')\nsys.exit(0)\n");
  write(dir, "tests/01.in", "42\n");
  write(dir, "tests/01.out", "42\n");
});

// 14. Missing config defaults
addCase({
  id: "missing_config_default_wa",
  tags: ["cpp", "wa", "file", "pathology"],
  languageProfileId: "cpp-legacy-v1",
  extension: "cpp",
  platforms: ["all"],
  ioMode: "file",
  fixtureRoot: "static/missing_config_default_wa",
  expectedCompileOutcome: "SUCCESS",
  expectedProblemVerdict: "WA",
  expectedMaxScore: { numerator: "1", denominator: "1", display: 1 },
  expectedScore: { numerator: "0", denominator: "1", display: 0 },
  provenance: "Missing config defaults to .inp/.out. The solution ignores them and does nothing, so WA.",
  tests: [
    { name: "01", verdict: "WA", checkerMessage: "Wrong answer at line 1", score: { numerator: "0", denominator: "1", display: 0 } }
  ],
  files: [
    { path: "Config.cfg", role: "config", expectedAbsence: true },
    { path: "solution.cpp", role: "source" },
    { path: "tests/01.in", role: "input" },
    { path: "tests/01.out", role: "answer" }
  ]
}, (dir) => {
  write(dir, "solution.cpp", "int main() { return 0; }\n");
  write(dir, "tests/01.in", "42\n");
  write(dir, "tests/01.out", "42\n");
});

// 15. COMPLETE_GROUP effect
addCase({
  id: "complete_group",
  tags: ["cpp", "partial", "groups", "complete_group"],
  languageProfileId: "cpp-legacy-v1",
  extension: "cpp",
  platforms: ["all"],
  ioMode: "stdio",
  fixtureRoot: "static/complete_group",
  expectedCompileOutcome: "SUCCESS",
  expectedProblemVerdict: "PARTIAL",
  expectedMaxScore: { numerator: "100", denominator: "1", display: 100 },
  expectedScore: { numerator: "0", denominator: "1", display: 0 },
  provenance: "Groups where COMPLETE_GROUP policy zeroes out group score when one test fails.",
  tests: [
    { name: "01", verdict: "AC", checkerMessage: "single line", score: { numerator: "0", denominator: "1", display: 0 } },
    { name: "02", verdict: "WA", checkerMessage: "Wrong answer at line 1", score: { numerator: "0", denominator: "1", display: 0 } }
  ],
  groupEffects: [
    { groupId: "0", dependenciesMet: true, resolvedVerdict: "PARTIAL", score: { numerator: "0", denominator: "1", display: 0 } }
  ],
  files: [
    { path: "Config.cfg", role: "config" },
    { path: "solution.cpp", role: "source" },
    { path: "tests/01.in", role: "input" },
    { path: "tests/01.out", role: "answer" },
    { path: "tests/02.in", role: "input" },
    { path: "tests/02.out", role: "answer" }
  ]
}, (dir) => {
  write(dir, "Config.cfg", JSON.stringify({
    useStdIO: true,
    enableGroups: true,
    groups: { "0": { policy: "COMPLETE_GROUP" } },
    tests: { "01": { group: "0", points: 50 }, "02": { group: "0", points: 50 } }
  }));
  write(dir, "solution.cpp", "#include <iostream>\nusing namespace std;\nint main() { int a; cin >> a; if (a == 42) cout << 42 << \"\\n\"; else cout << 43 << \"\\n\"; return 0; }\n");
  write(dir, "tests/01.in", "42\n");
  write(dir, "tests/01.out", "42\n");
  write(dir, "tests/02.in", "43\n");
  write(dir, "tests/02.out", "42\n");
});

// 16. Python Interactor
addCase({
  id: "python_interactor",
  tags: ["python", "interactor"],
  languageProfileId: "python-cpython312",
  extension: "py",
  platforms: ["all"],
  ioMode: "stdio",
  fixtureRoot: "static/python_interactor",
  expectedCompileOutcome: "SUCCESS",
  expectedProblemVerdict: "AC",
  expectedMaxScore: { numerator: "1", denominator: "1", display: 1 },
  expectedScore: { numerator: "1", denominator: "1", display: 1 },
  provenance: "Node Python interactor.",
  tests: [
    { name: "01", verdict: "AC", checkerMessage: "ok", score: { numerator: "1", denominator: "1", display: 1 } }
  ],
  files: [
    { path: "Config.cfg", role: "config" },
    { path: "solution.py", role: "source" },
    { path: "interactor.py", role: "interactor" },
    { path: "tests/01.in", role: "input" },
    { path: "tests/01.out", role: "answer", expectedAbsence: true }
  ]
}, (dir) => {
  write(dir, "solution.py", "print(int(input()) * 2)\n");
  write(dir, "interactor.py", "import sys\nwith open(sys.argv[1], 'r') as f:\n  x = int(f.read().strip())\nprint(x)\nsys.stdout.flush()\ny = int(input())\nprint('ok')\nsys.exit(0 if y == x * 2 else 1)\n");
  write(dir, "Config.cfg", JSON.stringify({ isInteractive: true, interactor: "interactor.py", useStdIO: true }));
  write(dir, "tests/01.in", "21\n");
});

// 17. SB2 and SB files (scratch legacy AC)
addCase({
  id: "scratch_legacy_ac",
  tags: ["scratch", "ac", "legacy"],
  languageProfileId: "scratch-turbowarp-v1",
  extension: "sb2",
  platforms: ["all"],
  ioMode: "stdio",
  fixtureRoot: "static/scratch_legacy_ac",
  expectedCompileOutcome: "SUCCESS",
  expectedProblemVerdict: "AC",
  expectedMaxScore: { numerator: "1", denominator: "1", display: 1 },
  expectedScore: { numerator: "1", denominator: "1", display: 1 },
  provenance: "Node Scratch legacy extensions.",
  tests: [
    { name: "01", verdict: "AC", checkerMessage: "single line", score: { numerator: "1", denominator: "1", display: 1 } }
  ],
  files: [
    { path: "Config.cfg", role: "config" },
    { path: "project.sb2", role: "source" },
    { path: "project2.sb", role: "source", expectedAbsence: true },
    { path: "tests/01.in", role: "input" },
    { path: "tests/01.out", role: "answer" }
  ]
}, (dir) => {
  const sb2Json = JSON.stringify({
    objName: "Stage",
    costumes: [
      {
        costumeName: "backdrop1",
        baseLayerID: 0,
        baseLayerMD5: "5c81a336befda4d955c139500fb504b1.png",
        bitmapResolution: 1,
        rotationCenterX: 240,
        rotationCenterY: 180
      }
    ],
    currentCostumeIndex: 0,
    penLayerMD5: "5c81a336befda4d955c139500fb504b1.png",
    penLayerID: 0,
    tempoBPM: 60,
    videoAlpha: 0.5,
    children: [
      {
        objName: "Sprite1",
        costumes: [
          {
            costumeName: "costume1",
            baseLayerID: 1,
            baseLayerMD5: "0fb9be3e8397c983338cb71dc84d0b25.svg",
            bitmapResolution: 1,
            rotationCenterX: 47,
            rotationCenterY: 55
          }
        ],
        currentCostumeIndex: 0,
        scratchX: 0,
        scratchY: 0,
        scale: 1,
        direction: 90,
        rotationStyle: "normal",
        isDraggable: false,
        indexInLibrary: 1,
        visible: true,
        spriteInfo: {},
        scripts: [
          [
            10,
            10,
            [
              ["whenGreenFlag"],
              ["doAsk", ""],
              ["say:", ["answer"]]
            ]
          ]
        ]
      }
    ],
    info: {
      scratchVersion: "2.0"
    }
  });
  write(dir, "Config.cfg", JSON.stringify({ useStdIO: true }));
  write(dir, "project.sb2", createStoredZip("project.json", Buffer.from(sb2Json, "utf8")));
  write(dir, "tests/01.in", "42\n");
  write(dir, "tests/01.out", "42\n");
});

// 18. Pascal .pp source extension
addCase({
  id: "pascal_pp_stdio",
  tags: ["pascal", "ac", "stdio"],
  languageProfileId: "pascal-fpc322",
  extension: "pp",
  platforms: ["all"],
  ioMode: "stdio",
  fixtureRoot: "static/pascal_pp_stdio",
  expectedCompileOutcome: "SUCCESS",
  expectedProblemVerdict: "AC",
  expectedMaxScore: { numerator: "1", denominator: "1", display: 1 },
  expectedScore: { numerator: "1", denominator: "1", display: 1 },
  provenance: "Free Pascal .pp source extension with standard I/O.",
  tests: [
    { name: "01", verdict: "AC", checkerMessage: "single line", score: { numerator: "1", denominator: "1", display: 1 } }
  ],
  files: [
    { path: "Config.cfg", role: "config" },
    { path: "solution.pp", role: "source" },
    { path: "tests/01.in", role: "input" },
    { path: "tests/01.out", role: "answer" }
  ]
}, (dir) => {
  write(dir, "Config.cfg", JSON.stringify({ useStdIO: true }));
  write(dir, "solution.pp", "program Solution;\nvar x: longint;\nbegin\n  readln(x);\n  writeln(x);\nend.\n");
  write(dir, "tests/01.in", "42\n");
  write(dir, "tests/01.out", "42\n");
});

// 19. Scratch .sb binary format
addCase({
  id: "scratch_sb_stdio",
  tags: ["scratch", "re", "legacy", "unsupported"],
  languageProfileId: "scratch-turbowarp-v1",
  extension: "sb",
  platforms: ["all"],
  ioMode: "stdio",
  fixtureRoot: "static/scratch_sb_stdio",
  expectedCompileOutcome: "SUCCESS",
  expectedProblemVerdict: "RE",
  expectedMaxScore: { numerator: "1", denominator: "1", display: 1 },
  expectedScore: { numerator: "0", denominator: "1", display: 0 },
  provenance: "Scratch 1.4 .sb binary project format fails closed as unsupported by the Scratch 2.X/3.X runtime engine.",
  tests: [
    { name: "01", verdict: "RE", checkerMessage: null, score: { numerator: "0", denominator: "1", display: 0 } }
  ],
  files: [
    { path: "Config.cfg", role: "config" },
    { path: "project.sb", role: "source" },
    { path: "tests/01.in", role: "input" },
    { path: "tests/01.out", role: "answer" }
  ]
}, (dir) => {
  const sbHeader = Buffer.from("ScratchV02\0\0\0\0\0\0\0\0", "utf8");
  write(dir, "Config.cfg", JSON.stringify({ useStdIO: true }));
  write(dir, "project.sb", sbHeader);
  write(dir, "tests/01.in", "42\n");
  write(dir, "tests/01.out", "42\n");
});

// 20. Malformed Config
addCase({
  id: "malformed_config",
  tags: ["cpp", "wa", "file", "pathology"],
  languageProfileId: "cpp-legacy-v1",
  extension: "cpp",
  platforms: ["all"],
  ioMode: "file",
  fixtureRoot: "static/malformed_config",
  expectedCompileOutcome: "SUCCESS",
  expectedProblemVerdict: "WA",
  expectedMaxScore: { numerator: "1", denominator: "1", display: 1 },
  expectedScore: { numerator: "0", denominator: "1", display: 0 },
  provenance: "Malformed Config.cfg JSON syntax causes readStoredProblemConfig to throw and resolveProblemConfig to fall back safely to defaults.",
  tests: [
    { name: "01", verdict: "WA", checkerMessage: "Wrong answer at line 1", score: { numerator: "0", denominator: "1", display: 0 } }
  ],
  files: [
    { path: "Config.cfg", role: "config" },
    { path: "solution.cpp", role: "source" },
    { path: "tests/01.in", role: "input" },
    { path: "tests/01.out", role: "answer" }
  ]
}, (dir) => {
  write(dir, "Config.cfg", "{ \"useStdIO\": true, INVALID_JSON_SYNTAX ");
  write(dir, "solution.cpp", "#include <iostream>\nusing namespace std;\nint main() { return 0; }\n");
  write(dir, "tests/01.in", "42\n");
  write(dir, "tests/01.out", "42\n");
});

// 21. Unicode and Spaces in physical filenames
addCase({
  id: "unicode_space_paths",
  tags: ["cpp", "ac", "stdio", "pathology"],
  languageProfileId: "cpp-legacy-v1",
  extension: "cpp",
  platforms: ["all"],
  ioMode: "stdio",
  fixtureRoot: "static/unicode_space_paths",
  expectedCompileOutcome: "SUCCESS",
  expectedProblemVerdict: "AC",
  expectedMaxScore: { numerator: "1", denominator: "1", display: 1 },
  expectedScore: { numerator: "1", denominator: "1", display: 1 },
  provenance: "Physical Unicode and space characters in test names and problem files.",
  tests: [
    { name: "bài 01", verdict: "AC", checkerMessage: "single line", score: { numerator: "1", denominator: "1", display: 1 } }
  ],
  files: [
    { path: "Config.cfg", role: "config" },
    { path: "bài làm.cpp", role: "source" },
    { path: "tests/bài 01.in", role: "input" },
    { path: "tests/bài 01.out", role: "answer" }
  ]
}, (dir) => {
  write(dir, "Config.cfg", JSON.stringify({ useStdIO: true }));
  write(dir, "bài làm.cpp", "#include <iostream>\nusing namespace std;\nint main() { int a; cin >> a; cout << a; return 0; }\n");
  write(dir, "tests/bài 01.in", "42\n");
  write(dir, "tests/bài 01.out", "42\n");
});

// 22. Group Dependencies Effect
addCase({
  id: "group_dependencies",
  tags: ["cpp", "partial", "groups", "dependencies"],
  languageProfileId: "cpp-legacy-v1",
  extension: "cpp",
  platforms: ["all"],
  ioMode: "stdio",
  fixtureRoot: "static/group_dependencies",
  expectedCompileOutcome: "SUCCESS",
  expectedProblemVerdict: "PARTIAL",
  expectedMaxScore: { numerator: "100", denominator: "1", display: 100 },
  expectedScore: { numerator: "0", denominator: "1", display: 0 },
  provenance: "Group 1 depends on Group 0. Group 0 fails (WA), so Group 1 dependencies are not met, zeroing test scores in Group 1 even though test 02 passed.",
  tests: [
    { name: "01", verdict: "WA", checkerMessage: "Wrong answer at line 1", score: { numerator: "0", denominator: "1", display: 0 } },
    { name: "02", verdict: "AC", checkerMessage: "single line", score: { numerator: "0", denominator: "1", display: 0 } }
  ],
  groupEffects: [
    { groupId: "0", dependenciesMet: true, resolvedVerdict: "WA", score: { numerator: "0", denominator: "1", display: 0 } },
    { groupId: "1", dependenciesMet: false, resolvedVerdict: "AC", score: { numerator: "0", denominator: "1", display: 0 } }
  ],
  files: [
    { path: "Config.cfg", role: "config" },
    { path: "solution.cpp", role: "source" },
    { path: "tests/01.in", role: "input" },
    { path: "tests/01.out", role: "answer" },
    { path: "tests/02.in", role: "input" },
    { path: "tests/02.out", role: "answer" }
  ]
}, (dir) => {
  write(dir, "Config.cfg", JSON.stringify({
    useStdIO: true,
    enableGroups: true,
    groups: {
      "0": { policy: "EACH_TEST" },
      "1": { policy: "EACH_TEST", dependencies: ["0"] }
    },
    tests: {
      "01": { group: "0", points: 40 },
      "02": { group: "1", points: 60 }
    }
  }));
  write(dir, "solution.cpp", "#include <iostream>\nusing namespace std;\nint main() { int a; cin >> a; if (a == 42) cout << 99 << endl; else cout << a << endl; return 0; }\n");
  write(dir, "tests/01.in", "42\n");
  write(dir, "tests/01.out", "42\n");
  write(dir, "tests/02.in", "100\n");
  write(dir, "tests/02.out", "100\n");
});

// 23. Rational boundary
addCase({
  id: "rational_boundary",
  tags: ["cpp", "ac", "stdio", "rational"],
  languageProfileId: "cpp-legacy-v1",
  extension: "cpp",
  platforms: ["all"],
  ioMode: "stdio",
  fixtureRoot: "static/rational_boundary",
  expectedCompileOutcome: "SUCCESS",
  expectedProblemVerdict: "AC",
  expectedMaxScore: { numerator: "9007199254740991", denominator: "1", display: 9007199254740991 },
  expectedScore: { numerator: "9007199254740991", denominator: "1", display: 9007199254740991 },
  provenance: "Exact rational arithmetic across non-integral test points: 1/3 + 1/2 + 1/6 = 1, plus safe-integer boundary 9007199254740990 totaling Number.MAX_SAFE_INTEGER.",
  tests: [
    { name: "01", verdict: "AC", checkerMessage: "single line", score: { numerator: "1", denominator: "3", display: 0.333333 } },
    { name: "02", verdict: "AC", checkerMessage: "single line", score: { numerator: "1", denominator: "2", display: 0.5 } },
    { name: "03", verdict: "AC", checkerMessage: "single line", score: { numerator: "1", denominator: "6", display: 0.166667 } },
    { name: "04", verdict: "AC", checkerMessage: "single line", score: { numerator: "9007199254740990", denominator: "1", display: 9007199254740990 } }
  ],
  files: [
    { path: "Config.cfg", role: "config" },
    { path: "solution.cpp", role: "source" },
    { path: "tests/01.in", role: "input" },
    { path: "tests/01.out", role: "answer" },
    { path: "tests/02.in", role: "input" },
    { path: "tests/02.out", role: "answer" },
    { path: "tests/03.in", role: "input" },
    { path: "tests/03.out", role: "answer" },
    { path: "tests/04.in", role: "input" },
    { path: "tests/04.out", role: "answer" }
  ]
}, (dir) => {
  write(dir, "Config.cfg", JSON.stringify({
    useStdIO: true,
    enableGroups: true,
    groups: {
      "0": { policy: "EACH_TEST" }
    },
    tests: {
      "01": { group: "0", points: "1/3" },
      "02": { group: "0", points: "0.5" },
      "03": { group: "0", points: "1/6" },
      "04": { group: "0", points: "9007199254740990" }
    }
  }));
  write(dir, "solution.cpp", "#include <iostream>\nusing namespace std;\nint main() { int a; cin >> a; cout << a << endl; return 0; }\n");
  write(dir, "tests/01.in", "1\n");
  write(dir, "tests/01.out", "1\n");
  write(dir, "tests/02.in", "2\n");
  write(dir, "tests/02.out", "2\n");
  write(dir, "tests/03.in", "3\n");
  write(dir, "tests/03.out", "3\n");
  write(dir, "tests/04.in", "4\n");
  write(dir, "tests/04.out", "4\n");
});

// 24. Testlib exit and message matrix
addCase({
  id: "testlib_matrix",
  tags: ["python", "partial", "custom_checker", "testlib"],
  languageProfileId: "python-cpython312",
  extension: "py",
  platforms: ["all"],
  ioMode: "stdio",
  fixtureRoot: "static/testlib_matrix",
  expectedCompileOutcome: "SUCCESS",
  expectedProblemVerdict: "PARTIAL",
  expectedMaxScore: { numerator: "5", denominator: "1", display: 5 },
  expectedScore: { numerator: "3", denominator: "2", display: 1.5 },
  provenance: "Systematic testlib exit code matrix: 0 (AC), 1 (WA), 2 (PE), 7 (PARTIAL), 3 (JE).",
  tests: [
    { name: "01", verdict: "AC", checkerMessage: "ok", score: { numerator: "1", denominator: "1", display: 1 } },
    { name: "02", verdict: "WA", checkerMessage: "wrong answer", score: { numerator: "0", denominator: "1", display: 0 } },
    { name: "03", verdict: "PE", checkerMessage: "presentation error", score: { numerator: "0", denominator: "1", display: 0 } },
    { name: "04", verdict: "PARTIAL", checkerMessage: "points 0.5", score: { numerator: "1", denominator: "2", display: 0.5 } },
    { name: "05", verdict: "JE", checkerMessage: "checker crashed", score: { numerator: "0", denominator: "1", display: 0 } }
  ],
  files: [
    { path: "Config.cfg", role: "config" },
    { path: "solution.py", role: "source" },
    { path: "check.py", role: "checker" },
    { path: "tests/01.in", role: "input" },
    { path: "tests/01.out", role: "answer" },
    { path: "tests/02.in", role: "input" },
    { path: "tests/02.out", role: "answer" },
    { path: "tests/03.in", role: "input" },
    { path: "tests/03.out", role: "answer" },
    { path: "tests/04.in", role: "input" },
    { path: "tests/04.out", role: "answer" },
    { path: "tests/05.in", role: "input" },
    { path: "tests/05.out", role: "answer" }
  ]
}, (dir) => {
  write(dir, "Config.cfg", JSON.stringify({ useStdIO: true, checkerType: "check.py" }));
  write(dir, "solution.py", "print(input())\n");
  write(dir, "check.py", `import sys
with open(sys.argv[1], 'r') as f:
    code = f.read().strip()
if code == '0':
    print('ok')
    sys.exit(0)
elif code == '1':
    print('wrong answer')
    sys.exit(1)
elif code == '2':
    print('presentation error')
    sys.exit(2)
elif code == '7':
    print('points 0.5')
    sys.exit(7)
else:
    print('checker crashed')
    sys.exit(3)
`);
  write(dir, "tests/01.in", "0\n");
  write(dir, "tests/01.out", "0\n");
  write(dir, "tests/02.in", "1\n");
  write(dir, "tests/02.out", "1\n");
  write(dir, "tests/03.in", "2\n");
  write(dir, "tests/03.out", "2\n");
  write(dir, "tests/04.in", "7\n");
  write(dir, "tests/04.out", "7\n");
  write(dir, "tests/05.in", "3\n");
  write(dir, "tests/05.out", "3\n");
});

// Proportional allocation must retain its fraction before final numeric display.
addCase({
  id: "rational_proportional_boundary",
  tags: ["python", "rational", "partial", "boundary"],
  languageProfileId: "python-cpython312",
  extension: "py",
  platforms: ["all"],
  ioMode: "stdio",
  fixtureRoot: "generated/rational_proportional_boundary",
  expectedCompileOutcome: "SUCCESS",
  expectedProblemVerdict: "PARTIAL",
  expectedMaxScore: { numerator: "9007199254740991", denominator: "1", display: 9007199254740991 },
  expectedScore: { numerator: "9007199254740991", denominator: "3", display: 9007199254740991 / 3 },
  provenance: "Production totalScore allocation: three equal weights, one AC and two WA, preserving MAX_SAFE_INTEGER/3 through runner and summary.",
  tests: [
    { name: "01", verdict: "AC", checkerMessage: "single line", score: { numerator: "9007199254740991", denominator: "3", display: 9007199254740991 / 3 } },
    { name: "02", verdict: "WA", checkerMessage: null, score: { numerator: "0", denominator: "1", display: 0 } },
    { name: "03", verdict: "WA", checkerMessage: null, score: { numerator: "0", denominator: "1", display: 0 } },
  ],
  files: [
    { path: "Config.cfg", role: "config" },
    { path: "solution.py", role: "source" },
    ...["01", "02", "03"].flatMap(name => [
      { path: `tests/${name}.in`, role: "input" },
      { path: `tests/${name}.out`, role: "answer" },
    ]),
  ],
}, dir => {
  write(dir, "Config.cfg", JSON.stringify({ useStdIO: true, totalScore: "9007199254740991", defaultScore: 1 }));
  write(dir, "solution.py", "print(input())\n");
  for (const name of ["01", "02", "03"]) {
    write(dir, `tests/${name}.in`, "1\n");
    write(dir, `tests/${name}.out`, name === "01" ? "1\n" : "2\n");
  }
});

cases.sort((a, b) => a.id.localeCompare(b.id));

const manifest = {
  version: 1,
  cases
};

// Custom JSON stringifier to strictly sort keys
function sortKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

if (!process.argv.includes("--check")) {
  const content = JSON.stringify(sortKeys(manifest), null, 2) + "\n";
  const tmpPath = path.join(path.dirname(manifestPath), `.${path.basename(manifestPath)}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, manifestPath);
  console.log(`Generated manifest at ${manifestPath} with ${cases.length} cases.`);
} else {
  const content = JSON.stringify(sortKeys(manifest), null, 2) + "\n";
  const existing = fs.readFileSync(manifestPath, "utf8");
  if (content !== existing) {
    console.error("Manifest mismatch! Run generate-corpus.ts to update.");
    process.exit(1);
  }
  console.log("Check passed: manifest is up-to-date and stable.");
}
