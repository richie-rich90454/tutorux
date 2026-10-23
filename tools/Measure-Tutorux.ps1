param(
    [Parameter(Mandatory = $true)]
    [string]$Executable,
    [string]$Archive,
    [int]$SettleMilliseconds = 2500
)

$ErrorActionPreference = 'Stop'
$arguments = @()
if ($Archive) {
    $arguments += @('--archive', $Archive)
}

$started = Get-Date
$process = Start-Process -FilePath $Executable -ArgumentList $arguments -PassThru
try {
    Start-Sleep -Milliseconds $SettleMilliseconds
    if ($process.HasExited) {
        throw "Tutorux exited before measurement (exit code $($process.ExitCode))."
    }
    $process.Refresh()
    $elapsed = ((Get-Date) - $started).TotalMilliseconds
    [pscustomobject]@{
        Executable        = (Resolve-Path $Executable).Path
        Archive           = $Archive
        StartupMs         = [math]::Round($elapsed, 0)
        PrivateBytes      = $process.PrivateMemorySize64
        PrivateMB         = [math]::Round($process.PrivateMemorySize64 / 1MB, 1)
        WorkingSetMB      = [math]::Round($process.WorkingSet64 / 1MB, 1)
        ApplicationThreads = $process.Threads.Count
        Handles           = $process.HandleCount
    } | Format-List
}
finally {
    if (-not $process.HasExited) {
        $process.CloseMainWindow() | Out-Null
        if (-not $process.WaitForExit(5000)) {
            Stop-Process -Id $process.Id -Force
        }
    }
}
