import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkbookOpenCommand,
  parseWindowsRegistryDefaultValue,
} from "./workbook-opener.js";

test("parses the registered Microsoft Excel executable", () => {
  const output = String.raw`
HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\excel.exe
    (Default)    REG_SZ    C:\Program Files\Microsoft Office\root\Office16\EXCEL.EXE
`;

  assert.equal(
    parseWindowsRegistryDefaultValue(output),
    String.raw`C:\Program Files\Microsoft Office\root\Office16\EXCEL.EXE`,
  );
});

test("ignores registry output without a default string value", () => {
  assert.equal(parseWindowsRegistryDefaultValue("ERROR: The system was unable to find the key."), null);
});

test("opens a normal xlsx as a new unsaved workbook in Microsoft Excel", () => {
  const workbookPath = String.raw`C:\Temp\JudgeDesk\Book.xlsx`;
  assert.deepEqual(
    createWorkbookOpenCommand(
      "win32",
      workbookPath,
      String.raw`C:\Program Files\Microsoft Office\Root\Office16\EXCEL.EXE`,
    ),
    {
      command: String.raw`C:\Program Files\Microsoft Office\Root\Office16\EXCEL.EXE`,
      args: ["/t", workbookPath],
      mode: "excel-unsaved",
    },
  );
});

test("falls back to the operating system with the same xlsx", () => {
  const workbookPath = String.raw`C:\Temp\JudgeDesk\Book.xlsx`;
  assert.deepEqual(
    createWorkbookOpenCommand("win32", workbookPath, null),
    { command: "explorer.exe", args: [workbookPath], mode: "system-open" },
  );
});
