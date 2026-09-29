# 启动所有已配置的机器人：配置了几个就启动几个。
#
# 规则：
#   - 目标 = 默认实例（若 ~/.config/opencode/opencode-qq.json 还在）+ ~/.config/opencode/bots/*
#   - 已经在运行的（实例锁里的 pid 存活）→ 打印 [skip]，不重复开窗口
#   - 配置还是模板占位符（REPLACE_ME）→ 跳过
#
# 用法: pwsh -File scripts/start-all.ps1 [-NoPause]
param(
    [switch]$NoPause
)

$ErrorActionPreference = 'Continue'

$repo     = Split-Path -Parent $PSScriptRoot
$cfgRoot  = Join-Path $env:USERPROFILE '.config\opencode'
$launcher = Join-Path $repo 'start-bridge.cmd'

if (-not (Test-Path -LiteralPath $launcher)) { throw "launcher not found: $launcher" }

# ---- 收集目标 ----
$targets = New-Object System.Collections.ArrayList

$defaultCfg = Join-Path $cfgRoot 'opencode-qq.json'
if (Test-Path -LiteralPath $defaultCfg) {
    [void]$targets.Add([PSCustomObject]@{ Name = ''; Dir = $cfgRoot; Cfg = $defaultCfg })
}

$botsDir = Join-Path $cfgRoot 'bots'
if (Test-Path -LiteralPath $botsDir) {
    foreach ($d in Get-ChildItem -LiteralPath $botsDir -Directory -ErrorAction SilentlyContinue) {
        $cfg = Join-Path $d.FullName 'opencode-qq.json'
        if (Test-Path -LiteralPath $cfg) {
            [void]$targets.Add([PSCustomObject]@{ Name = $d.Name; Dir = $d.FullName; Cfg = $cfg })
        }
    }
}

# 该实例是否已在运行：看实例锁里的 pid 是否存活
function Test-InstanceRunning {
    param([string]$Dir)
    $lock = Join-Path $Dir 'opencode-qq-instance.lock'
    if (-not (Test-Path -LiteralPath $lock)) { return $false }
    try {
        $raw = Get-Content -LiteralPath $lock -Raw | ConvertFrom-Json
    } catch {
        return $false
    }
    # 注意：PowerShell 里没有 process.kill()，必须用 Get-Process 判断存活
    return $null -ne (Get-Process -Id ([int]$raw.pid) -ErrorAction SilentlyContinue)
}

# 配置还是模板占位符（REPLACE_ME）→ 启动也没意义
function Test-PlaceholderConfig {
    param([string]$Cfg)
    try { return ((Get-Content -LiteralPath $Cfg -Raw) -match 'REPLACE_ME') } catch { return $false }
}

$started = 0
$skipped = 0

foreach ($t in $targets) {
    $label = if ($t.Name) { $t.Name } else { '(default)' }

    if (Test-PlaceholderConfig -Cfg $t.Cfg) {
        Write-Host ("[skip ] {0} - config is still a placeholder (REPLACE_ME)" -f $label)
        $skipped++
        continue
    }
    if (Test-InstanceRunning -Dir $t.Dir) {
        Write-Host ("[skip ] {0} - already running" -f $label)
        $skipped++
        continue
    }

    if ($t.Name) {
        Start-Process -FilePath $launcher -ArgumentList $t.Name -WorkingDirectory $repo
    } else {
        Start-Process -FilePath $launcher -WorkingDirectory $repo
    }
    Write-Host ("[start] {0}" -f $label)
    $started++
}

Write-Host ''
if ($targets.Count -eq 0) {
    Write-Host 'No configured bots found (nothing to start).'
} else {
    Write-Host ("Done. started={0}  skipped={1}" -f $started, $skipped)
}

if (-not $NoPause) {
    Write-Host ''
    [void](Read-Host 'Press Enter to close this window')
}
