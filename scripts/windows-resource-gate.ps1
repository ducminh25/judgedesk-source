param(
    [Parameter(Mandatory = $true)]
    [string]$AppExecutable,
    [Parameter(Mandatory = $true)]
    [string]$StressRoot,
    [int]$BudgetMiB = 1024,
    [int]$SampleIntervalMs = 100,
    [string]$ReportDirectory = "docs\benchmarks"
)

$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
    throw "The packaged resource gate is Windows-only."
}

$appPath = (Resolve-Path -LiteralPath $AppExecutable).Path
$stressPath = (Resolve-Path -LiteralPath $StressRoot).Path
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$reportRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $ReportDirectory))
New-Item -ItemType Directory -Path $reportRoot -Force | Out-Null

$stdoutLog = Join-Path $env:TEMP "judgedesk-resource-gate.stdout.log"
$stderrLog = Join-Path $env:TEMP "judgedesk-resource-gate.stderr.log"
$app = $null
$runner = $null
$serverPort = $null
$peakWorkingSetBytes = 0L
$peakCpuOneCorePercent = 0.0
$peakCpuMachinePercent = 0.0
$peakByProcess = @{}
$sampleCount = 0
$logicalProcessors = [Environment]::ProcessorCount
$lastCpuByPid = @{}
$lastSampleSeconds = 0.0
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

function Get-DescendantProcessIds {
    param([int]$RootProcessId)

    $snapshot = @(Get-CimInstance Win32_Process)
    $ids = [System.Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add($RootProcessId)
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($process in $snapshot) {
            if ($ids.Contains([int]$process.ParentProcessId) -and $ids.Add([int]$process.ProcessId)) {
                $changed = $true
            }
        }
    }
    return @($ids)
}

function Measure-JudgeDeskTree {
    param([int]$RootProcessId)

    $script:sampleCount++
    $nowSeconds = $script:stopwatch.Elapsed.TotalSeconds
    $elapsedSeconds = [Math]::Max(0.001, $nowSeconds - $script:lastSampleSeconds)
    $script:lastSampleSeconds = $nowSeconds
    $ids = Get-DescendantProcessIds -RootProcessId $RootProcessId
    $workingSet = 0L
    $cpuDeltaSeconds = 0.0
    $currentCpuByPid = @{}

    foreach ($processId in $ids) {
        try {
            $process = Get-Process -Id $processId -ErrorAction Stop
            $workingSet += [int64]$process.WorkingSet64
            $name = $process.ProcessName
            if (-not $script:peakByProcess.ContainsKey($name) -or $process.WorkingSet64 -gt $script:peakByProcess[$name]) {
                $script:peakByProcess[$name] = [int64]$process.WorkingSet64
            }
            $cpuSeconds = $process.TotalProcessorTime.TotalSeconds
            $currentCpuByPid[$processId] = $cpuSeconds
            if ($script:lastCpuByPid.ContainsKey($processId)) {
                $cpuDeltaSeconds += [Math]::Max(0.0, $cpuSeconds - $script:lastCpuByPid[$processId])
            }
        } catch {
            # Short-lived compiler/submission processes may exit between snapshots.
        }
    }

    $script:lastCpuByPid = $currentCpuByPid
    $script:peakWorkingSetBytes = [Math]::Max($script:peakWorkingSetBytes, $workingSet)
    $oneCorePercent = 100.0 * $cpuDeltaSeconds / $elapsedSeconds
    $machinePercent = $oneCorePercent / [Math]::Max(1, $script:logicalProcessors)
    $script:peakCpuOneCorePercent = [Math]::Max($script:peakCpuOneCorePercent, $oneCorePercent)
    $script:peakCpuMachinePercent = [Math]::Max($script:peakCpuMachinePercent, $machinePercent)
}

try {
    $app = Start-Process `
        -FilePath $appPath `
        -WorkingDirectory (Split-Path -Parent $appPath) `
        -WindowStyle Hidden `
        -PassThru

    for ($attempt = 0; $attempt -lt 120 -and -not $serverPort; $attempt++) {
        if ($app.HasExited) {
            throw "Packaged JudgeDesk exited before its backend became ready (exit $($app.ExitCode))."
        }
        Measure-JudgeDeskTree -RootProcessId $app.Id
        $treeIds = Get-DescendantProcessIds -RootProcessId $app.Id
        foreach ($processId in $treeIds) {
            $listener = Get-NetTCPConnection -OwningProcess $processId -State Listen -ErrorAction SilentlyContinue |
                Where-Object { $_.LocalAddress -in @("127.0.0.1", "::1") } |
                Select-Object -First 1
            if ($listener) {
                try {
                    $status = Invoke-RestMethod -Uri "http://127.0.0.1:$($listener.LocalPort)/api/status" -TimeoutSec 2
                    if ($status.build.appVersion) {
                        $serverPort = [int]$listener.LocalPort
                        break
                    }
                } catch {
                    # WebView and updater listeners are not the JudgeDesk backend.
                }
            }
        }
        if (-not $serverPort) {
            Start-Sleep -Milliseconds $SampleIntervalMs
        }
    }
    if (-not $serverPort) {
        throw "Packaged JudgeDesk backend did not become ready."
    }

    $previousStressRoot = $env:STRESS_TEST_ROOT
    $previousServerUrl = $env:JUDGE_SERVER_URL
    $previousCases = $env:STRESS_CASES
    $previousSecurity = $env:STRESS_INCLUDE_SECURITY
    $env:STRESS_TEST_ROOT = $stressPath
    $env:JUDGE_SERVER_URL = "http://127.0.0.1:$serverPort"
    # Exercise the C++ compiler with a CE case, then use managed Python for the
    # active memory/CPU workloads. Defender ML can quarantine fresh unsigned
    # MinGW PE files launched by an unsigned local-build executor (Wacatac false
    # positive), which measures local package reputation rather than JudgeDesk's
    # resource envelope. Public release signing is validated separately.
    $env:STRESS_CASES = "CE_cpp/A_plus_B,MLE_python/A_plus_B,TLE_CPU_python/A_plus_B"
    Remove-Item Env:STRESS_INCLUDE_SECURITY -ErrorAction SilentlyContinue
    try {
        $runner = Start-Process `
            -FilePath "npm.cmd" `
            -ArgumentList @("run", "test:stress") `
            -WorkingDirectory $repoRoot `
            -RedirectStandardOutput $stdoutLog `
            -RedirectStandardError $stderrLog `
            -WindowStyle Hidden `
            -PassThru
        while (-not $runner.HasExited) {
            if ($app.HasExited) {
                throw "Packaged JudgeDesk exited during the resource workload."
            }
            Measure-JudgeDeskTree -RootProcessId $app.Id
            Start-Sleep -Milliseconds $SampleIntervalMs
            $runner.Refresh()
        }
        $runner.WaitForExit()
        $runner.Refresh()
        Measure-JudgeDeskTree -RootProcessId $app.Id
        $stdoutText = if (Test-Path -LiteralPath $stdoutLog) {
            Get-Content -LiteralPath $stdoutLog -Raw
        } else {
            ""
        }
        $stderrText = if (Test-Path -LiteralPath $stderrLog) {
            [string](Get-Content -LiteralPath $stderrLog -Raw)
        } else {
            ""
        }
        $passCount = ([regex]::Matches($stdoutText, "(?m)^PASS ")).Count
        $hasKnownNonzeroExit = $null -ne $runner.ExitCode -and $runner.ExitCode -ne 0
        $stderrHasText = -not [string]::IsNullOrWhiteSpace([string]$stderrText)
        if ($hasKnownNonzeroExit -or $passCount -ne 3 -or $stderrHasText) {
            throw "Stress workload failed with exit $($runner.ExitCode): $stderrText"
        }
    } finally {
        $env:STRESS_TEST_ROOT = $previousStressRoot
        $env:JUDGE_SERVER_URL = $previousServerUrl
        $env:STRESS_CASES = $previousCases
        $env:STRESS_INCLUDE_SECURITY = $previousSecurity
    }

    $budgetBytes = [int64]$BudgetMiB * 1024 * 1024
    $report = [ordered]@{
        generatedAt = (Get-Date).ToUniversalTime().ToString("o")
        appExecutable = [IO.Path]::GetFileName($appPath)
        appVersion = $status.build.appVersion
        platform = $status.platform
        arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
        logicalProcessors = $logicalProcessors
        workload = @(
            "CE_cpp/A_plus_B",
            "MLE_python/A_plus_B",
            "TLE_CPU_python/A_plus_B"
        )
        sampleIntervalMs = $SampleIntervalMs
        sampleCount = $sampleCount
        combinedPeakWorkingSetBytes = $peakWorkingSetBytes
        combinedPeakWorkingSetMiB = [Math]::Round($peakWorkingSetBytes / 1MB, 2)
        budgetMiB = $BudgetMiB
        memoryGatePassed = ($peakWorkingSetBytes -lt $budgetBytes)
        peakCpuOneCorePercent = [Math]::Round($peakCpuOneCorePercent, 2)
        peakCpuMachinePercent = [Math]::Round($peakCpuMachinePercent, 2)
        processPeakWorkingSetMiB = [ordered]@{}
    }
    foreach ($entry in ($peakByProcess.GetEnumerator() | Sort-Object Name)) {
        $report.processPeakWorkingSetMiB[$entry.Name] = [Math]::Round([int64]$entry.Value / 1MB, 2)
    }

    $jsonPath = Join-Path $reportRoot "windows-packaged-resource-gate.json"
    $markdownPath = Join-Path $reportRoot "windows-packaged-resource-gate.md"
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $jsonPath -Encoding utf8
    @"
# Windows packaged judging resource gate

- Generated: $($report.generatedAt)
- App: JudgeDesk $($report.appVersion)
- Workload: C++ compile/CE + managed Python MLE + CPU-loop TLE
- Sampling: $($report.sampleCount) samples, every $($report.sampleIntervalMs) ms
- Combined peak working set: **$($report.combinedPeakWorkingSetMiB) MiB**
- Budget: **$($report.budgetMiB) MiB**
- Memory gate: **$(if ($report.memoryGatePassed) { "PASS" } else { "FAIL" })**
- Peak aggregate CPU: $($report.peakCpuOneCorePercent)% of one core
  ($($report.peakCpuMachinePercent)% of $($report.logicalProcessors) logical processors)

This conservative measurement sums the working set of the packaged Tauri app,
WebView processes, backend, native executor, compiler and active submission.
The stress driver itself is excluded.
"@ | Set-Content -LiteralPath $markdownPath -Encoding utf8

    $report | ConvertTo-Json -Depth 6
    if (-not $report.memoryGatePassed) {
        throw "Packaged judging peak exceeded the $BudgetMiB MiB Windows budget."
    }
} finally {
    if ($serverPort) {
        try {
            Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$serverPort/api/shutdown" -TimeoutSec 5 | Out-Null
        } catch {
            # The app process cleanup below is authoritative.
        }
    }
    if ($app -and -not $app.HasExited) {
        [void]$app.CloseMainWindow()
        if (-not $app.WaitForExit(5000)) {
            Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
        }
    }
}
