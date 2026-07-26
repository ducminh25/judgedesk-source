import { useState, useCallback } from "react";
import { apiFetch } from "../../api";
import type { ProblemConfig } from "../../types";
import { createDefaultProblemConfig } from "../../../shared/problem-config";
import { preferencesStorage } from "../preferences/storage";
import {
  activateWorkspacePath,
  initializeWorkspacePathMemory,
  resetActiveWorkspacePath,
  workspacePickerPath,
} from "./path-memory";
import { reconcileSelection } from "./selection-state";

interface LoadOptions {
  preserveSelection?: boolean;
}

interface ProblemsResponse {
  success: boolean;
  data?: string[];
  customCheckers?: Record<string, string[]>;
}

interface ContestantsResponse {
  success: boolean;
  data?: string[];
}

export interface RestoredContestWorkspace {
  contestantsPath: string;
  testsPath: string;
  problemConfigs: Record<string, ProblemConfig>;
  selectedContestants: Record<string, boolean>;
  selectedProblems: Record<string, boolean>;
}

async function fetchContestants(path: string): Promise<string[]> {
  const response = await apiFetch(`/api/fetch-contestants?path=${encodeURIComponent(path)}`);
  const data = (await response.json()) as ContestantsResponse;
  if (!data.success || !data.data) return [];
  return data.data;
}

async function fetchProblems(path: string): Promise<Required<Pick<ProblemsResponse, "data" | "customCheckers">>> {
  const response = await apiFetch(`/api/fetch-problems?path=${encodeURIComponent(path)}`);
  const data = (await response.json()) as ProblemsResponse;
  return {
    data: data.success && data.data ? data.data : [],
    customCheckers: data.customCheckers || {},
  };
}

export function useContestWorkspace() {
  const [contestantsPathMemory, setContestantsPathMemory] = useState(() =>
    initializeWorkspacePathMemory(preferencesStorage.getContestantsPath()));
  const [testPathMemory, setTestPathMemory] = useState(() =>
    initializeWorkspacePathMemory(preferencesStorage.getTestsPath()));
  const contestantsPath = contestantsPathMemory.activePath;
  const testPath = testPathMemory.activePath;
  const [contestants, setContestants] = useState<string[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [problemConfigs, setProblemConfigs] = useState<Record<string, ProblemConfig>>({});
  const [selectedContestants, setSelectedContestants] = useState<Record<string, boolean>>({});
  const [selectedProblems, setSelectedProblems] = useState<Record<string, boolean>>({});
  const [customCheckers, setCustomCheckers] = useState<Record<string, string[]>>({});

  const loadContestants = useCallback(async (
    pathOverride?: string,
    options: LoadOptions = {},
  ) => {
    const targetPath = pathOverride ?? contestantsPath;
    if (!targetPath.trim()) return [];
    try {
      const data = await fetchContestants(targetPath);
      setContestants(data);
      setSelectedContestants((previous) => options.preserveSelection
        ? reconcileSelection(data, previous)
        : Object.fromEntries(data.map((name) => [name, true])));
      return data;
    } catch (error) {
      console.error("Failed to load contestants", error);
      return [];
    }
  }, [contestantsPath]);

  const loadProblems = useCallback(async (
    pathOverride?: string,
    options: LoadOptions = {},
  ) => {
    const targetPath = pathOverride ?? testPath;
    if (!targetPath.trim()) return [];
    try {
      const data = await fetchProblems(targetPath);
      setProblems(data.data);
      setCustomCheckers(data.customCheckers);
      setSelectedProblems((previous) => options.preserveSelection
        ? reconcileSelection(data.data, previous)
        : Object.fromEntries(data.data.map((name) => [name, true])));
      setProblemConfigs((previous) => {
        const next = { ...previous };
        for (const problemName of data.data) {
          if (!next[problemName]) next[problemName] = createDefaultProblemConfig(problemName);
        }
        return next;
      });
      return data.data;
    } catch (error) {
      console.error("Failed to load problems", error);
      return [];
    }
  }, [testPath]);

  const restoreWorkspace = useCallback(async (workspace: RestoredContestWorkspace) => {
    const [loadedContestants, loadedProblems] = await Promise.all([
      fetchContestants(workspace.contestantsPath),
      fetchProblems(workspace.testsPath),
    ]);
    setContestantsPathMemory((memory) => activateWorkspacePath(memory, workspace.contestantsPath, false));
    setTestPathMemory((memory) => activateWorkspacePath(memory, workspace.testsPath, false));
    setContestants(loadedContestants);
    setProblems(loadedProblems.data);
    setCustomCheckers(loadedProblems.customCheckers);
    setSelectedContestants(Object.fromEntries(loadedContestants.map((name) => [
      name,
      workspace.selectedContestants[name] ?? true,
    ])));
    setSelectedProblems(Object.fromEntries(loadedProblems.data.map((name) => [
      name,
      workspace.selectedProblems[name] ?? true,
    ])));
    setProblemConfigs(Object.fromEntries(loadedProblems.data.map((name) => [
      name,
      workspace.problemConfigs[name] || createDefaultProblemConfig(name),
    ])));
  }, []);

  const resetWorkspace = useCallback(() => {
    setContestantsPathMemory(resetActiveWorkspacePath);
    setTestPathMemory(resetActiveWorkspacePath);
    setContestants([]);
    setProblems([]);
    setCustomCheckers({});
    setProblemConfigs({});
    setSelectedContestants({});
    setSelectedProblems({});
  }, []);

  const saveProblemConfig = useCallback((problemName: string, config: ProblemConfig) => {
    setProblemConfigs((previous) => ({ ...previous, [problemName]: config }));
  }, []);

  const setContestantsPath = useCallback((path: string) => {
    setContestantsPathMemory((memory) => activateWorkspacePath(memory, path));
    preferencesStorage.setContestantsPath(path);
  }, []);

  const setTestPath = useCallback((path: string) => {
    setTestPathMemory((memory) => activateWorkspacePath(memory, path));
    preferencesStorage.setTestsPath(path);
  }, []);

  return {
    contestants,
    contestantsPath,
    contestantsPickerPath: workspacePickerPath(contestantsPathMemory),
    customCheckers,
    loadContestants,
    loadProblems,
    problemConfigs,
    problems,
    resetWorkspace,
    restoreWorkspace,
    saveProblemConfig,
    selectedContestants,
    selectedProblems,
    setContestantsPath,
    setSelectedContestants,
    setSelectedProblems,
    setTestPath,
    testPath,
    testsPickerPath: workspacePickerPath(testPathMemory),
  };
}
