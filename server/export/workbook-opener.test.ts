import assert from "node:assert/strict";
import test from "node:test";
import { hostProcessEnvironment } from "../../shared/linux-host-environment.js";
import hostKeys from "../../shared/linux-host-environment.json" with { type: "json" };
import { launchWorkbookViewer } from "./workbook-opener.js";

test("AppImage host environment restores unset and empty variables and keeps the desktop session", () => {
  const original: NodeJS.ProcessEnv = {
    APPDIR: "/bundle", LD_LIBRARY_PATH: "/bundle/lib", GTK_PATH: "/bundle/gtk",
    JUDGEDESK_HOST_ENV_VERSION: "1", DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/bus",
  };
  for (const key of hostKeys) original[`JUDGEDESK_HOST_${key}_SET`] = "0";
  original.JUDGEDESK_HOST_PATH_SET = "1";
  original.JUDGEDESK_HOST_PATH = "/usr/bin:/bin";
  original.JUDGEDESK_HOST_LD_LIBRARY_PATH_SET = "1";
  original.JUDGEDESK_HOST_LD_LIBRARY_PATH = "";
  const clean = hostProcessEnvironment("linux", original);
  assert.equal(clean.LD_LIBRARY_PATH, "");
  assert.equal(clean.GTK_PATH, undefined);
  assert.equal(clean.PATH, "/usr/bin:/bin");
  assert.equal(clean.WAYLAND_DISPLAY, "wayland-0");
  assert.equal(clean.DBUS_SESSION_BUS_ADDRESS, original.DBUS_SESSION_BUS_ADDRESS);
  assert.ok(!Object.keys(clean).some(key => key.startsWith("JUDGEDESK_HOST_")));
  assert.equal(original.GTK_PATH, "/bundle/gtk");
  assert.deepEqual(hostProcessEnvironment("win32", original), original);
  assert.deepEqual(hostProcessEnvironment("darwin", original), original);
});

test("viewer launch detects loader failure instead of reporting a successful export handoff", async () => {
  await assert.rejects(launchWorkbookViewer(process.execPath, ["-e", "process.stderr.write('loader failed');process.exit(127)"]), /127.*loader failed/s);
  await launchWorkbookViewer(process.execPath, ["-e", "process.exit(0)"]);
});
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
