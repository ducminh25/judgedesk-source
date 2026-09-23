import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../api";
import { PolygonConfig, PolygonTestConfig, ProblemConfig } from "../../types";
import { normalizeCompileConfig } from "../../../shared/compile-config.js";
import {
  addRational,
  createRational,
  formatRational,
  parseRational,
} from "../../../shared/rational";
import {
  applyTestEdit,
  createEmptyPolygonConfig,
  createsGroupCycle,
  distributeTotalScore,
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

        const loadedTotalScore = configData.data?.totalScore ?? initialConfig.totalScore;
        const currentSum = details.reduce(
          (acc, test) => addRational(acc, parseRational(loaded.tests[test.name]?.points)),
          createRational(0)
        );
        let resolvedTotalScore: string | null = null;
        if (loadedTotalScore !== null && loadedTotalScore !== undefined && String(loadedTotalScore).trim() !== "") {
          const loadedTotalRat = parseRational(loadedTotalScore);
          resolvedTotalScore = formatRational(loadedTotalRat);
          if (details.length > 0 && (currentSum.n !== loadedTotalRat.n || currentSum.d !== loadedTotalRat.d)) {
            const distributed = distributeTotalScore(loaded, loadedTotalScore, details.map(d => d.name));
            Object.assign(loaded.tests, distributed.tests);
          }
        } else if (details.length > 0 && currentSum.n > 0) {
          resolvedTotalScore = formatRational(currentSum);
        }
        setPolygonConfig(loaded);

        if (configData.success && configData.data) {
          setConfig(previous => ({
            ...previous,
            ...configData.data,
            totalScore: resolvedTotalScore ?? previous.totalScore ?? null,
            checkerType: configData.data.checkerType || previous.checkerType || "C1",
            compile: normalizeCompileConfig(configData.data.compile ?? previous.compile),
            isInteractive: configData.data.isInteractive ?? previous.isInteractive ?? false,
            interactor: configData.data.interactor || previous.interactor || "interactor.cpp",
          }));
          setUseStdIn(configData.data.useStdIn ?? configData.data.useStdIO ?? false);
          setUseStdOut(configData.data.useStdOut ?? configData.data.useStdIO ?? false);
          setInputFile(configData.data.inputFile || `${problemName}.inp`);
          setOutputFile(configData.data.outputFile || `${problemName}.out`);
        } else if (resolvedTotalScore !== null) {
          setConfig(previous => ({ ...previous, totalScore: resolvedTotalScore }));
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
    () => {
      const rat = (Object.values(polygonConfig.tests) as PolygonTestConfig[]).reduce(
        (total, test) => addRational(total, parseRational(test.points)),
        createRational(0)
      );
      return formatRational(rat);
    },
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

  const setTotalScore = (val: string | null) => {
    setConfig(previous => ({ ...previous, totalScore: val }));
    if (val !== null && val.trim() !== "" && testDetails.length > 0) {
      setPolygonConfig(previous => distributeTotalScore(previous, val, testDetails.map(t => t.name)));
    }
  };

  const applyEdit = (edit: TestEditPopover, input: string) => {
    setPolygonConfig(previous => {
      const next = applyTestEdit(previous, edit, input, selectedTests);
      if (edit.type === "points" || edit.type === "batchPoints") {
        const nextSum = testDetails.reduce(
          (acc, test) => addRational(acc, parseRational(next.tests[test.name]?.points)),
          createRational(0)
        );
        setConfig(cfg => ({ ...cfg, totalScore: formatRational(nextSum) }));
      }
      return next;
    });
    if (edit.type.startsWith("batch")) setSelectedTests(new Set());
  };

  const addDependency = (groupName: string, dependency: string) => {
    if (groupName === dependency) return;
    if (createsGroupCycle(polygonConfig.groups, groupName, dependency)) {
      setSaveError("Không thể thêm phụ thuộc vì sẽ tạo ra vòng lặp chu trình (cyclic dependency).");
      return;
    }
    setSaveError("");
    setPolygonConfig(previous => setGroupDependency(previous, groupName, dependency, true));
  };

  const removeDependency = (groupName: string, dependency: string) => {
    setPolygonConfig(previous => setGroupDependency(previous, groupName, dependency, false));
  };

  const save = async () => {
    setIsSaving(true);
    setSaveError("");
    try {
      const finalTotalScore = config.totalScore !== null && config.totalScore !== undefined && String(config.totalScore).trim() !== ""
        ? config.totalScore
        : totalPoints;
      const testScores: Record<string, number | string> = {};
      for (const [name, testCfg] of Object.entries(polygonConfig.tests) as [string, PolygonTestConfig][]) {
        if (testCfg.points !== undefined) {
          testScores[name] = testCfg.points;
        }
      }
      const configToSave = {
        ...polygonConfig,
        checkerType: config.checkerType || "C1",
        memoryLimit: config.memoryLimit ?? 256,
        totalScore: finalTotalScore,
        defaultScore: config.defaultScore ?? 1,
        testScores,
        useStdIn,
        useStdOut,
        inputFile,
        outputFile,
        compile: normalizeCompileConfig(config.compile),
        isInteractive: config.isInteractive ?? false,
        interactor: config.interactor || "interactor.cpp",
      };
      await apiFetch("/api/polygon-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: problemDirPath, config: configToSave })
      });
      onSave(problemName, {
        ...config,
        totalScore: finalTotalScore,
        checkerType: config.checkerType || "C1",
        useStdIn,
        useStdOut,
        inputFile,
        outputFile,
        compile: normalizeCompileConfig(config.compile),
        isInteractive: config.isInteractive ?? false,
        interactor: config.interactor || "interactor.cpp",
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
    setTotalScore,
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
