import { useState, useCallback } from "react";
import { apiFetch } from "../../api";
import type { ProblemConfig } from "../../types";
import { createDefaultProblemConfig } from "../../../shared/problem-config";
import { preferencesStorage } from "../preferences/storage";

interface ProblemsResponse {
  success: boolean;
  data?: string[];
  customCheckers?: Record<string, string[]>;
}

interface ContestantsResponse {
  success: boolean;
  data?: string[];
}

export function useContestWorkspace() {
  const [contestantsPath, setContestantsPathState] = useState(preferencesStorage.getContestantsPath() || "");
  const [testPath, setTestPathState] = useState(preferencesStorage.getTestsPath() || "");
  const [timeLimit, setTimeLimit] = useState(1000);
  const [contestants, setContestants] = useState<string[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [problemConfigs, setProblemConfigs] = useState<Record<string, ProblemConfig>>({});
  const [selectedContestants, setSelectedContestants] = useState<Record<string, boolean>>({});
  const [selectedProblems, setSelectedProblems] = useState<Record<string, boolean>>({});
  const [customCheckers, setCustomCheckers] = useState<Record<string, string[]>>({});

  const loadContestants = async (pathOverride?: string) => {
    const targetPath = pathOverride ?? contestantsPath;
    if (!targetPath.trim()) return;
    try {
      const response = await apiFetch(`/api/fetch-contestants?path=${encodeURIComponent(targetPath)}`);
      const data = (await response.json()) as ContestantsResponse;
      if (!data.success || !data.data) return;
      setContestants(data.data);
      setSelectedContestants(Object.fromEntries(data.data.map((name) => [name, true])));
    } catch (error) {
      console.error("Failed to load contestants", error);
    }
  };

  const loadProblems = async (pathOverride?: string) => {
    const targetPath = pathOverride ?? testPath;
    if (!targetPath.trim()) return;
    try {
      const response = await apiFetch(`/api/fetch-problems?path=${encodeURIComponent(targetPath)}`);
      const data = (await response.json()) as ProblemsResponse;
      if (!data.success || !data.data) return;
      setProblems(data.data);
      setCustomCheckers(data.customCheckers || {});
      setSelectedProblems(Object.fromEntries(data.data.map((name) => [name, true])));
      setProblemConfigs((previous) => {
        const next = { ...previous };
        for (const problemName of data.data || []) {
          if (!next[problemName]) next[problemName] = createDefaultProblemConfig(problemName);
        }
        return next;
      });
    } catch (error) {
      console.error("Failed to load problems", error);
    }
  };

  const saveProblemConfig = (problemName: string, config: ProblemConfig) => {
    setProblemConfigs((previous) => ({ ...previous, [problemName]: config }));
  };

  const setContestantsPath = useCallback((path: string) => {
    setContestantsPathState(path);
    preferencesStorage.setContestantsPath(path);
  }, []);

  const setTestPath = useCallback((path: string) => {
    setTestPathState(path);
    preferencesStorage.setTestsPath(path);
  }, []);

  return {
    contestants,
    contestantsPath,
    customCheckers,
    loadContestants,
    loadProblems,
    problemConfigs,
    problems,
    saveProblemConfig,
    selectedContestants,
    selectedProblems,
    setContestantsPath,
    setSelectedContestants,
    setSelectedProblems,
    setTestPath,
    setTimeLimit,
    testPath,
    timeLimit
  };
}
