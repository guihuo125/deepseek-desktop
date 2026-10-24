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
  if ($mA.Success) { $appId = $mA.Groups[1].Value }
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
foreach ($rk in $regRoots) {
  if (-not (Test-Path $rk)) { continue }
  foreach ($k in (Get-ChildItem $rk -ErrorAction SilentlyContinue)) {
    $prop = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
    if (-not $prop) { continue }
    $mine = ($appId -and ($k.PSChildName -like ('*' + $appId + '*'))) -or
            ($prop.DisplayName -eq 'DeepSeek')
    if ($mine -and $prop.UninstallString) {
      $path = ($prop.UninstallString -replace '^"','' -replace '"$','')
      if ((Test-Path -LiteralPath $path) -and ($targets -notcontains $path)) { $targets += $path }
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
    Start-Process -FilePath $u -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART' -Wait
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
Start-Process -FilePath $pick.File.FullName `
  -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART' -Wait

# --- 6. locate and launch ----------------------------------------------------
$exe = $null
foreach ($cand in @(
  (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek\DeepSeek.exe'),
  (Join-Path $env:ProgramFiles  'DeepSeek\DeepSeek.exe')
)) { if (Test-Path -LiteralPath $cand) { $exe = $cand; break } }
if (-not $exe) { throw 'install reported no error but DeepSeek.exe was not found' }

$vi = (Get-Item -LiteralPath $exe).VersionInfo
Step ('installed: ' + $exe + '   version ' + $vi.ProductVersion)

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
