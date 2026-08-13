param(
    [string]$OutputDirectory = "release-assets-windows",
    [switch]$FinalizeOnly
)

$ErrorActionPreference = "Stop"

# Resolve this optional diagnostic before the build subprocesses run. Some npm
# child environments do not expose the inbox Security module, so release gates
# verify the resulting MSI signatures again from a clean PowerShell process.
$getAuthenticodeSignature = Get-Command Get-AuthenticodeSignature -ErrorAction SilentlyContinue

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$outputRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDirectory))
$targetBundleRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot "src-tauri\target\x86_64-pc-windows-msvc\release\bundle"))
$repoChildPrefix = $repoRoot.TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
) + [System.IO.Path]::DirectorySeparatorChar

if (-not $outputRoot.StartsWith($repoChildPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Output directory must stay inside the repository: $outputRoot"
}
if (-not $targetBundleRoot.StartsWith($repoChildPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Tauri bundle directory escaped the repository: $targetBundleRoot"
}

$package = Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
$version = [string]$package.version
if ($version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Invalid release version: $version"
}

function Get-MsiInstalledSizeBytes([string]$MsiPath) {
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $view = $null
    try {
        $database = $installer.GetType().InvokeMember(
            "OpenDatabase",
            [System.Reflection.BindingFlags]::InvokeMethod,
            $null,
            $installer,
            @($MsiPath, 0)
        )
        $view = $database.GetType().InvokeMember(
            "OpenView",
            [System.Reflection.BindingFlags]::InvokeMethod,
            $null,
            $database,
            @('SELECT `FileSize` FROM `File`')
        )
        $view.GetType().InvokeMember(
            "Execute",
            [System.Reflection.BindingFlags]::InvokeMethod,
            $null,
            $view,
            $null
        ) | Out-Null
        [Int64]$total = 0
        while ($true) {
            $record = $view.GetType().InvokeMember(
                "Fetch",
                [System.Reflection.BindingFlags]::InvokeMethod,
                $null,
                $view,
                $null
            )
            if ($null -eq $record) { break }
            $fileSize = $record.GetType().InvokeMember(
                "IntegerData",
                [System.Reflection.BindingFlags]::GetProperty,
                $null,
                $record,
                1
            )
            $total += [Int64]$fileSize
        }
        if ($total -le 0) { throw "MSI File table did not report a positive installed size." }
        return $total
    }
    finally {
        if ($null -ne $view) {
            try {
                $view.GetType().InvokeMember(
                    "Close",
                    [System.Reflection.BindingFlags]::InvokeMethod,
                    $null,
                    $view,
                    $null
                ) | Out-Null
            }
            catch {}
        }
        if ($null -ne $installer) {
            [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer)
        }
    }
}

function Get-Sha256([string]$FilePath) {
    $stream = [System.IO.File]::OpenRead($FilePath)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return [System.BitConverter]::ToString(
            $sha256.ComputeHash($stream)
        ).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

Push-Location $repoRoot
try {
    if (-not $FinalizeOnly) {
        if (Test-Path -LiteralPath $outputRoot) {
            Remove-Item -LiteralPath $outputRoot -Recurse -Force
        }
        New-Item -ItemType Directory -Path $outputRoot | Out-Null

        & npm.cmd run release:check-version
        if ($LASTEXITCODE -ne 0) { throw "Version verification failed." }
        & npm.cmd run build:executor
        if ($LASTEXITCODE -ne 0) { throw "Native executor build failed." }
        & npm.cmd run build:server
        if ($LASTEXITCODE -ne 0) { throw "Server sidecar build failed." }

        foreach ($variant in @("core", "full")) {
            & npm.cmd run "distribution:sync:$variant"
            if ($LASTEXITCODE -ne 0) { throw "Preparing $variant distribution resources failed." }

            if (Test-Path -LiteralPath $targetBundleRoot) {
                Remove-Item -LiteralPath $targetBundleRoot -Recurse -Force
            }

            $configPath = "src-tauri/tauri.windows.$variant.local.conf.json"
            & npx.cmd tauri build --config $configPath --target x86_64-pc-windows-msvc
            if ($LASTEXITCODE -ne 0) { throw "Building the Windows $variant MSI failed." }

            $msiDirectory = Join-Path $targetBundleRoot "msi"
            $msiFiles = @(Get-ChildItem -LiteralPath $msiDirectory -Filter "JudgeDesk_*.msi" -File)
            if ($msiFiles.Count -ne 1) {
                throw "Expected exactly one $variant MSI, found $($msiFiles.Count)."
            }

            $destinationName = "JudgeDesk_${version}_${variant}_x64_en-US.msi"
            $destinationPath = Join-Path $outputRoot $destinationName
            Copy-Item -LiteralPath $msiFiles[0].FullName -Destination $destinationPath

            $metadata = [ordered]@{
                schemaVersion = 1
                edition = $variant
                platform = "windows"
                arch = "x86_64"
                installedSizeBytes = Get-MsiInstalledSizeBytes $destinationPath
            }
            $metadata | ConvertTo-Json | Set-Content -LiteralPath "${destinationPath}.metadata.json" -Encoding utf8

            if ($null -ne $getAuthenticodeSignature) {
                $signature = & $getAuthenticodeSignature -LiteralPath $destinationPath
                Write-Host "$destinationName Authenticode: $($signature.Status)"
            }
            else {
                Write-Warning "Authenticode diagnostic unavailable in this build shell; verify $destinationName separately."
            }
        }
    }
    else {
        foreach ($variant in @("core", "full")) {
            $destinationPath = Join-Path $outputRoot "JudgeDesk_${version}_${variant}_x64_en-US.msi"
            if (-not (Test-Path -LiteralPath $destinationPath -PathType Leaf)) {
                throw "Cannot finalize missing Windows $variant MSI: $destinationPath"
            }
            if (-not (Test-Path -LiteralPath "${destinationPath}.metadata.json" -PathType Leaf)) {
                throw "Cannot finalize missing Windows $variant metadata: ${destinationPath}.metadata.json"
            }
        }
    }

    Get-ChildItem -LiteralPath $outputRoot -Filter "JudgeDesk_*.msi" -File |
        Sort-Object Name |
        ForEach-Object {
            $hash = Get-Sha256 $_.FullName
            "$hash  $($_.Name)"
        } | Set-Content -LiteralPath (Join-Path $outputRoot "SHA256SUMS-windows") -Encoding ascii

    Get-Content -LiteralPath (Join-Path $outputRoot "SHA256SUMS-windows")
}
finally {
    Pop-Location
}
