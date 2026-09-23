param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"

function Get-TextSha256([string]$Text) {
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Text)
    return [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes))
}

function Get-FileSha256([string]$Path) {
    $stream = [System.IO.File]::Open(
        $Path,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    try {
        return [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($stream))
    }
    finally {
        $stream.Dispose()
    }
}

function ConvertTo-NormalizedJsonValue($Value) {
    if ($null -eq $Value) { return $null }
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        $ordered = [ordered]@{}
        foreach ($property in ($Value.PSObject.Properties.Name | Sort-Object -CaseSensitive)) {
            $ordered[$property] = ConvertTo-NormalizedJsonValue $Value.$property
        }
        return $ordered
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $ordered = [ordered]@{}
        foreach ($key in ($Value.Keys | Sort-Object -CaseSensitive)) {
            $ordered[$key] = ConvertTo-NormalizedJsonValue $Value[$key]
        }
        return $ordered
    }
    if (($Value -is [System.Collections.IEnumerable]) -and -not ($Value -is [string])) {
        $items = @()
        foreach ($item in $Value) { $items += ,(ConvertTo-NormalizedJsonValue $item) }
        return $items
    }
    return $Value
}

function Write-RootSnapshot([string]$Name, [string]$Root) {
    $rows = [System.Collections.Generic.List[object]]::new()
    $semantic = [System.Collections.Generic.List[object]]::new()
    $exists = Test-Path -LiteralPath $Root
    if ($exists) {
        $items = Get-ChildItem -LiteralPath $Root -Force -Recurse -ErrorAction Stop |
            Sort-Object { [System.IO.Path]::GetRelativePath($Root, $_.FullName) }
        foreach ($item in $items) {
            $relative = [System.IO.Path]::GetRelativePath($Root, $item.FullName).Replace("\", "/")
            $isReparse = ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
            if ($item.PSIsContainer) {
                $entryType = if ($isReparse) { "directory-reparse" } else { "directory" }
                $size = 0
                $hash = "-"
            }
            else {
                $entryType = if ($isReparse) { "file-reparse" } else { "file" }
                $size = $item.Length
                $hash = Get-FileSha256 $item.FullName
            }
            $target = if ($isReparse) { $item.Target -join "|" } else { "" }
            $rows.Add([pscustomobject]@{
                RelativePath = $relative
                EntryType = $entryType
                Size = $size
                SHA256 = $hash
                LinkTarget = $target
            })

            if (-not $item.PSIsContainer -and (
                $item.Name -eq ".judgedesk-package.json" -or
                $relative -in @(
                    "toolchains.json",
                    "toolchain-discovery-v2.json",
                    "toolchain-execution-policy-v1.json",
                    "toolchain-distribution-state-v1.json"
                )
            )) {
                $raw = Get-Content -LiteralPath $item.FullName -Raw
                $parsed = $raw | ConvertFrom-Json -Depth 100
                $normalized = ConvertTo-NormalizedJsonValue $parsed
                $canonical = $normalized | ConvertTo-Json -Depth 100 -Compress
                $semantic.Add([pscustomobject]@{
                    RelativePath = $relative
                    RawSHA256 = $hash
                    CanonicalSHA256 = Get-TextSha256 $canonical
                    Content = $normalized
                })
            }
        }
    }

    $lines = @("RelativePath`tEntryType`tSize`tSHA256`tLinkTarget") + ($rows | ForEach-Object {
        "$($_.RelativePath)`t$($_.EntryType)`t$($_.Size)`t$($_.SHA256)`t$($_.LinkTarget)"
    })
    $text = ($lines -join "`n") + "`n"
    [System.IO.File]::WriteAllText(
        (Join-Path $OutputDirectory "$Name.entries.tsv"),
        $text,
        [System.Text.UTF8Encoding]::new($false)
    )
    $metadata = [pscustomobject]@{
        Name = $Name
        Root = $Root
        Exists = $exists
        Files = ($rows | Where-Object EntryType -Like "file*").Count
        Directories = ($rows | Where-Object EntryType -Like "directory*").Count
        Entries = $rows.Count
        AggregateSHA256 = Get-TextSha256 $text
        CapturedAt = (Get-Date).ToString("o")
    }
    $metadata | ConvertTo-Json -Depth 10 |
        Set-Content -LiteralPath (Join-Path $OutputDirectory "$Name.metadata.json") -Encoding utf8
    $semantic | ConvertTo-Json -Depth 100 |
        Set-Content -LiteralPath (Join-Path $OutputDirectory "$Name.semantic-state.json") -Encoding utf8
    return $metadata
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$summary = @(
    Write-RootSnapshot "themisv2" "C:\Users\mon\AppData\Local\ThemisV2"
    Write-RootSnapshot "executor" "C:\Users\mon\AppData\Local\JudgeDesk\JudgeDeskExecutor"
)
$summary | ConvertTo-Json -Depth 10 |
    Set-Content -LiteralPath (Join-Path $OutputDirectory "summary.json") -Encoding utf8
$summary | Format-Table -AutoSize
