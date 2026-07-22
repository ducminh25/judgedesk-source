import assert from "node:assert/strict";
import test from "node:test";
import {
  activateWorkspacePath,
  initializeWorkspacePathMemory,
  resetActiveWorkspacePath,
  workspacePickerPath,
} from "./path-memory.js";

test("remembered folders prefill the picker without activating a workspace", () => {
  const initial = initializeWorkspacePathMemory(String.raw`D:\last\contestants`);
  assert.equal(initial.activePath, "");
  assert.equal(workspacePickerPath(initial), String.raw`D:\last\contestants`);
});

test("reset clears the scoreboard path but preserves the last picker folder", () => {
  const loaded = activateWorkspacePath(
    initializeWorkspacePathMemory(null),
    String.raw`D:\contest\contestants`,
  );
  const reset = resetActiveWorkspacePath(loaded);
  assert.equal(reset.activePath, "");
  assert.equal(workspacePickerPath(reset), String.raw`D:\contest\contestants`);
});

test("archive paths become active without replacing the remembered picker folder", () => {
  const remembered = initializeWorkspacePathMemory(String.raw`D:\last\contestants`);
  const restored = activateWorkspacePath(remembered, String.raw`C:\temp\opened\contestants`, false);
  assert.equal(restored.activePath, String.raw`C:\temp\opened\contestants`);
  assert.equal(restored.rememberedPath, String.raw`D:\last\contestants`);
});
