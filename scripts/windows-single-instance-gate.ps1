[CmdletBinding()]
param(
    [string]$ExecutablePath = "",
    [ValidateRange(1, 100)]
    [int]$SequentialLaunches = 20,
    [ValidateRange(10, 120)]
    [int]$StartupTimeoutSeconds = 40
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($ExecutablePath)) {
    $ExecutablePath = Join-Path $PSScriptRoot "..\src-tauri\target\debug\themis-v2.exe"
}
$ExecutablePath = [System.IO.Path]::GetFullPath($ExecutablePath)
if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
    throw "JudgeDesk executable was not found: $ExecutablePath"
}

$targetName = [System.IO.Path]::GetFileName($ExecutablePath)
$runtimeBinaryDirectory = Join-Path $PSScriptRoot "..\src-tauri\binaries"
$expectedRuntimePaths = @(
    $ExecutablePath
    (Join-Path ([System.IO.Path]::GetDirectoryName($ExecutablePath)) "server.exe")
    (Join-Path ([System.IO.Path]::GetDirectoryName($ExecutablePath)) "judgedesk-executor.exe")
    (Join-Path $runtimeBinaryDirectory "server-x86_64-pc-windows-msvc.exe")
    (Join-Path $runtimeBinaryDirectory "judgedesk-executor-x86_64-pc-windows-msvc.exe")
) | ForEach-Object { [System.IO.Path]::GetFullPath($_) }
$conflictingNames = @($targetName, "JudgeDesk.exe", "themis-v2.exe") |
    Select-Object -Unique
$conflicts = @(
    Get-CimInstance Win32_Process |
        Where-Object {
            $_.Name -in $conflictingNames -or
            (
                -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
                $_.ExecutablePath -iin $expectedRuntimePaths
            )
        }
)
if ($conflicts.Count -gt 0) {
    $details = $conflicts |
        ForEach-Object { "$($_.Name) pid=$($_.ProcessId) path=$($_.ExecutablePath)" }
    throw "Close existing JudgeDesk processes before this destructive crash gate:`n$($details -join "`n")"
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JudgeDeskSingleInstanceWindowProbe {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@

$ownedProcesses = @{}
$ownedPrimaryIdentities = [System.Collections.Generic.List[object]]::new()
$gatePhase = "startup"

function Register-OwnedProcessObject {
    param([System.Diagnostics.Process]$Process)
    try {
        $captureDeadline = [DateTime]::UtcNow.AddSeconds(2)
        $processPath = $null
        do {
            $Process.Refresh()
            if ($Process.HasExited) {
                return $null
            }
            $processPath = $Process.MainModule.FileName
            if (-not [string]::IsNullOrWhiteSpace($processPath)) {
                break
            }
            Start-Sleep -Milliseconds 10
        } while ([DateTime]::UtcNow -lt $captureDeadline)
        if ([string]::IsNullOrWhiteSpace($processPath)) {
            return $null
        }
        $identity = [pscustomobject]@{
            ProcessId = $Process.Id
            StartTimeUtcTicks = $Process.StartTime.ToUniversalTime().Ticks
            Path = [System.IO.Path]::GetFullPath($processPath)
        }
        $key = "$($identity.ProcessId):$($identity.StartTimeUtcTicks)"
        if (-not $ownedProcesses.ContainsKey($key)) {
            $ownedProcesses[$key] = $identity
        }
        return $ownedProcesses[$key]
    } catch {
        return $null
    }
}

function Register-OwnedCimProcess {
    param([object]$CimProcess)
    if ($null -eq $CimProcess) {
        return $null
    }
    $process = $null
    try {
        $process = [System.Diagnostics.Process]::GetProcessById(
            [int]$CimProcess.ProcessId
        )
        $process.Refresh()
        if ($process.HasExited) {
            return $null
        }
        $processStartTicks = $process.StartTime.ToUniversalTime().Ticks
        $snapshotStartTicks =
            $CimProcess.CreationDate.ToUniversalTime().Ticks
        $processPath = $process.MainModule.FileName
        if (
            [Math]::Abs($processStartTicks - $snapshotStartTicks) -gt
                [TimeSpan]::TicksPerMillisecond -or
            [string]::IsNullOrWhiteSpace($CimProcess.ExecutablePath) -or
            $processPath -ine $CimProcess.ExecutablePath
        ) {
            return $null
        }
        return Register-OwnedProcessObject -Process $process
    } catch {
        return $null
    } finally {
        if ($null -ne $process) {
            $process.Dispose()
        }
    }
}

function Get-LiveOwnedProcess {
    param([object]$Identity)
    if ($null -eq $Identity) {
        return $null
    }
    $process = $null
    try {
        $process = [System.Diagnostics.Process]::GetProcessById(
            [int]$Identity.ProcessId
        )
        $process.Refresh()
        if (
            $process.StartTime.ToUniversalTime().Ticks -ne
            [long]$Identity.StartTimeUtcTicks
        ) {
            $process.Dispose()
            return $null
        }
        $currentPath = $process.MainModule.FileName
        if (
            -not [string]::IsNullOrWhiteSpace($Identity.Path) -and
            $currentPath -ine $Identity.Path
        ) {
            $process.Dispose()
            return $null
        }
        return $process
    } catch {
        if ($null -ne $process) {
            $process.Dispose()
        }
        return $null
    }
}

function Test-OwnedProcessAlive {
    param([object]$Identity)
    $process = Get-LiveOwnedProcess -Identity $Identity
    if ($null -eq $process) {
        return $false
    }
    $process.Dispose()
    return $true
}

function Test-StartedProcessAlive {
    param([System.Diagnostics.Process]$Process)
    try {
        $Process.Refresh()
        return -not $Process.HasExited
    } catch {
        return $false
    }
}

function Stop-OwnedProcess {
    param([object]$Identity)
    $process = Get-LiveOwnedProcess -Identity $Identity
    if ($null -eq $process) {
        return
    }
    try {
        $process.Kill()
        if (-not $process.WaitForExit(5000)) {
            Write-Warning (
                "Owned process pid=$($Identity.ProcessId) did not exit within " +
                "the cleanup timeout."
            )
        }
    } catch {
        Write-Warning (
            "Could not clean up owned process pid=$($Identity.ProcessId) " +
            "started=$($Identity.StartTimeUtcTicks): $($_.Exception.Message)"
        )
    } finally {
        $process.Dispose()
    }
}

function Get-ProcessSnapshot {
    return @(Get-CimInstance Win32_Process)
}

function Get-DescendantIds {
    param(
        [object]$RootProcess,
        [array]$Snapshot
    )
    $descendants = [System.Collections.Generic.HashSet[int]]::new()
    $visited = [System.Collections.Generic.HashSet[int]]::new()
    $pending = [System.Collections.Generic.Queue[object]]::new()
    $visited.Add([int]$RootProcess.ProcessId) | Out-Null
    $pending.Enqueue($RootProcess)
    while ($pending.Count -gt 0) {
        $parent = $pending.Dequeue()
        $parentStartTicks = $parent.CreationDate.ToUniversalTime().Ticks
        foreach (
            $child in $Snapshot |
                Where-Object {
                    $_.ParentProcessId -eq $parent.ProcessId
                }
        ) {
            $childStartTicks = $child.CreationDate.ToUniversalTime().Ticks
            if (
                $childStartTicks + [TimeSpan]::TicksPerMillisecond -lt
                $parentStartTicks
            ) {
                continue
            }
            if ($visited.Add([int]$child.ProcessId)) {
                $descendants.Add([int]$child.ProcessId) | Out-Null
                $pending.Enqueue($child)
            }
        }
    }
    return @($descendants)
}

function Get-RuntimeInventory {
    param([object]$PrimaryIdentity)
    $snapshot = Get-ProcessSnapshot
    $primaryProcess =
        $snapshot |
            Where-Object { $_.ProcessId -eq $PrimaryIdentity.ProcessId } |
            Select-Object -First 1
    if ($null -eq $primaryProcess) {
        throw (
            "Owned primary pid=$($PrimaryIdentity.ProcessId) is absent from " +
            "the process snapshot during $gatePhase."
        )
    }
    $snapshotStartTicks =
        $primaryProcess.CreationDate.ToUniversalTime().Ticks
    if (
        [Math]::Abs(
            $snapshotStartTicks - [long]$PrimaryIdentity.StartTimeUtcTicks
        ) -gt [TimeSpan]::TicksPerMillisecond -or
        $primaryProcess.ExecutablePath -ine $PrimaryIdentity.Path
    ) {
        throw (
            "Owned primary pid=$($PrimaryIdentity.ProcessId) changed identity " +
            "during $gatePhase (expected start=" +
            "$($PrimaryIdentity.StartTimeUtcTicks), actual start=" +
            "$snapshotStartTicks, expected path='$($PrimaryIdentity.Path)', " +
            "actual path='$($primaryProcess.ExecutablePath)')."
        )
    }
    $primaryProcessId = [int]$PrimaryIdentity.ProcessId
    $descendantIds = @(
        Get-DescendantIds `
            -RootProcess $primaryProcess `
            -Snapshot $snapshot
    )
    $helpers = @(
        $snapshot | Where-Object {
            $_.ParentProcessId -eq $primaryProcessId -and
            $_.CreationDate.ToUniversalTime().Ticks +
                [TimeSpan]::TicksPerMillisecond -ge $snapshotStartTicks -and
            $_.ExecutablePath -ieq $ExecutablePath -and
            $_.CommandLine -like "*--judgedesk-internal-job-supervisor-v1*"
        }
    )
    $servers = @(
        $snapshot | Where-Object {
            $_.ProcessId -in $descendantIds -and
            $_.Name -like "server*.exe"
        }
    )
    $serverIds = @($servers | Select-Object -ExpandProperty ProcessId)
    $executors = @(
        $snapshot | Where-Object {
            $_.ProcessId -in $descendantIds -and
            $_.ParentProcessId -in $serverIds -and
            $_.Name -like "judgedesk-executor*.exe"
        }
    )
    $guis = @(
        $snapshot | Where-Object {
            $_.ExecutablePath -ieq $ExecutablePath -and
            $_.CommandLine -notlike "*--judgedesk-internal-job-supervisor-v1*"
        }
    )
    return [pscustomobject]@{
        Snapshot = $snapshot
        DescendantIds = $descendantIds
        Helpers = $helpers
        Servers = $servers
        Executors = $executors
        Guis = $guis
    }
}

function Register-OwnedInventory {
    param(
        [int]$PrimaryProcessId,
        [object]$Inventory
    )
    $processIds = @(
        $PrimaryProcessId
        $Inventory.DescendantIds
    ) | Select-Object -Unique
    foreach ($processId in $processIds) {
        $snapshotProcess =
            $Inventory.Snapshot |
                Where-Object { $_.ProcessId -eq $processId } |
                Select-Object -First 1
        Register-OwnedCimProcess -CimProcess $snapshotProcess | Out-Null
    }
}

function Get-RequiredOwnedIdentities {
    param(
        [object[]]$Processes,
        [int]$ExpectedCount,
        [string]$Label
    )
    if ($Processes.Count -ne $ExpectedCount) {
        throw "Expected $ExpectedCount $Label process(es), found $($Processes.Count)."
    }
    $identities = @(
        $Processes |
            ForEach-Object { Register-OwnedCimProcess -CimProcess $_ } |
            Where-Object { $null -ne $_ }
    )
    if ($identities.Count -ne $ExpectedCount) {
        throw "Could not capture exact creation identities for all $Label processes."
    }
    return $identities
}

function Wait-RuntimeReady {
    param([System.Diagnostics.Process]$Primary)
    $primaryIdentity = $Primary.JudgeDeskIdentity
    $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    # The native executor is lazy. It may start during background toolchain
    # readiness or with the first judge workload, so both 0 and 1 are valid at
    # idle; more than one is never valid.
    do {
        if (-not (Test-StartedProcessAlive -Process $Primary)) {
            throw "JudgeDesk primary $($primaryIdentity.ProcessId) exited before runtime readiness."
        }
        $inventory = Get-RuntimeInventory -PrimaryIdentity $primaryIdentity
        Register-OwnedInventory `
            -PrimaryProcessId $primaryIdentity.ProcessId `
            -Inventory $inventory
        if (
            $inventory.Guis.Count -eq 1 -and
            $inventory.Helpers.Count -eq 1 -and
            $inventory.Servers.Count -eq 1 -and
            $inventory.Executors.Count -le 1
        ) {
            return $inventory
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "JudgeDesk idle runtime did not reach 1 GUI + 1 supervisor + 1 backend + at most 1 executor."
}

function Wait-OwnedProcessesExit {
    param(
        [object[]]$Identities,
        [int]$TimeoutSeconds = 20
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $remaining = @(
            $Identities |
                Where-Object { Test-OwnedProcessAlive -Identity $_ }
        )
        if ($remaining.Count -eq 0) {
            return
        }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $deadline)
    $remainingDetails = $remaining |
        ForEach-Object { "$($_.ProcessId)@$($_.StartTimeUtcTicks)" }
    throw "Owned processes did not exit before the gate deadline: $($remainingDetails -join ', ')"
}

function Start-OwnedProcess {
    $process = Start-Process -FilePath $ExecutablePath -PassThru
    $identity = Register-OwnedProcessObject -Process $process
    if ($null -eq $identity -and -not $process.HasExited) {
        $process.Kill()
        $process.WaitForExit(5000) | Out-Null
        $process.Dispose()
        throw "Could not capture the creation identity of a live JudgeDesk process."
    }
    $process | Add-Member -NotePropertyName JudgeDeskIdentity -NotePropertyValue $identity
    return $process
}

function Start-OwnedPrimary {
    $process = Start-OwnedProcess
    if ($null -eq $process.JudgeDeskIdentity) {
        $exitDescription = if ($process.HasExited) {
            "exit code $($process.ExitCode)"
        } else {
            "identity capture failed"
        }
        if (-not $process.HasExited) {
            $process.Kill()
            $process.WaitForExit(5000) | Out-Null
        }
        $process.Dispose()
        throw "JudgeDesk primary did not start: $exitDescription."
    }
    $ownedPrimaryIdentities.Add($process.JudgeDeskIdentity)
    return $process
}

function Stop-OwnedPrimary {
    param(
        [System.Diagnostics.Process]$Primary,
        [switch]$Force
    )
    $identity = $Primary.JudgeDeskIdentity
    $liveProcess = Get-LiveOwnedProcess -Identity $identity
    if ($null -eq $liveProcess) {
        $Primary.Dispose()
        return
    }
    try {
        if ($Force) {
            $liveProcess.Kill()
        } elseif (-not $liveProcess.CloseMainWindow()) {
            throw "JudgeDesk primary $($identity.ProcessId) did not accept CloseMainWindow."
        }
    } finally {
        $liveProcess.Dispose()
    }
    Wait-OwnedProcessesExit -Identities @($identity)
    $Primary.Dispose()
}

$result = [ordered]@{}
try {
    $gatePhase = "initial runtime startup"
    $primary = Start-OwnedPrimary
    $inventory = Wait-RuntimeReady -Primary $primary
    $result.InitialPrimaryPid = $primary.Id
    $result.InitialHelperPid = $inventory.Helpers[0].ProcessId
    $result.InitialBackendPid = $inventory.Servers[0].ProcessId
    $result.ExecutorStartedAtIdle = $inventory.Executors.Count -gt 0
    if ($inventory.Executors.Count -eq 1) {
        $result.InitialExecutorPid = $inventory.Executors[0].ProcessId
        $result.ExecutorWorkingSetMiB = [Math]::Round(
            (Get-Process -Id $inventory.Executors[0].ProcessId).WorkingSet64 / 1MB,
            1
        )
    }
    $result.PrimaryWorkingSetMiB = [Math]::Round(
        (Get-Process -Id $primary.Id).WorkingSet64 / 1MB,
        1
    )
    $result.SupervisorWorkingSetMiB = [Math]::Round(
        (Get-Process -Id $inventory.Helpers[0].ProcessId).WorkingSet64 / 1MB,
        1
    )
    $result.BackendWorkingSetMiB = [Math]::Round(
        (Get-Process -Id $inventory.Servers[0].ProcessId).WorkingSet64 / 1MB,
        1
    )
    $gatePhase = "secondary activation and focus"
    $primary.Refresh()
    $windowHandle = $primary.MainWindowHandle
    if ($windowHandle -eq 0) {
        throw "JudgeDesk primary window handle is unavailable."
    }
    [JudgeDeskSingleInstanceWindowProbe]::ShowWindow($windowHandle, 6) | Out-Null
    Start-Sleep -Milliseconds 250
    if (-not [JudgeDeskSingleInstanceWindowProbe]::IsIconic($windowHandle)) {
        throw "JudgeDesk did not minimize before the focus test."
    }
    $focusProbe = Start-OwnedProcess
    if (-not $focusProbe.WaitForExit($StartupTimeoutSeconds * 1000)) {
        Stop-OwnedProcess -Identity $focusProbe.JudgeDeskIdentity
        $focusProbe.Dispose()
        throw "Secondary instance did not exit after activation."
    }
    if ($focusProbe.ExitCode -ne 0) {
        $focusExitCode = $focusProbe.ExitCode
        $focusProbe.Dispose()
        throw "Secondary activation exited with code $focusExitCode."
    }
    $focusProbe.Dispose()
    $focusDeadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        Start-Sleep -Milliseconds 50
        $restored = -not [JudgeDeskSingleInstanceWindowProbe]::IsIconic($windowHandle)
        $foregrounded =
            [JudgeDeskSingleInstanceWindowProbe]::GetForegroundWindow() -eq $windowHandle
    } while (
        -not ($restored -and $foregrounded) -and
        [DateTime]::UtcNow -lt $focusDeadline
    )
    if (-not $restored -or -not $foregrounded) {
        throw "Secondary launch did not restore and foreground the primary window."
    }
    $result.MinimizedThenRestored = $restored
    $result.Foregrounded = $foregrounded

    $gatePhase = "sequential secondary launches"
    $launchDurations = @()
    1..$SequentialLaunches | ForEach-Object {
        $timer = [System.Diagnostics.Stopwatch]::StartNew()
        $secondary = Start-OwnedProcess
        if (-not $secondary.WaitForExit(10000)) {
            Stop-OwnedProcess -Identity $secondary.JudgeDeskIdentity
            $secondary.Dispose()
            throw "Sequential secondary launch $_ did not exit."
        }
        if ($secondary.ExitCode -ne 0) {
            $secondaryExitCode = $secondary.ExitCode
            $secondary.Dispose()
            throw "Sequential secondary launch $_ exited with code $secondaryExitCode."
        }
        $secondary.Dispose()
        $timer.Stop()
        $launchDurations += $timer.ElapsedMilliseconds
    }
    $inventory = Get-RuntimeInventory -PrimaryIdentity $primary.JudgeDeskIdentity
    if (
        $inventory.Guis.Count -ne 1 -or
        $inventory.Helpers.Count -ne 1 -or
        $inventory.Servers.Count -ne 1 -or
        $inventory.Executors.Count -gt 1
    ) {
        throw "Sequential launches changed the stable runtime inventory."
    }
    $result.SequentialLaunches = $SequentialLaunches
    $result.MinSecondaryLaunchMs =
        ($launchDurations | Measure-Object -Minimum).Minimum
    $result.MaxSecondaryLaunchMs =
        ($launchDurations | Measure-Object -Maximum).Maximum

    $gatePhase = "primary crash recovery"
    $oldHelperIdentities = @(
        Get-RequiredOwnedIdentities `
            -Processes $inventory.Helpers `
            -ExpectedCount 1 `
            -Label "old supervisor"
    )
    $oldJudgeTreeIdentities = @(
        Get-RequiredOwnedIdentities `
            -Processes @(
                @($inventory.Servers) + @($inventory.Executors)
            ) `
            -ExpectedCount (1 + $inventory.Executors.Count) `
            -Label "old judge tree"
    )
    Stop-OwnedProcess -Identity $primary.JudgeDeskIdentity
    $primary.Dispose()
    $replacement = Start-OwnedPrimary
    $overlapDetected = $false
    $replacementDeadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    do {
        if (-not (Test-StartedProcessAlive -Process $replacement)) {
            throw "Replacement primary exited during crash recovery."
        }
        $replacementInventory =
            Get-RuntimeInventory -PrimaryIdentity $replacement.JudgeDeskIdentity
        Register-OwnedInventory `
            -PrimaryProcessId $replacement.Id `
            -Inventory $replacementInventory
        $oldJudgeTreeAlive = @(
            $oldJudgeTreeIdentities |
                Where-Object { Test-OwnedProcessAlive -Identity $_ }
        )
        if (
            $replacementInventory.Servers.Count -gt 0 -and
            $oldJudgeTreeAlive.Count -gt 0
        ) {
            $overlapDetected = $true
            break
        }
        $replacementReady =
            $replacementInventory.Guis.Count -eq 1 -and
            $replacementInventory.Helpers.Count -eq 1 -and
            $replacementInventory.Servers.Count -eq 1 -and
            $replacementInventory.Executors.Count -le 1
        if (-not $replacementReady) {
            Start-Sleep -Milliseconds 25
        }
    } while (-not $replacementReady -and [DateTime]::UtcNow -lt $replacementDeadline)
    if ($overlapDetected) {
        throw "Replacement backend started before the old protected process tree exited."
    }
    if (-not $replacementReady) {
        throw "Replacement runtime did not become ready after a primary crash."
    }
    Wait-OwnedProcessesExit -Identities $oldJudgeTreeIdentities
    Wait-OwnedProcessesExit -Identities $oldHelperIdentities
    $result.PrimaryCrashRecovered = $true
    $result.ProtectedTreeOverlapDetected = $false

    $gatePhase = "supervisor failure recovery"
    $replacementInventory = Wait-RuntimeReady -Primary $replacement
    $replacementHelperIdentity = @(
        Get-RequiredOwnedIdentities `
            -Processes $replacementInventory.Helpers `
            -ExpectedCount 1 `
            -Label "replacement supervisor"
    )[0]
    $replacementBackendIdentities = @(
        Get-RequiredOwnedIdentities `
            -Processes @(
                @($replacementInventory.Servers) +
                    @($replacementInventory.Executors)
            ) `
            -ExpectedCount (1 + $replacementInventory.Executors.Count) `
            -Label "replacement judge tree"
    )
    Stop-OwnedProcess -Identity $replacementHelperIdentity
    Wait-OwnedProcessesExit -Identities @($replacementHelperIdentity)
    Wait-OwnedProcessesExit -Identities $replacementBackendIdentities
    if (-not (Test-StartedProcessAlive -Process $replacement)) {
        throw "Primary unexpectedly exited when only its supervisor was killed."
    }
    $result.SupervisorFailureDrainedBackend = $true
    Stop-OwnedPrimary -Primary $replacement

    $gatePhase = "normal shutdown drain"
    $finalPrimary = Start-OwnedPrimary
    $finalInventory = Wait-RuntimeReady -Primary $finalPrimary
    $finalProtectedIdentities = @(
        Get-RequiredOwnedIdentities `
            -Processes @(
                @($finalInventory.Helpers) +
                    @($finalInventory.Servers) +
                    @($finalInventory.Executors)
            ) `
            -ExpectedCount (2 + $finalInventory.Executors.Count) `
            -Label "final protected runtime"
    )
    $finalTrackedIdentities = @(
        $finalPrimary.JudgeDeskIdentity
        $finalProtectedIdentities
        $finalInventory.DescendantIds |
            ForEach-Object {
                $processId = $_
                $snapshotProcess =
                    $finalInventory.Snapshot |
                        Where-Object { $_.ProcessId -eq $processId } |
                        Select-Object -First 1
                Register-OwnedCimProcess -CimProcess $snapshotProcess
            } |
            Where-Object { $null -ne $_ }
    ) | Sort-Object ProcessId, StartTimeUtcTicks -Unique
    Stop-OwnedPrimary -Primary $finalPrimary
    Wait-OwnedProcessesExit -Identities $finalTrackedIdentities
    $result.NormalShutdownDrainedRuntime = $true

    [pscustomobject]$result | Format-List
} finally {
    foreach ($primaryIdentity in @($ownedPrimaryIdentities)) {
        try {
            if (Test-OwnedProcessAlive -Identity $primaryIdentity) {
                $primaryInventory =
                    Get-RuntimeInventory -PrimaryIdentity $primaryIdentity
                Register-OwnedInventory `
                    -PrimaryProcessId $primaryIdentity.ProcessId `
                    -Inventory $primaryInventory
            }
        } catch {
            Write-Warning (
                "Could not refresh owned runtime inventory for pid=" +
                "$($primaryIdentity.ProcessId): $($_.Exception.Message)"
            )
        } finally {
            Stop-OwnedProcess -Identity $primaryIdentity
        }
    }
    foreach ($identity in @($ownedProcesses.Values)) {
        Stop-OwnedProcess -Identity $identity
    }
}
