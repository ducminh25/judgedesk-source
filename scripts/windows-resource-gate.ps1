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
$peakPrivateMemoryBytes = 0L
$peakCpuOneCorePercent = 0.0
$peakCpuMachinePercent = 0.0
$peakByProcess = @{}
$peakPrivateByProcess = @{}
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
    $privateMemory = 0L
    $cpuDeltaSeconds = 0.0
    $currentCpuByPid = @{}

    foreach ($processId in $ids) {
        try {
            $process = Get-Process -Id $processId -ErrorAction Stop
            $workingSet += [int64]$process.WorkingSet64
            $privateMemory += [int64]$process.PrivateMemorySize64
            $name = $process.ProcessName
            if (-not $script:peakByProcess.ContainsKey($name) -or $process.WorkingSet64 -gt $script:peakByProcess[$name]) {
                $script:peakByProcess[$name] = [int64]$process.WorkingSet64
            }
            if (-not $script:peakPrivateByProcess.ContainsKey($name) -or $process.PrivateMemorySize64 -gt $script:peakPrivateByProcess[$name]) {
                $script:peakPrivateByProcess[$name] = [int64]$process.PrivateMemorySize64
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
    $script:peakPrivateMemoryBytes = [Math]::Max($script:peakPrivateMemoryBytes, $privateMemory)
    $oneCorePercent = 100.0 * $cpuDeltaSeconds / $elapsedSeconds
    $machinePercent = $oneCorePercent / [Math]::Max(1, $script:logicalProcessors)
    $script:peakCpuOneCorePercent = [Math]::Max($script:peakCpuOneCorePercent, $oneCorePercent)
    $script:peakCpuMachinePercent = [Math]::Max($script:peakCpuMachinePercent, $machinePercent)
}

$previousApiToken = $env:JUDGEDESK_API_TOKEN
$apiTokenBytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $rng.GetBytes($apiTokenBytes)
} finally {
    $rng.Dispose()
}
$apiToken = -join ($apiTokenBytes | ForEach-Object { $_.ToString("x2") })
$sessionHeaders = @{ "X-JudgeDesk-Session" = $apiToken }
$env:JUDGEDESK_API_TOKEN = $apiToken

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
        $listeners = @(
            Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
                Where-Object {
                    $_.OwningProcess -in $treeIds -and
                    $_.LocalAddress -in @("127.0.0.1", "::1")
                }
        )
        foreach ($listener in $listeners) {
            try {
                $status = Invoke-RestMethod `
                    -Uri "http://127.0.0.1:$($listener.LocalPort)/api/status" `
                    -Headers $sessionHeaders `
                    -TimeoutSec 2
                if ($status.build.appVersion) {
                    $serverPort = [int]$listener.LocalPort
                    break
                }
            } catch {
                # WebView and updater listeners are not the JudgeDesk backend.
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

    $configFile = Join-Path $stressPath "test\A_plus_B\Config.cfg"
    $configuredMemoryLimitMiB = 256
    if (Test-Path -LiteralPath $configFile) {
        try {
            $parsedConfig = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
            if ($null -ne $parsedConfig.memoryLimit -and [double]$parsedConfig.memoryLimit -gt 0) {
                $configuredMemoryLimitMiB = [Math]::Min(1024, [Math]::Max(8, [int][Math]::Round([double]$parsedConfig.memoryLimit)))
            }
        } catch {
            $configuredMemoryLimitMiB = 256
        }
    }
    $workloadProfile = if ($configuredMemoryLimitMiB -le 512) { "S256_S512" } else { "SMAX" }
    $appHostBudgetMiB = 384
    $appHostWorkingSetCeilingMiB = 768
    if (-not $PSBoundParameters.ContainsKey("BudgetMiB")) {
        $BudgetMiB = if ($workloadProfile -eq "S256_S512") { 1024 } else { 1408 }
    }
    $privateBudgetMiB = $BudgetMiB
    $workingSetBudgetMiB = if ($workloadProfile -eq "SMAX" -and $BudgetMiB -eq 1408) { 1792 } else { $BudgetMiB }
    $privateBudgetBytes = [int64]$privateBudgetMiB * 1024 * 1024
    $workingSetBudgetBytes = [int64]$workingSetBudgetMiB * 1024 * 1024
    $representative1024Bytes = 1024L * 1024 * 1024
    $withinRepresentative1024MiB = ($peakWorkingSetBytes -lt $representative1024Bytes) -and ($peakPrivateMemoryBytes -lt $representative1024Bytes)
    $privateMemoryGatePassed = if ($workloadProfile -eq "SMAX" -and $BudgetMiB -eq 1408) {
        ($peakPrivateMemoryBytes -le $privateBudgetBytes)
    } else {
        ($peakPrivateMemoryBytes -lt $privateBudgetBytes)
    }
    $workingSetGatePassed = if ($workloadProfile -eq "SMAX" -and $BudgetMiB -eq 1408) {
        ($peakWorkingSetBytes -le $workingSetBudgetBytes)
    } else {
        ($peakWorkingSetBytes -lt $workingSetBudgetBytes)
    }
    $memoryGatePassed = $privateMemoryGatePassed -and $workingSetGatePassed
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
        workloadProfile = $workloadProfile
        configuredMemoryLimitMiB = $configuredMemoryLimitMiB
        appHostBudgetMiB = $appHostBudgetMiB
        appHostWorkingSetCeilingMiB = $appHostWorkingSetCeilingMiB
        sampleIntervalMs = $SampleIntervalMs
        sampleCount = $sampleCount
        combinedPeakPrivateBytes = $peakPrivateMemoryBytes
        combinedPeakPrivateMiB = [Math]::Round($peakPrivateMemoryBytes / 1MB, 2)
        privateBudgetMiB = $privateBudgetMiB
        privateMemoryGatePassed = $privateMemoryGatePassed
        combinedPeakWorkingSetBytes = $peakWorkingSetBytes
        combinedPeakWorkingSetMiB = [Math]::Round($peakWorkingSetBytes / 1MB, 2)
        workingSetBudgetMiB = $workingSetBudgetMiB
        workingSetGatePassed = $workingSetGatePassed
        budgetMiB = $BudgetMiB
        withinRepresentative1024MiB = $withinRepresentative1024MiB
        memoryGatePassed = $memoryGatePassed
        peakCpuOneCorePercent = [Math]::Round($peakCpuOneCorePercent, 2)
        peakCpuMachinePercent = [Math]::Round($peakCpuMachinePercent, 2)
        processPeakPrivateMiB = [ordered]@{}
        processPeakWorkingSetMiB = [ordered]@{}
    }
    foreach ($entry in ($peakPrivateByProcess.GetEnumerator() | Sort-Object Name)) {
        $report.processPeakPrivateMiB[$entry.Name] = [Math]::Round([int64]$entry.Value / 1MB, 2)
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
- Workload profile (C03): **$($report.workloadProfile)** (configured memoryLimit: **$($report.configuredMemoryLimitMiB) MiB**, app/host private budget: **$($report.appHostBudgetMiB) MiB**, host working-set ceiling: **$($report.appHostWorkingSetCeilingMiB) MiB**)
- Sampling: $($report.sampleCount) samples, every $($report.sampleIntervalMs) ms
- Combined peak private committed memory: **$($report.combinedPeakPrivateMiB) MiB** (budget: **$($report.privateBudgetMiB) MiB**, passed: **$($report.privateMemoryGatePassed)**)
- Combined peak working set: **$($report.combinedPeakWorkingSetMiB) MiB** (budget: **$($report.workingSetBudgetMiB) MiB**, passed: **$($report.workingSetGatePassed)**)
- Within representative `< 1024 MiB`: **$($report.withinRepresentative1024MiB)**
- Memory gate: **$(if ($report.memoryGatePassed) { "PASS" } else { "FAIL" })**
- Peak aggregate CPU: $($report.peakCpuOneCorePercent)% of one core
  ($($report.peakCpuMachinePercent)% of $($report.logicalProcessors) logical processors)

This conservative measurement sums both the private committed memory (`PrivateMemorySize64`)
and the un-deduplicated working set (`WorkingSet64`) of the packaged Tauri app,
WebView processes, backend, native executor, compiler and active submission.
The stress driver itself is excluded.
"@ | Set-Content -LiteralPath $markdownPath -Encoding utf8

    $report | ConvertTo-Json -Depth 6
    if (-not $report.memoryGatePassed) {
        throw "Packaged judging peak exceeded the Windows C03 resource envelope (profile: $workloadProfile, private: $($report.combinedPeakPrivateMiB)/$privateBudgetMiB MiB, workingSet: $($report.combinedPeakWorkingSetMiB)/$workingSetBudgetMiB MiB)."
    }
} finally {
    $env:JUDGEDESK_API_TOKEN = $previousApiToken
    if ($serverPort) {
        try {
            Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$serverPort/api/shutdown" -Headers $sessionHeaders -TimeoutSec 5 | Out-Null
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
