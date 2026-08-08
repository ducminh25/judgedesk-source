import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../api";
import { PolygonConfig, PolygonTestConfig, ProblemConfig } from "../../types";
import { normalizeCompileConfig } from "../../../shared/compile-config.js";
import {
  applyTestEdit,
  createEmptyPolygonConfig,
  createsGroupCycle,
  setGroupDependency,
  TestDetail,
  TestEditPopover
} from "./editor-state";

interface EditorOptions {
  problemName: string;
  testPath: string;
  initialConfig: ProblemConfig;
  onSave: (problemName: string, config: ProblemConfig) => void;
  onClose: () => void;
}

export function useProblemConfigEditor({ problemName, testPath, initialConfig, onSave, onClose }: EditorOptions) {
  const [config, setConfig] = useState<ProblemConfig>({
    ...initialConfig,
    memoryLimit: initialConfig.memoryLimit ?? 256,
    checkerType: initialConfig.checkerType || "C1",
    compile: normalizeCompileConfig(initialConfig.compile),
  });
  const [polygonConfig, setPolygonConfig] = useState<PolygonConfig>(createEmptyPolygonConfig);
  const [testDetails, setTestDetails] = useState<TestDetail[]>([]);
  const [selectedTests, setSelectedTests] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [useStdIn, setUseStdIn] = useState(initialConfig.useStdIn ?? initialConfig.useStdIO ?? false);
  const [useStdOut, setUseStdOut] = useState(initialConfig.useStdOut ?? initialConfig.useStdIO ?? false);
  const [inputFile, setInputFile] = useState(initialConfig.inputFile || `${problemName}.inp`);
  const [outputFile, setOutputFile] = useState(initialConfig.outputFile || `${problemName}.out`);
  const problemDirPath = `${testPath}/${problemName}`;

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      setLoadError("");
      try {
        const testsUrl = `/api/fetch-polygon-tests?path=${encodeURIComponent(problemDirPath)}&problem=${encodeURIComponent(problemName)}`;
        const [testsResponse, configResponse] = await Promise.all([
          apiFetch(testsUrl),
          apiFetch(`/api/polygon-config?path=${encodeURIComponent(problemDirPath)}`)
        ]);
        const [testsData, configData] = await Promise.all([testsResponse.json(), configResponse.json()]);
        const details: TestDetail[] = testsData.success && testsData.data ? testsData.data : [];
        setTestDetails(details);

        const loaded: PolygonConfig = configData.success && configData.data
          ? {
              enableGroups: configData.data.enableGroups ?? false,
              tests: { ...(configData.data.tests ?? {}) },
              groups: { ...(configData.data.groups ?? {}) }
            }
          : createEmptyPolygonConfig();
        for (const test of details) {
          loaded.tests[test.name] ??= { points: initialConfig.defaultScore ?? 1 };
        }
        setPolygonConfig(loaded);

        if (configData.success && configData.data) {
          setConfig(previous => ({
            ...previous,
            ...configData.data,
            checkerType: configData.data.checkerType || previous.checkerType || "C1",
            compile: normalizeCompileConfig(configData.data.compile ?? previous.compile),
          }));
          setUseStdIn(configData.data.useStdIn ?? configData.data.useStdIO ?? false);
          setUseStdOut(configData.data.useStdOut ?? configData.data.useStdIO ?? false);
          setInputFile(configData.data.inputFile || `${problemName}.inp`);
          setOutputFile(configData.data.outputFile || `${problemName}.out`);
        }
      } catch (error) {
        console.error("Failed to fetch test folders", error);
        setLoadError(error instanceof Error ? error.message : "Failed to load problem configuration.");
      } finally {
        setIsLoading(false);
      }
    };
    void load();
  }, [problemDirPath, problemName]);

  const totalPoints = useMemo(
    () => (Object.values(polygonConfig.tests) as PolygonTestConfig[]).reduce((total, test) => total + (test.points || 0), 0),
    [polygonConfig.tests]
  );

  const toggleTest = (name: string) => {
    setSelectedTests(previous => {
      const next = new Set(previous);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleAllTests = () => {
    setSelectedTests(previous => previous.size === testDetails.length
      ? new Set()
      : new Set(testDetails.map(test => test.name)));
  };

  const applyEdit = (edit: TestEditPopover, input: string) => {
    setPolygonConfig(previous => applyTestEdit(previous, edit, input, selectedTests));
    if (edit.type.startsWith("batch")) setSelectedTests(new Set());
  };

  const addDependency = (groupName: string, dependency: string) => {
    if (groupName === dependency) return;
    if (createsGroupCycle(polygonConfig.groups, groupName, dependency)) {
      alert("Cannot add dependency because of cyclic dependence");
      return;
    }
    setPolygonConfig(previous => setGroupDependency(previous, groupName, dependency, true));
  };

  const removeDependency = (groupName: string, dependency: string) => {
    setPolygonConfig(previous => setGroupDependency(previous, groupName, dependency, false));
  };

  const save = async () => {
    setIsSaving(true);
    setSaveError("");
    try {
      const configToSave = {
        ...polygonConfig,
        checkerType: config.checkerType || "C1",
        memoryLimit: config.memoryLimit ?? 256,
        totalScore: config.totalScore ?? null,
        defaultScore: config.defaultScore ?? 1,
        testScores: config.testScores ?? {},
        useStdIn,
        useStdOut,
        inputFile,
        outputFile,
        compile: normalizeCompileConfig(config.compile),
      };
      await apiFetch("/api/polygon-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: problemDirPath, config: configToSave })
      });
      onSave(problemName, {
        ...config,
        checkerType: config.checkerType || "C1",
        useStdIn,
        useStdOut,
        inputFile,
        outputFile,
        compile: normalizeCompileConfig(config.compile),
        polygonConfig: configToSave
      });
      onClose();
    } catch (error) {
      console.error(error);
      setSaveError(error instanceof Error ? error.message : "Failed to save configuration.");
    } finally {
      setIsSaving(false);
    }
  };

  return {
    config,
    setConfig,
    polygonConfig,
    setPolygonConfig,
    testDetails,
    selectedTests,
    isLoading,
    isSaving,
    loadError,
    saveError,
    useStdIn,
    setUseStdIn,
    useStdOut,
    setUseStdOut,
    inputFile,
    setInputFile,
    outputFile,
    setOutputFile,
    totalPoints,
    toggleTest,
    toggleAllTests,
    applyEdit,
    addDependency,
    removeDependency,
    save
  };
}
