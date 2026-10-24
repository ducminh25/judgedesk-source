import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiFetch } from "../../api";
import { PolygonConfig, PolygonTestConfig, ProblemConfig } from "../../types";
import { normalizeCompileConfig } from "../../../shared/compile-config.js";
import { reconcileStoredProblemConfig } from "../../../shared/problem-config.js";
import type { ProblemWellFormedIssue, TestInputValidationResult } from "../../../shared/contracts.js";
import {
  addRational,
  createRational,
  formatRational,
  parseRational,
} from "../../../shared/rational";
import {
  applyTestEdit,
  assignTestsToGroup,
  createEmptyPolygonConfig,
  createsGroupCycle,
  distributeTotalScore,
  editGroupTests,
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

function sumVisiblePoints(config: PolygonConfig, details: readonly TestDetail[]): string {
  return formatRational(details.reduce(
    (total, test) => addRational(total, parseRational(Object.hasOwn(config.tests, test.name) ? config.tests[test.name].points : 1)),
    createRational(0),
  ));
}

export function useProblemConfigEditor({ problemName, testPath, initialConfig, onSave, onClose }: EditorOptions) {
  const { t } = useTranslation();
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
  const [wellFormedIssues, setWellFormedIssues] = useState<ProblemWellFormedIssue[]>([]);
  const [wellFormedChecking, setWellFormedChecking] = useState(false);
  const [wellFormedChecked, setWellFormedChecked] = useState(false);
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

        const reconciledData = configData.success && configData.data
          ? reconcileStoredProblemConfig(configData.data, details.map((d) => d.name)).config
          : null;

        const loaded: PolygonConfig = reconciledData
          ? {
              enableGroups: reconciledData.enableGroups ?? false,
              tests: Object.fromEntries(
                details
                  .filter((test) => reconciledData.tests && Object.hasOwn(reconciledData.tests, test.name))
                  .map((test) => [test.name, { ...reconciledData.tests![test.name] }]),
              ),
              groups: { ...(reconciledData.groups ?? {}) }
            }
          : createEmptyPolygonConfig();
        const fallbackPoint = reconciledData?.defaultScore ?? initialConfig.defaultScore ?? 1;
        for (const test of details) {
          if (!Object.hasOwn(loaded.tests, test.name)) {
            Object.defineProperty(loaded.tests, test.name, { value: { points: fallbackPoint }, enumerable: true, configurable: true, writable: true });
          }
        }

        const loadedTotalScore = reconciledData !== null && reconciledData.totalScore !== undefined
          ? reconciledData.totalScore
          : initialConfig.totalScore;
        const currentSum = details.reduce(
          (acc, test) => addRational(acc, parseRational(loaded.tests[test.name]?.points)),
          createRational(0)
        );
        let resolvedTotalScore: string | null = null;
        if (loadedTotalScore !== null && loadedTotalScore !== undefined && String(loadedTotalScore).trim() !== "") {
          const loadedTotalRat = parseRational(loadedTotalScore);
          resolvedTotalScore = formatRational(loadedTotalRat);
          if (details.length > 0 && BigInt(loadedTotalRat.n) > 0n && (currentSum.n !== loadedTotalRat.n || currentSum.d !== loadedTotalRat.d)) {
            const distributed = distributeTotalScore(loaded, loadedTotalScore, details.map(d => d.name));
            Object.assign(loaded.tests, distributed.tests);
          }
        }
        setPolygonConfig(loaded);

        if (reconciledData) {
          setConfig(previous => ({
            ...previous,
            ...reconciledData,
            totalScore: resolvedTotalScore,
            checkerType: reconciledData.checkerType || previous.checkerType || "C1",
            compile: normalizeCompileConfig(reconciledData.compile ?? previous.compile),
            isInteractive: reconciledData.isInteractive ?? previous.isInteractive ?? false,
            interactor: reconciledData.interactor || previous.interactor || "interactor.cpp",
          }));
          setUseStdIn(reconciledData.useStdIn ?? reconciledData.useStdIO ?? false);
          setUseStdOut(reconciledData.useStdOut ?? reconciledData.useStdIO ?? false);
          setInputFile(reconciledData.inputFile || `${problemName}.inp`);
          setOutputFile(reconciledData.outputFile || `${problemName}.out`);
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
      return sumVisiblePoints(polygonConfig, testDetails);
    },
    [polygonConfig.tests, testDetails]
  );

  const updateGroups = (next: PolygonConfig) => {
    setPolygonConfig(next);
    setConfig(previous => ({ ...previous, totalScore: sumVisiblePoints(next, testDetails) }));
    setSaveError("");
  };

  const assignGroup = (testNames: readonly string[], groupName: string) => {
    updateGroups(assignTestsToGroup(polygonConfig, testNames, groupName));
  };

  const editGroup = (groupName: string, testNames: readonly string[], total?: string) => {
    updateGroups(editGroupTests(polygonConfig, groupName, testNames, total));
  };

  const validateWellFormed = async (): Promise<boolean> => {
    setWellFormedChecking(true);
    setWellFormedChecked(false);
    try {
      const response = await apiFetch("/api/polygon-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: problemDirPath, config: { testWellFormed: true, isInteractive: config.isInteractive ?? false }, validateOnly: true }),
      });
      const body: { success: boolean; data: TestInputValidationResult } = await response.json();
      if (!body.success || !Array.isArray(body.data?.issues)) throw new Error("Failed to validate test inputs.");
      const issues = body.data.issues;
      setWellFormedIssues(issues);
      setWellFormedChecked(true);
      return issues.length === 0;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Failed to validate test inputs.");
      return false;
    } finally {
      setWellFormedChecking(false);
    }
  };

  useEffect(() => {
    if (config.testWellFormed) void validateWellFormed();
    else { setWellFormedIssues([]); setWellFormedChecked(false); setSaveError(""); }
  }, [config.testWellFormed, config.isInteractive, problemDirPath]);

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
      if (config.testWellFormed && !await validateWellFormed()) {
        setSaveError(t("problemConfig.wellFormedSaveBlocked"));
        return;
      }
      if (polygonConfig.enableGroups) {
        for (const name of Object.keys(polygonConfig.groups)) {
          for (const dependency of polygonConfig.groups[name].dependencies) {
            if (!Object.hasOwn(polygonConfig.groups, dependency)
              || !testDetails.some(test => polygonConfig.tests[test.name]?.group === dependency)) {
              setSaveError(t("problemConfig.groupDependencyBlocked", { name, dependency }));
              return;
            }
          }
        }
      }
      const finalTotalScore = config.totalScore !== null && config.totalScore !== undefined && String(config.totalScore).trim() !== ""
        ? config.totalScore
        : null;
      const testScores: Record<string, number | string> = {};
      for (const [name, testCfg] of Object.entries(polygonConfig.tests) as [string, PolygonTestConfig][]) {
        if (testCfg.points !== undefined) {
          testScores[name] = testCfg.points;
        }
      }
      const configToSave = {
        ...polygonConfig,
        ...(config.timeLimit !== undefined ? { timeLimit: config.timeLimit } : {}),
        testWellFormed: config.testWellFormed ?? false,
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
    wellFormedIssues,
    wellFormedChecking,
    wellFormedChecked,
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
    assignGroup,
    editGroup,
    validateWellFormed,
    addDependency,
    removeDependency,
    save
  };
}
