<#
.SYNOPSIS
  Windows entry point — delegates to supervisor-windows.ps1.
.DESCRIPTION
  Usage:  powershell -File scripts\daemon.ps1 start|stop|status|logs|install-service|uninstall-service
#>
param(
    [Parameter(Position=0)]
    [string]$Command = 'help',

    [Parameter(Position=1)]
    [int]$LogLines = 50
)

$supervisorScript = Join-Path (Split-Path -Parent $PSCommandPath) 'supervisor-windows.ps1'
& $supervisorScript -Command $Command -LogLines $LogLines
