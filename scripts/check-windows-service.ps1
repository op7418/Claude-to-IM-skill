param(
    [int]$LogLines = 20
)

$ErrorActionPreference = 'Stop'

$serviceName = 'ClaudeToIMBridge'
$ctiHome = if ($env:CTI_HOME) { $env:CTI_HOME } else { Join-Path $env:USERPROFILE '.claude-to-im' }
$statusFile = Join-Path (Join-Path $ctiHome 'runtime') 'status.json'
$logFile = Join-Path (Join-Path $ctiHome 'logs') 'bridge.log'
$wrapperLogFile = Join-Path (Join-Path $ctiHome 'logs') 'ClaudeToIMBridge.wrapper.log'
$outLogFile = Join-Path (Join-Path $ctiHome 'logs') 'ClaudeToIMBridge.out.log'
$errLogFile = Join-Path (Join-Path $ctiHome 'logs') 'ClaudeToIMBridge.err.log'

function Get-LatestServicePid {
    param([string]$WrapperLogPath)

    if (-not (Test-Path $WrapperLogPath)) {
        return $null
    }

    $startedLine = Get-Content $WrapperLogPath | Select-String -Pattern 'Started process ' | Select-Object -Last 1
    if (-not $startedLine) {
        return $null
    }

    $match = [regex]::Match($startedLine.Line, 'Started process (\d+)')
    if (-not $match.Success) {
        return $null
    }

    return [int]$match.Groups[1].Value
}

Write-Host "== Windows Service =="
try {
    Get-Service -Name $serviceName | Select-Object Name, Status, StartType | Format-Table -AutoSize
} catch {
    Write-Host "Service '$serviceName' not found."
}

Write-Host ""
Write-Host "== Service Config =="
sc.exe qc $serviceName

Write-Host ""
Write-Host "== Active Process (from WinSW) =="
$servicePid = Get-LatestServicePid -WrapperLogPath $wrapperLogFile
if ($servicePid) {
    try {
        Get-Process -Id $servicePid | Select-Object Id, ProcessName, StartTime, CPU | Format-Table -AutoSize
    } catch {
        Write-Host "Last started service process was PID $servicePid, but it is not running now."
    }
} else {
    Write-Host "Could not determine service child PID from $wrapperLogFile"
}

Write-Host ""
Write-Host "== Bridge Status File =="
if (Test-Path $statusFile) {
    Get-Content $statusFile
    Write-Host ""
    Write-Host "(Note: status.json can be stale after manual stop/start. Compare it with the service state and wrapper log above.)"
} else {
    Write-Host "No status file found at $statusFile"
}

Write-Host ""
Write-Host "== WinSW Wrapper Logs =="
if (Test-Path $wrapperLogFile) {
    Get-Content $wrapperLogFile -Tail $LogLines
} else {
    Write-Host "No wrapper log found at $wrapperLogFile"
}

Write-Host ""
Write-Host "== Service Stdout =="
if (Test-Path $outLogFile) {
    Get-Content $outLogFile -Tail $LogLines
} else {
    Write-Host "No stdout log found at $outLogFile"
}

Write-Host ""
Write-Host "== Service Stderr =="
if (Test-Path $errLogFile) {
    Get-Content $errLogFile -Tail $LogLines
} else {
    Write-Host "No stderr log found at $errLogFile"
}

Write-Host ""
Write-Host "== Recent Bridge Logs =="
if (Test-Path $logFile) {
    Get-Content $logFile -Tail $LogLines
} else {
    Write-Host "No bridge log found at $logFile"
}
