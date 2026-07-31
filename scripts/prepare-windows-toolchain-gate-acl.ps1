param(
  [Parameter(Mandatory = $false)]
  [string]$GateRoot = "build\toolchain-gate-root"
)

$ErrorActionPreference = "Stop"

$buildRoot = (Resolve-Path -LiteralPath "build").Path
$target = (Resolve-Path -LiteralPath $GateRoot).Path
$relative = [System.IO.Path]::GetRelativePath($buildRoot, $target)
if (
  $relative -eq "." -or
  $relative -eq ".." -or
  $relative.StartsWith("..$([System.IO.Path]::DirectorySeparatorChar)") -or
  [System.IO.Path]::IsPathRooted($relative) -or
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
