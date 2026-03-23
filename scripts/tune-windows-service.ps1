param(
    [string]$ServiceName = 'ClaudeToIMBridge'
)

$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).
    IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    throw "This script must be run in an Administrator PowerShell session."
}

Write-Host "== Current Service Config =="
sc.exe qc $ServiceName

Write-Host ""
Write-Host "== Applying Delayed Auto Start =="
sc.exe config $ServiceName start= delayed-auto

Write-Host ""
Write-Host "== Applying Network Dependencies =="
sc.exe config $ServiceName depend= Dnscache/Tcpip

Write-Host ""
Write-Host "== Updated Service Config =="
sc.exe qc $ServiceName

Write-Host ""
Write-Host "== Updated Delayed Auto Start Flag =="
Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName" | Select-Object DelayedAutoStart
