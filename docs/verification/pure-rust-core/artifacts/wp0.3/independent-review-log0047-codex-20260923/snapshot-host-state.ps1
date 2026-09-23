param(
    [Parameter(Mandatory = $true)]
    [string]$TargetPhase # "before" or "after"
)

$ErrorActionPreference = "Stop"
$EvidenceDir = "D:\Minh\Code\judgedesk\docs\verification\pure-rust-core\artifacts\wp0.3\independent-review-log0047-codex-20260923"
$OutDir = Join-Path $EvidenceDir $TargetPhase

if (-not (Test-Path -LiteralPath $EvidenceDir)) {
    New-Item -ItemType Directory -Path $EvidenceDir -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $EvidenceDir ".judgedesk-remediation-owned-root") -Value "WP0.3 LOG-0039 remediation evidence; 2026-09-22 Asia/Bangkok" -Encoding utf8
}

if (Test-Path -LiteralPath $OutDir) {
    throw "Output directory already exists: $OutDir"
}

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

function Get-StableHash([string]$text) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($text)
        return [Convert]::ToHexString($sha.ComputeHash($bytes))
    }
    finally {
        $sha.Dispose()
    }
}

function Normalize-JsonValue($value) {
    if ($null -eq $value) { return $null }
    if ($value -is [System.Management.Automation.PSCustomObject]) {
        $ordered = [ordered]@{}
        foreach ($p in ($value.PSObject.Properties.Name | Sort-Object -CaseSensitive)) {
            $ordered[$p] = Normalize-JsonValue $value.$p
        }
        return $ordered
    }
    if ($value -is [System.Collections.IDictionary]) {
        $ordered = [ordered]@{}
        foreach ($k in ($value.Keys | Sort-Object -CaseSensitive)) {
            $ordered[$k] = Normalize-JsonValue $value[$k]
        }
        return $ordered
    }
    if (($value -is [System.Collections.IEnumerable]) -and -not ($value -is [string])) {
        $items = @()
        foreach ($item in $value) { $items += ,(Normalize-JsonValue $item) }
        return $items
    }
    return $value
}

function Snapshot-Root([string]$name, [string]$root, [string]$destination) {
    $exists = Test-Path -LiteralPath $root
    $rows = [System.Collections.Generic.List[object]]::new()
    $semantic = [System.Collections.Generic.List[object]]::new()
    if ($exists) {
        $items = Get-ChildItem -LiteralPath $root -Force -Recurse -ErrorAction Stop | Sort-Object { [System.IO.Path]::GetRelativePath($root, $_.FullName) }
        foreach ($item in $items) {
            $rel = [System.IO.Path]::GetRelativePath($root, $item.FullName).Replace('\', '/')
            $attrs = $item.Attributes
            $isReparse = ($attrs -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
            if ($item.PSIsContainer) {
                $type = if ($isReparse) { 'directory-reparse' } else { 'directory' }
                $size = 0
                $hash = '-'
            }
            else {
                $type = if ($isReparse) { 'file-reparse' } else { 'file' }
                $size = $item.Length
                $hash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
            }
            $target = ''
            if ($isReparse) { try { $target = ($item.Target -join '|') } catch {} }
            $rows.Add([pscustomobject]@{
                RelativePath = $rel
                EntryType = $type
                Size = $size
                SHA256 = $hash
                LinkTarget = $target
            })
            if (-not $item.PSIsContainer -and ($item.Name -eq '.judgedesk-package.json' -or $rel -in @('toolchains.json', 'toolchain-discovery-v2.json', 'toolchain-execution-policy-v1.json', 'toolchain-distribution-state-v1.json'))) {
                $raw = Get-Content -LiteralPath $item.FullName -Raw
                try {
                    $parsed = $raw | ConvertFrom-Json -Depth 100
                    $normalized = Normalize-JsonValue $parsed
                    $canonical = $normalized | ConvertTo-Json -Depth 100 -Compress
                    $semantic.Add([pscustomobject]@{
                        RelativePath = $rel
                        RawSHA256 = $hash
                        CanonicalSHA256 = (Get-StableHash $canonical)
                        Content = $normalized
                    })
                }
                catch {
                    $semantic.Add([pscustomobject]@{
                        RelativePath = $rel
                        RawSHA256 = $hash
                        ParseError = $_.Exception.Message
                    })
                }
            }
        }
    }
    $lines = @('RelativePath`tEntryType`tSize`tSHA256`tLinkTarget') + ($rows | ForEach-Object { "$($_.RelativePath)`t$($_.EntryType)`t$($_.Size)`t$($_.SHA256)`t$($_.LinkTarget)" })
    $text = ($lines -join "`n") + "`n"
    $path = Join-Path $destination "$name.entries.tsv"
    [System.IO.File]::WriteAllText($path, $text, [System.Text.UTF8Encoding]::new($false))
    $meta = [pscustomobject]@{
        Name = $name
        Root = $root
        Exists = $exists
        Files = ($rows | Where-Object EntryType -Like 'file*').Count
        Directories = ($rows | Where-Object EntryType -Like 'directory*').Count
        Entries = $rows.Count
        AggregateSHA256 = Get-StableHash $text
        CapturedAt = (Get-Date).ToString('o')
    }
    $meta | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $destination "$name.metadata.json") -Encoding utf8
    $semantic | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath (Join-Path $destination "$name.semantic-state.json") -Encoding utf8
    return $meta
}

$metas = @(
    Snapshot-Root 'themisv2' 'C:\Users\mon\AppData\Local\ThemisV2' $OutDir
    Snapshot-Root 'executor' 'C:\Users\mon\AppData\Local\JudgeDesk\JudgeDeskExecutor' $OutDir
)
$metas | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $OutDir 'summary.json') -Encoding utf8

$proc = Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(node|judgedesk|judge-executor|cargo|rustc|excel)\.exe$' -or $_.CommandLine -match 'jd_contract_env_|jd_test_server_appdata_|jd_test_executor_|check-contract-parity|api-contracts' } | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine
$proc | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutDir 'processes.json') -Encoding utf8

Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -ge 3000 } | Sort-Object LocalPort | Select-Object LocalAddress, LocalPort, OwningProcess, State | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutDir 'listening-ports.json') -Encoding utf8

$temp = [System.IO.Path]::GetTempPath()
Get-ChildItem -LiteralPath $temp -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'jd_contract_env_*' -or $_.Name -like 'jd_test_server_appdata_*' -or $_.Name -like 'jd_test_executor_*' -or $_.Name -like 'export_*' -or $_.Name -like 'judgedesk-test-owned-*' } | Select-Object FullName, Attributes, CreationTimeUtc, LastWriteTimeUtc | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutDir 'temp-roots.json') -Encoding utf8

try {
    Get-MpThreatDetection | Select-Object DetectionID, ThreatID, ThreatName, InitialDetectionTime, LastThreatStatusChangeTime, ActionSuccess, CurrentThreatExecutionStatus, Resources | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutDir 'defender-threat-detections.json') -Encoding utf8
}
catch {
    $_ | Out-String | Set-Content -LiteralPath (Join-Path $OutDir 'defender-query-error.txt') -Encoding utf8
}

try {
    Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Windows Defender/Operational'; StartTime=(Get-Date).AddDays(-2)} -ErrorAction Stop | Where-Object { $_.Id -in @(1116, 1117, 1118, 1119, 1121, 1122, 5007) } | Select-Object TimeCreated, Id, LevelDisplayName, Message | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutDir 'defender-events.json') -Encoding utf8
}
catch {
    $_ | Out-String | Set-Content -LiteralPath (Join-Path $OutDir 'defender-events-query-error.txt') -Encoding utf8
}

$metas | Format-Table -AutoSize
Write-Output "Captured $TargetPhase snapshot to $OutDir"



