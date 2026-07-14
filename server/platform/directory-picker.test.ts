import assert from "node:assert/strict";
import test from "node:test";
import { WINDOWS_PICKER_SCRIPT } from "./directory-picker";

test("Windows directory picker only uses the public FolderBrowserDialog API", () => {
  assert.match(WINDOWS_PICKER_SCRIPT, /FolderBrowserDialog/);

  for (const unsafeTechnique of [
    "System.Reflection",
    "BindingFlags",
    "CreateVistaDialog",
    "FileDialogNative",
    ".Hide()",
  ]) {
    assert.doesNotMatch(WINDOWS_PICKER_SCRIPT, new RegExp(unsafeTechnique.replace(".", "\\."), "i"));
  }
});
