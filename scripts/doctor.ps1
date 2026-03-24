<#
.SYNOPSIS
  Windows diagnostics for the claude-to-im bridge.

.DESCRIPTION
  Validates the local Windows environment without relying on bash/WSL semantics.
#>

$ErrorActionPreference = 'Stop'

$CtiHome    = if ($env:CTI_HOME) { $env:CTI_HOME } else { Join-Path $env:USERPROFILE '.claude-to-im' }
$SkillDir   = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$ConfigFile = Join-Path $CtiHome 'config.env'
$RuntimeDir = Join-Path $CtiHome 'runtime'
$PidFile    = Join-Path $RuntimeDir 'bridge.pid'
$StatusFile = Join-Path $RuntimeDir 'status.json'
$LogDir     = Join-Path $CtiHome 'logs'
$LogFile    = Join-Path $LogDir 'bridge.log'
$DaemonMjs  = Join-Path (Join-Path $SkillDir 'dist') 'daemon.mjs'

$Pass = 0
$Fail = 0

function Add-Result {
    param(
        [string]$Label,
        [bool]$Ok
    )

    if ($Ok) {
        Write-Host "[OK]   $Label"
        $script:Pass++
    } else {
        Write-Host "[FAIL] $Label"
        $script:Fail++
    }
}

function Get-ConfigMap {
    $map = @{}
    if (-not (Test-Path $ConfigFile)) {
        return $map
    }

    $raw = [System.IO.File]::ReadAllText($ConfigFile)
    if ($raw.Length -gt 0 -and $raw[0] -eq [char]0xFEFF) {
        $raw = $raw.Substring(1)
    }

    foreach ($line in ($raw -split "`r?`n")) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) {
            continue
        }

        $sep = $trimmed.IndexOf('=')
        if ($sep -lt 1) {
            continue
        }

        $key = $trimmed.Substring(0, $sep).Trim()
        $value = $trimmed.Substring($sep + 1).Trim()
        if (
            $value.Length -ge 2 -and
            (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))
        ) {
            $value = $value.Substring(1, $value.Length - 2)
        }

        $map[$key] = $value
    }

    return $map
}

function Get-ConfigValue {
    param(
        [hashtable]$Config,
        [string]$Key,
        [string]$Default = ''
    )

    if ($Config.ContainsKey($Key) -and $null -ne $Config[$Key] -and $Config[$Key] -ne '') {
        return $Config[$Key]
    }

    return $Default
}

function Test-CodexAuthFile {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        return $false
    }

    try {
        $raw = Get-Content $Path -Raw
        if (-not $raw) {
            return $false
        }

        $auth = $raw | ConvertFrom-Json
        return [string]::IsNullOrWhiteSpace($auth.OPENAI_API_KEY) -eq $false
    } catch {
        return $false
    }
}

function Test-PidAlive {
    param([string]$Pid)
    if (-not $Pid) {
        return $false
    }

    try {
        $null = Get-Process -Id ([int]$Pid) -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Get-EnabledChannels {
    param([hashtable]$Config)

    $value = Get-ConfigValue -Config $Config -Key 'CTI_ENABLED_CHANNELS'
    if (-not $value) {
        return @()
    }

    return @(
        $value.Split(',') |
        ForEach-Object { $_.Trim().ToLowerInvariant() } |
        Where-Object { $_ }
    )
}

function Test-FileAcl {
    param([string]$Path)

    try {
        $acl = Get-Acl $Path
        $broadWriters = @(
            $acl.Access | Where-Object {
                $_.AccessControlType -eq 'Allow' -and
                $_.IdentityReference.Value -match '(^|\\)(Everyone|Users|Authenticated Users)$' -and
                (
                    ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::WriteData) -or
                    ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::CreateFiles) -or
                    ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::Modify) -or
                    ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl)
                )
            }
        )

        if ($broadWriters.Count -eq 0) {
            Add-Result "config.env ACL is not broadly writable" $true
        } else {
            $principals = ($broadWriters | Select-Object -ExpandProperty IdentityReference -Unique) -join ', '
            Add-Result "config.env ACL is not broadly writable (write access for: $principals)" $false
        }
    } catch {
        Add-Result "config.env ACL check completed" $false
    }
}

function Invoke-JsonPost {
    param(
        [string]$Uri,
        [hashtable]$Body,
        [hashtable]$Headers = @{}
    )

    return Invoke-RestMethod -Uri $Uri -Method Post -Headers $Headers -Body ($Body | ConvertTo-Json -Compress) -ContentType 'application/json' -TimeoutSec 10
}

$config = Get-ConfigMap

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
    $nodeVersionText = (& $nodeCmd.Source --version 2>$null).Trim()
    $nodeVersion = $null
    if ([Version]::TryParse(($nodeVersionText -replace '^v', ''), [ref]$nodeVersion)) {
        Add-Result "Node.js >= 20 (found $nodeVersionText)" ($nodeVersion.Major -ge 20)
    } else {
        Add-Result "Node.js version readable (found $nodeVersionText)" $false
    }
} else {
    Add-Result "Node.js installed" $false
}

$runtime = Get-ConfigValue -Config $config -Key 'CTI_RUNTIME' -Default 'claude'
Write-Host "Runtime: $runtime"
Write-Host ""

if ($runtime -in @('claude', 'auto')) {
    $claudeCandidates = New-Object System.Collections.Generic.List[string]
    $explicitClaudePath = Get-ConfigValue -Config $config -Key 'CTI_CLAUDE_CODE_EXECUTABLE'
    if ($explicitClaudePath) {
        $claudeCandidates.Add($explicitClaudePath)
    } else {
        @(Get-Command claude -All -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -Unique) | ForEach-Object {
            if ($_ -and -not $claudeCandidates.Contains($_)) {
                $claudeCandidates.Add($_)
            }
        }

        @(
            (Join-Path $env:USERPROFILE '.claude\local\claude.exe'),
            (Join-Path $env:USERPROFILE '.local\bin\claude'),
            'C:\Program Files\Claude\claude.exe'
        ) | ForEach-Object {
            if ($_ -and (Test-Path $_) -and -not $claudeCandidates.Contains($_)) {
                $claudeCandidates.Add($_)
            }
        }
    }

    $claudeOk = $false
    $claudeSummary = $null
    foreach ($candidate in $claudeCandidates) {
        try {
            $verText = (& $candidate --version 2>$null).Trim()
            $verObj = $null
            if (-not [Version]::TryParse(($verText -replace '^v', ''), [ref]$verObj)) {
                continue
            }
            if ($verObj.Major -lt 2) {
                $claudeSummary = "$candidate is too old ($verText)"
                continue
            }

            $helpText = (& $candidate --help 2>&1 | Out-String)
            $missingFlags = @('output-format', 'input-format', 'permission-mode', 'setting-sources') | Where-Object {
                $helpText -notmatch [regex]::Escape($_)
            }

            if ($missingFlags.Count -eq 0) {
                $claudeOk = $true
                $claudeSummary = "$verText at $candidate"
                break
            }

            $claudeSummary = "$candidate missing flags: $($missingFlags -join ', ')"
        } catch {
            $claudeSummary = "$candidate could not be executed"
        }
    }

    if ($claudeOk) {
        Add-Result "Claude CLI compatible ($claudeSummary)" $true
        $hasThirdPartyAuth = $config.Keys | Where-Object { $_ -in @('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN') }
        if ($hasThirdPartyAuth) {
            Add-Result "Claude CLI auth (skipped: ANTHROPIC_* configured in config.env)" $true
        } else {
            $claudeAuthOk = $false
            try {
                $authText = (& claude auth status 2>&1 | Out-String)
                $claudeAuthOk = $authText -match 'loggedIn.*true|logged in|authenticated'
            } catch {
                $claudeAuthOk = $false
            }
            Add-Result "Claude CLI authenticated" $claudeAuthOk
        }
    } else {
        $label = if ($claudeSummary) { "Claude CLI compatible ($claudeSummary)" } else { 'Claude CLI compatible (not found)' }
        Add-Result $label ($runtime -eq 'auto')
    }

    $sdkCliPaths = @(
        (Join-Path $SkillDir 'node_modules\@anthropic-ai\claude-agent-sdk\cli.js'),
        (Join-Path $SkillDir 'node_modules\@anthropic-ai\claude-agent-sdk\dist\cli.js')
    )
    $sdkCli = $sdkCliPaths | Where-Object { Test-Path $_ } | Select-Object -First 1
    $sdkLabel = if ($sdkCli) { "Claude SDK cli.js exists ($sdkCli)" } else { "Claude SDK cli.js exists (not found)" }
    Add-Result $sdkLabel ($sdkCli -or $runtime -ne 'claude')
}

if ($runtime -in @('codex', 'auto')) {
    $codexCmd = Get-Command codex -ErrorAction SilentlyContinue
    $codexAuthFile = Join-Path $env:USERPROFILE '.codex\auth.json'
    if ($codexCmd) {
        $codexVersion = (& $codexCmd.Source --version 2>$null | Select-Object -First 1)
        if (-not $codexVersion) {
            $codexVersion = 'unknown'
        }
        Add-Result "Codex CLI available ($codexVersion)" $true
    } else {
        Add-Result "Codex CLI available (not found in PATH)" ($runtime -eq 'auto')
    }

    $codexSdk = Join-Path $SkillDir 'node_modules\@openai\codex-sdk'
    $codexSdkExists = Test-Path $codexSdk
    $codexSdkLabel = if ($codexSdkExists) { '@openai/codex-sdk installed' } else { "@openai/codex-sdk installed (not found in $codexSdk)" }
    Add-Result $codexSdkLabel ($codexSdkExists -or $runtime -ne 'codex')

    $codexAuthOk = $false
    if (
        (Get-ConfigValue -Config $config -Key 'CTI_CODEX_API_KEY') -or
        $env:CTI_CODEX_API_KEY -or
        $env:CODEX_API_KEY -or
        $env:OPENAI_API_KEY
    ) {
        $codexAuthOk = $true
    } elseif (Test-CodexAuthFile -Path $codexAuthFile) {
        $codexAuthOk = $true
    } elseif ($codexCmd) {
        try {
            $authText = (& $codexCmd.Source login --help 2>&1 | Out-String)
            $codexAuthOk = $authText -match 'logout'
        } catch {
            $codexAuthOk = $false
        }
    }
    Add-Result "Codex auth available (API key or codex auth login)" ($codexAuthOk -or $runtime -ne 'codex')
}

if (Test-Path $DaemonMjs) {
    $bundleTime = (Get-Item $DaemonMjs).LastWriteTimeUtc
    $sources = @()
    if (Test-Path (Join-Path $SkillDir 'src')) {
        $sources += Get-ChildItem -Path (Join-Path $SkillDir 'src') -Filter '*.ts' -Recurse
    }
    if (Test-Path (Join-Path $SkillDir 'node_modules\claude-to-im\src')) {
        $sources += Get-ChildItem -Path (Join-Path $SkillDir 'node_modules\claude-to-im\src') -Filter '*.ts' -Recurse
    }
    $staleSource = $sources | Where-Object { $_.LastWriteTimeUtc -gt $bundleTime } | Select-Object -First 1
    $daemonLabel = if ($staleSource) { "dist/daemon.mjs is up to date (stale source: $($staleSource.FullName))" } else { 'dist/daemon.mjs is up to date' }
    Add-Result $daemonLabel (-not $staleSource)
} else {
    Add-Result "dist/daemon.mjs exists" $false
}

Add-Result "config.env exists" (Test-Path $ConfigFile)
if (Test-Path $ConfigFile) {
    Test-FileAcl -Path $ConfigFile
}

$channels = Get-EnabledChannels -Config $config

if ($channels -contains 'telegram') {
    $tgToken = Get-ConfigValue -Config $config -Key 'CTI_TG_BOT_TOKEN'
    if ($tgToken) {
        try {
            $tgResult = Invoke-RestMethod -Uri "https://api.telegram.org/bot$tgToken/getMe" -Method Get -TimeoutSec 10
            Add-Result "Telegram bot token is valid" ($tgResult.ok -eq $true)
        } catch {
            Add-Result "Telegram bot token is valid" $false
        }
    } else {
        Add-Result "Telegram bot token configured" $false
    }
}

if ($channels -contains 'feishu') {
    $fsAppId = Get-ConfigValue -Config $config -Key 'CTI_FEISHU_APP_ID'
    $fsSecret = Get-ConfigValue -Config $config -Key 'CTI_FEISHU_APP_SECRET'
    $fsDomain = Get-ConfigValue -Config $config -Key 'CTI_FEISHU_DOMAIN' -Default 'https://open.feishu.cn'
    if ($fsAppId -and $fsSecret) {
        try {
            $fsResult = Invoke-JsonPost -Uri "$fsDomain/open-apis/auth/v3/tenant_access_token/internal" -Body @{
                app_id = $fsAppId
                app_secret = $fsSecret
            }
            Add-Result "Feishu app credentials are valid" ($fsResult.code -eq 0)
        } catch {
            Add-Result "Feishu app credentials are valid" $false
        }
    } else {
        Add-Result "Feishu app credentials configured" $false
    }
}

if ($channels -contains 'qq') {
    $qqAppId = Get-ConfigValue -Config $config -Key 'CTI_QQ_APP_ID'
    $qqAppSecret = Get-ConfigValue -Config $config -Key 'CTI_QQ_APP_SECRET'
    if ($qqAppId -and $qqAppSecret) {
        try {
            $qqTokenResult = Invoke-JsonPost -Uri 'https://bots.qq.com/app/getAppAccessToken' -Body @{
                appId = $qqAppId
                clientSecret = $qqAppSecret
            }
            $qqAccessToken = $qqTokenResult.access_token
            Add-Result "QQ app credentials are valid" ([string]::IsNullOrWhiteSpace($qqAccessToken) -eq $false)
            if ($qqAccessToken) {
                try {
                    $qqGateway = Invoke-RestMethod -Uri 'https://api.sgroup.qq.com/gateway' -Headers @{
                        Authorization = "QQBot $qqAccessToken"
                    } -Method Get -TimeoutSec 10
                    Add-Result "QQ gateway is reachable" ($null -ne $qqGateway.url)
                } catch {
                    Add-Result "QQ gateway is reachable" $false
                }
            }
        } catch {
            Add-Result "QQ app credentials are valid" $false
        }
    } else {
        Add-Result "QQ app credentials configured" $false
    }
}

if ($channels -contains 'discord') {
    $discordToken = Get-ConfigValue -Config $config -Key 'CTI_DISCORD_BOT_TOKEN'
    if ($discordToken) {
        Add-Result "Discord bot token format" ($discordToken -match '^[A-Za-z0-9_-]{20,}\.')
    } else {
        Add-Result "Discord bot token configured" $false
    }
}

if ($channels -contains 'weixin') {
    $weixinAccountsFile = Join-Path (Join-Path $CtiHome 'data') 'weixin-accounts.json'
    if (Test-Path $weixinAccountsFile) {
        try {
            $accounts = Get-Content $weixinAccountsFile -Raw | ConvertFrom-Json
            if ($null -eq $accounts) {
                $accounts = @()
            } elseif ($accounts -isnot [System.Collections.IEnumerable] -or $accounts -is [string]) {
                $accounts = @($accounts)
            }

            $enabledAccounts = @($accounts | Where-Object { $_.enabled -and $_.token })
            if ($enabledAccounts.Count -ge 1) {
                if ($accounts.Count -gt 1) {
                    Add-Result "Weixin linked account store is ready ($($accounts.Count) records; newest enabled account will be used)" $true
                } else {
                    Add-Result "Weixin linked account store is ready" $true
                }
            } else {
                Add-Result "Weixin linked account store has an enabled account with token" $false
            }
        } catch {
            Add-Result "Weixin linked account store is readable" $false
        }
    } else {
        Add-Result "Weixin linked account store exists" $false
    }
}

if (Test-Path $LogDir) {
    try {
        $tmpFile = Join-Path $LogDir ("doctor-write-test-{0}.tmp" -f [guid]::NewGuid().ToString('N'))
        Set-Content -Path $tmpFile -Value 'ok' -Encoding ascii
        Remove-Item $tmpFile -Force
        Add-Result "Log directory is writable" $true
    } catch {
        Add-Result "Log directory is writable" $false
    }
} else {
    Add-Result "Log directory exists" $false
}

$service = Get-Service -Name 'ClaudeToIMBridge' -ErrorAction SilentlyContinue
if ($service) {
    Add-Result "Windows Service registration is healthy ($($service.Status))" $true
}

if (Test-Path $PidFile) {
    $pid = (Get-Content $PidFile -Raw).Trim()
    Add-Result "PID file is consistent" (Test-PidAlive -Pid $pid)
} else {
    Add-Result "PID file consistency (no PID file, OK)" $true
}

if (Test-Path $LogFile) {
    $recentErrors = @(
        Get-Content $LogFile -Tail 50 |
        Where-Object { $_ -match 'ERROR|Fatal' }
    )
    Add-Result "No recent errors in log (last 50 lines)" ($recentErrors.Count -eq 0)
} else {
    Add-Result "Log file exists (not yet created)" $true
}

Write-Host ""
Write-Host "Results: $Pass passed, $Fail failed"

if ($Fail -gt 0) {
    Write-Host ""
    Write-Host "Common fixes:"
    Write-Host "  npm dependencies missing  -> cd `"$SkillDir`"; npm install"
    Write-Host "  daemon bundle stale       -> cd `"$SkillDir`"; npm run build"
    Write-Host "  config missing            -> create `"$ConfigFile`" from config.env.example"
    Write-Host "  Codex auth missing        -> run `codex auth login` or set OPENAI_API_KEY"
    Write-Host "  Weixin account missing    -> cd `"$SkillDir`"; npm run weixin:login"
    Write-Host "  stale pid                 -> powershell -File `"$SkillDir\scripts\daemon.ps1`" stop"
}

if ($Fail -eq 0) {
    exit 0
}

exit 1
