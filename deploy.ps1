# DeepSeek desktop client deploy: stop -> uninstall old -> install newest -> launch
# Keep this file ASCII-only: Windows PowerShell 5.1 decodes BOM-less UTF-8 as ANSI
# and silently mangles CJK literals.
$ErrorActionPreference = 'Stop'

$root    = $PSScriptRoot
$outDir  = Join-Path $root 'inno-out'
$issFile = Join-Path $root 'installer.iss'

function Step($m) { Write-Host "[deploy] $m" }

# --- 1. stop a running client ------------------------------------------------
$running = @(Get-Process -Name 'DeepSeek' -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
  Step ("stopping " + $running.Count + " running DeepSeek.exe process(es)")
  $running | Stop-Process -Force
  Start-Sleep -Milliseconds 1200
} else {
  Step 'no DeepSeek.exe process is running'
}

# --- 2. resolve this product's AppId from installer.iss ----------------------
# Never match by display name wildcard: this machine also has an unrelated
# "DeepSeek Harness" registered in Add/Remove Programs, and a *DeepSeek*
# pattern would uninstall that too.
$appId = ''
if (Test-Path -LiteralPath $issFile) {
  $iss = Get-Content -LiteralPath $issFile -Raw
  $mA = [regex]::Match($iss, 'AppId\s*=\s*(\{[^}]+\})')
  if ($mA.Success) {
    # installer.iss writes AppId={{GUID} — the doubled brace is Inno's escape for a
    # literal '{'. The registry key is {GUID}_is1, so without unescaping this match
    # can never succeed and uninstall silently falls back to hardcoded paths.
    $appId = ($mA.Groups[1].Value -replace '\{\{', '{')
  }
}
if (-not $appId) {
  Step 'WARNING: AppId not found in installer.iss, falling back to exact name "DeepSeek"'
} else {
  Step ("product AppId: " + $appId)
}

# --- 3. uninstall previous copies --------------------------------------------
$targets = @()
$regRoots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
# Inno writes UninstallString / QuietUninstallString quoted and sometimes with
# trailing switches. Only the outer quotes can be stripped safely — splitting on
# spaces would break "C:\Program Files\…".
function Get-UninsPath($prop) {
  foreach ($raw in @($prop.QuietUninstallString, $prop.UninstallString)) {
    if (-not $raw) { continue }
    $s = [string]$raw
    $p = $null
    if ($s -match '^\s*"([^"]+\.exe)"') { $p = $Matches[1] }
    elseif ($s -match '^\s*(\S+\.exe)(\s|$)') { $p = $Matches[1] }
    if ($p -and (Test-Path -LiteralPath $p)) { return $p }
  }
  return $null
}

foreach ($rk in $regRoots) {
  if (-not (Test-Path $rk)) { continue }
  foreach ($k in (Get-ChildItem $rk -ErrorAction SilentlyContinue)) {
    $prop = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
    if (-not $prop) { continue }
    # exact key name ({GUID}_is1) first, exact display name second.
    # Never use a *DeepSeek* wildcard: "DeepSeek Harness" is an unrelated product.
    $mine = ($appId -and ($k.PSChildName -eq ($appId + '_is1'))) -or
            ($prop.DisplayName -eq 'DeepSeek')
    if ($mine) {
      $p = Get-UninsPath $prop
      if ($p -and ($targets -notcontains $p)) { $targets += $p }
    }
  }
}
# Fallback: unins000.exe wherever {autopf} may have placed it
foreach ($cand in @(
  (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek\unins000.exe'),
  (Join-Path $env:ProgramFiles  'DeepSeek\unins000.exe')
)) {
  if ((Test-Path -LiteralPath $cand) -and ($targets -notcontains $cand)) { $targets += $cand }
}

if ($targets.Count -eq 0) {
  Step 'nothing installed to remove'
} else {
  foreach ($u in $targets) {
    Step ('uninstalling: ' + $u)
    $proc = Start-Process -FilePath $u -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART' -Wait -PassThru
    # Inno: 0 = ok, 1 = user aborted, 2 = invalid parameter, 3 = aborted by system.
    # Ignoring this would let the install proceed on top of a half-removed version.
    if ($proc.ExitCode -ne 0) {
      throw ('uninstaller exited with code ' + $proc.ExitCode + ' for ' + $u)
    }
  }
}

# --- 4. pick the highest-versioned setup exe in inno-out ---------------------
$pkgs = @()
foreach ($f in (Get-ChildItem -LiteralPath $outDir -Filter 'DeepSeek-Setup-*.exe' -ErrorAction SilentlyContinue)) {
  $mV = [regex]::Match($f.Name, '^DeepSeek-Setup-(\d+(?:\.\d+)*)\.exe$')
  if ($mV.Success) { $pkgs += [pscustomobject]@{ File = $f; Ver = [version]$mV.Groups[1].Value } }
}
if ($pkgs.Count -eq 0) { throw ("no DeepSeek-Setup-*.exe found in " + $outDir) }
$pick = $pkgs | Sort-Object Ver -Descending | Select-Object -First 1
Step ('installing v' + $pick.Ver + '  <- ' + $pick.File.Name + ' (' + [math]::Round($pick.File.Length / 1MB, 2) + ' MB)')

# --- 5. silent install -------------------------------------------------------
$inst = Start-Process -FilePath $pick.File.FullName `
  -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART' -Wait -PassThru
# Inno: 0 = ok, 1 = user aborted, 2 = invalid parameter. Without this check a failed
# install still reaches step 6, where the *previous* DeepSeek.exe is still on disk
# and everything looks green.
if ($inst.ExitCode -ne 0) {
  throw ('installer exited with code ' + $inst.ExitCode + ' for ' + $pick.File.Name)
}

# --- 6. locate and launch ----------------------------------------------------
$exe = $null
foreach ($cand in @(
  (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek\DeepSeek.exe'),
  (Join-Path $env:ProgramFiles  'DeepSeek\DeepSeek.exe')
)) { if (Test-Path -LiteralPath $cand) { $exe = $cand; break } }
if (-not $exe) { throw 'install reported no error but DeepSeek.exe was not found' }

$vi = (Get-Item -LiteralPath $exe).VersionInfo
Step ('installed: ' + $exe + '   version ' + $vi.ProductVersion)
# The exe's version resource comes from build time, not from the package filename,
# so a stale build can be shipped under a new version number. Compare explicitly.
if ($vi.ProductVersion -notlike ([string]$pick.Ver + '*')) {
  throw ('installed exe reports ' + $vi.ProductVersion + ' but the package was v' + $pick.Ver)
}

# If this script is invoked from an automation shell that exports
# ELECTRON_RUN_AS_NODE=1, the child electron process degrades into a plain Node
# interpreter and dies immediately (require("electron").app becomes undefined).
# Never let that leak into the app we are launching.
if (Test-Path 'Env:ELECTRON_RUN_AS_NODE') {
  Step 'clearing ELECTRON_RUN_AS_NODE for the launched process'
  Remove-Item 'Env:ELECTRON_RUN_AS_NODE' -ErrorAction SilentlyContinue
}
Start-Process -FilePath $exe

# Confirm it actually stayed up; a silent crash here used to look like a broken build.
$alive = $false
for ($i = 0; $i -lt 6; $i++) {
  Start-Sleep -Seconds 2
  if (@(Get-Process -Name 'DeepSeek' -ErrorAction SilentlyContinue).Count -gt 0) { $alive = $true; break }
}
if ($alive) { Step 'launched and running' } else { throw 'app launched but no DeepSeek.exe process survived 12s' }
Step 'done'
