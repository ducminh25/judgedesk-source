$ErrorActionPreference = "Stop"

$tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd("\") + "\"
$ownedRoots = @(
    "C:\Users\mon\AppData\Local\Temp\jd_wp03_verify_808a22b6a8354c06a2bb65223b9cfbe6",
    "C:\Users\mon\AppData\Local\Temp\jd_wp03_probes_ff6567a1e5844b9390ba03ab44b126c3",
    "C:\Users\mon\AppData\Local\Temp\jd_wp03_descriptor_probe_7df2494aaa394e3483c574fa0c26058f"
)

foreach ($ownedRoot in $ownedRoots) {
    $resolved = [IO.Path]::GetFullPath($ownedRoot)
    if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing cleanup outside TEMP: $resolved"
    }
    $marker = Join-Path $resolved ".judgedesk-verifier-owner.json"
    if (-not (Test-Path -LiteralPath $marker)) {
        throw "Refusing cleanup without verifier marker: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $resolved) {
        throw "Verifier root remains after cleanup: $resolved"
    }
    Write-Output "Removed verifier-owned root: $resolved"
}
