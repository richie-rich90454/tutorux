#Requires -Version 5.1
# Deletes the build tree (and optionally dist/) of this repository and reports the freed space.
[CmdletBinding()]
param(
    [switch]$Dist,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$RootFull = [IO.Path]::GetFullPath($PSScriptRoot)
if (-not (Test-Path -LiteralPath (Join-Path $RootFull "CMakeLists.txt") -PathType Leaf)) {
    throw "clean.ps1 must be located in the repository root (next to CMakeLists.txt)."
}

$Names = @("build")
if ($Dist) {
    $Names += "dist"
}

function Get-TreeBytes {
    param([string]$Path)
    $Bytes = [long]0
    Get-ChildItem -LiteralPath $Path -Recurse -Force -File -ErrorAction SilentlyContinue |
        ForEach-Object { $Bytes += $_.Length }
    return $Bytes
}

$FreedBytes = [long]0
foreach ($Name in $Names) {
    $Target = Join-Path $RootFull $Name
    if (-not (Test-Path -LiteralPath $Target)) {
        Write-Host "skip    $Target (not present)"
        continue
    }

    $Resolved = [IO.Path]::GetFullPath($Target)
    $Parent = [IO.Path]::GetDirectoryName($Resolved)
    if ($Parent -ne $RootFull -or [IO.Path]::GetFileName($Resolved) -ne $Name) {
        throw "refusing to delete '$Resolved': it is not this repository's $Name directory."
    }

    $Bytes = Get-TreeBytes -Path $Resolved

    if ($DryRun) {
        Write-Host ("would delete {0} ({1:N1} MB)" -f $Resolved, ($Bytes / 1MB))
        continue
    }

    $IsLink = (Get-Item -LiteralPath $Resolved -Force).Attributes -band [IO.FileAttributes]::ReparsePoint
    if ($IsLink) {
        # A junction or symlink: remove only the link, never its target.
        & cmd.exe /c rd "$Resolved" | Out-Null
    } else {
        Remove-Item -LiteralPath $Resolved -Recurse -Force
        if (Test-Path -LiteralPath $Resolved) {
            # Deep FetchContent paths can exceed the Windows path limit for Remove-Item.
            & cmd.exe /c rd /s /q "$Resolved" | Out-Null
        }
    }
    if (Test-Path -LiteralPath $Resolved) {
        throw "could not fully delete $Resolved (a process may still be using it)."
    }

    $FreedBytes += $Bytes
    Write-Host ("deleted {0} ({1:N1} MB freed)" -f $Resolved, ($Bytes / 1MB))
}

if ($DryRun) {
    Write-Host "dry run: nothing deleted."
} elseif ($FreedBytes -gt 0) {
    Write-Host ("total freed: {0:N1} MB" -f ($FreedBytes / 1MB))
} else {
    Write-Host "nothing to delete."
}
