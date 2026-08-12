param(
  [Parameter(Mandatory = $false)]
  [string]$GateRoot = "build\toolchain-gate-root"
)

$ErrorActionPreference = "Stop"

$buildRoot = [System.IO.Path]::GetFullPath(
  (Resolve-Path -LiteralPath "build").Path
)
$target = [System.IO.Path]::GetFullPath(
  (Resolve-Path -LiteralPath $GateRoot).Path
)
$buildChildPrefix = $buildRoot.TrimEnd(
  [System.IO.Path]::DirectorySeparatorChar,
  [System.IO.Path]::AltDirectorySeparatorChar
) + [System.IO.Path]::DirectorySeparatorChar
if (
  -not $target.StartsWith(
    $buildChildPrefix,
    [System.StringComparison]::OrdinalIgnoreCase
  ) -or
  -not (Test-Path -LiteralPath $target -PathType Container)
) {
  throw "The Windows toolchain gate root must be an existing child of the workspace build directory."
}

# Full installer resources are public, read-only compiler/runtime payloads. The
# temporary CI gate root lives in a source checkout instead, so reproduce the
# read/execute access that installed files receive without widening any local
# compiler, user profile, or workspace parent ACL.
& icacls.exe $target /grant "*S-1-15-2-1:(OI)(CI)RX" /T /C /Q
if ($LASTEXITCODE -ne 0) {
  throw "Unable to grant read/execute access to the isolated toolchain gate root."
}

Write-Output "Prepared Windows AppContainer read/execute access for $target."
