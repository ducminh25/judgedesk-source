export interface WorkspacePathMemory {
  activePath: string;
  rememberedPath: string;
}

export function initializeWorkspacePathMemory(rememberedPath: string | null): WorkspacePathMemory {
  return {
    activePath: "",
    rememberedPath: rememberedPath?.trim() ? rememberedPath : "",
  };
}

export function activateWorkspacePath(
  memory: WorkspacePathMemory,
  activePath: string,
  remember = true,
): WorkspacePathMemory {
  return {
    activePath,
    rememberedPath: remember ? activePath : memory.rememberedPath,
  };
}

export function resetActiveWorkspacePath(memory: WorkspacePathMemory): WorkspacePathMemory {
  return { ...memory, activePath: "" };
}

export function workspacePickerPath(memory: WorkspacePathMemory): string {
  return memory.activePath.trim() ? memory.activePath : memory.rememberedPath;
}
