import assert from "node:assert/strict";
import test from "node:test";
import { mapWindowsPath } from "./path-mapping";

test("sandbox path mapping converts drive paths and preserves non-drive paths", () => {
  assert.equal(mapWindowsPath("D:\\Judge\\temp", "/mnt"), "/mnt/d/Judge/temp");
  assert.equal(mapWindowsPath("D:/Judge/temp", "/mnt"), "/mnt/d/Judge/temp");
  assert.equal(
    mapWindowsPath("C:\\Users\\A", "/mnt/host"),
    "/mnt/host/c/Users/A",
  );
  assert.equal(mapWindowsPath("D:/Judge/../temp", "/mnt/"), "/mnt/d/temp");
  assert.equal(mapWindowsPath("/tmp/isolate/box", "/mnt"), "/tmp/isolate/box");
});
