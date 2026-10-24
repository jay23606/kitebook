# Kitebook in one step, on Windows. Paste this one line into PowerShell and press Enter:
#   irm https://raw.githubusercontent.com/um1b/kitebook/main/scripts/get.ps1 | iex
# It needs no admin and asks one thing: a master password for Kitebook on this PC (hidden, typed twice; it never leaves it). Run by an agent
# or a script (no console), it asks nothing and finishes LOCKED, printing a one-time local link where the person types the password later.
# Run it again any time: it keeps what's there and repairs what's missing.
#   1. git (winget, for this user; else a private MinGit in ~\.kitebook-git, sha256-checked against GitHub's digest), bun (bun.sh's own
#      installer) and Node 22 (a private copy in ~\.kitebook-node, sha256-checked against nodejs.org's list) when they're missing
#   2. the Kitebook code: a git clone of the stable branch (main) in ~\.kitebook-app (updates move it forward)
#   3. the server: workerd on 127.0.0.1:7820 (scripts/serve.ts), data in ~\.kitebook-server, kept running by Kitebook's supervisor and started
#      when you sign in to Windows (a per-user Scheduled Task). Public access is off: only this PC reaches it (the built-in tunnel's helper
#      runs idle the same way; Settings -> Connection -> Turn on public access downloads cloudflared once, sha256-checked, and starts it).
#   4. the runner on this same PC (a one-time invite made with the server's own key, never shown), the coding agents found here connected
#      to it, and "Install updates automatically" on, started at sign-in the same way
#   5. the `kitebook` command in %LOCALAPPDATA%\Kitebook\bin, added to your PATH (new terminals)
#   6. your browser opened on Kitebook, signed in (no token to copy; the recovery code stays in ~\.kitebook-app\.dev.vars)
# Log: %LOCALAPPDATA%\Kitebook\logs\kitebook-install.log. Env (advanced): KITEBOOK_APP, PORT (7820), KITEBOOK_REPO, KITEBOOK_BRANCH (main), KITEBOOK_NO_OPEN=1,
#   KITEBOOK_BIN_DIR, KITEBOOK_AGENTS=0 (don't connect coding agents).
# Continue, not Stop: Windows PowerShell 5.1 turns a native program's stderr into a terminating error under Stop; downloads below say -ErrorAction Stop
$ErrorActionPreference = 'Continue'; $ProgressPreference = 'SilentlyContinue'; $OK = [char]0x2713 # the check mark, without depending on this file's encoding
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
function Or($a, $b) { if ($a) { $a } else { $b } }
$CLI = 'kitebook'
# RELAY_* (the names from before the rename to Kitebook) still work: each fills its unset KITEBOOK_* twin
Get-ChildItem Env: | Where-Object { $_.Name -like 'RELAY_*' } | ForEach-Object { $n = 'KITEBOOK_' + $_.Name.Substring(6); if (-not (Test-Path "Env:$n")) { Set-Item "Env:$n" $_.Value } }
# an install from before the rename: its folders take the new names, each old name left as a junction to the new one (a folder a running
# program holds can't move on Windows; then it stays where it is and is used from there)
$LocalA = Or $env:LOCALAPPDATA (Join-Path $HOME 'AppData\Local')
foreach ($p in @(@((Join-Path $HOME '.relay-runner'), (Join-Path $HOME '.kitebook')), @((Join-Path $HOME '.relay-server'), (Join-Path $HOME '.kitebook-server')), @((Join-Path $HOME '.relay-app'), (Join-Path $HOME '.kitebook-app')), @((Join-Path $HOME '.relay-node'), (Join-Path $HOME '.kitebook-node')), @((Join-Path $HOME '.relay'), (Join-Path $HOME '.kitebook-kb')), @((Join-Path $LocalA 'Relay'), (Join-Path $LocalA 'Kitebook')))) {
  $o, $n = $p; $it = Get-Item $o -Force -ErrorAction SilentlyContinue
  if ($it -and $it.PSIsContainer -and -not ($it.Attributes -band [IO.FileAttributes]::ReparsePoint) -and -not (Test-Path $n)) {
    try { Move-Item -ErrorAction Stop $o $n; try { New-Item -ItemType Junction -Path $o -Target $n -ErrorAction Stop | Out-Null } catch { Move-Item $n $o } } catch {} } }
$Old = { param($new, $old) if (-not (Test-Path $new) -and (Test-Path $old)) { $old } else { $new } } # a folder that couldn't move is used where it is
$Repo = Or $env:KITEBOOK_REPO 'https://github.com/um1b/kitebook'; $Branch = Or $env:KITEBOOK_BRANCH 'main'
$App = Or $env:KITEBOOK_APP (& $Old (Join-Path $HOME '.kitebook-app') (Join-Path $HOME '.relay-app')); $Port = Or $env:PORT '7820'; $Url = "http://127.0.0.1:$Port"
$Local = Or $env:LOCALAPPDATA (Join-Path $HOME 'AppData\Local')
$Bin = Or $env:KITEBOOK_BIN_DIR (Join-Path $Local 'Kitebook\bin'); $Cfg = Join-Path (& $Old (Join-Path $HOME '.kitebook') (Join-Path $HOME '.relay-runner')) 'runner.json'
$LogDir = Join-Path $Local 'Kitebook\logs'; New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Log = Join-Path $LogDir 'kitebook-install.log'; Set-Content -Path $Log -Value '' -Encoding UTF8
$env:NO_PROXY = (@($env:NO_PROXY, 'localhost,127.0.0.1') | Where-Object { $_ }) -join ','; $env:no_proxy = $env:NO_PROXY
function Say($m) { Write-Host $m; Add-Content -Path $Log -Value $m }
function Die($m) { Say "Kitebook couldn't finish: $m"; Say "Details: $Log. Running the same line again picks up where it stopped."; throw "kitebook install stopped" }
# run a program, its output to the log; $true when it exited 0. A plain function ($args), not [Parameter()]: an advanced one would try to bind
# a program's own flags (-q, --id) as PowerShell parameters. ('--' itself never reaches a program from here: PowerShell eats it; jobs.ts takes --run)
function Quiet { $exe = $args[0]; $rest = @($args | Select-Object -Skip 1)
  $o = & $exe @rest 2>&1; $c = $LASTEXITCODE; $o | ForEach-Object { Add-Content -Path $Log -Value "$_" }; return ($c -eq 0) }
function Have($n) { [bool](Get-Command $n -ErrorAction SilentlyContinue) }
function AddPath($d) { if (($env:Path -split ';') -notcontains $d) { $env:Path = "$d;$env:Path" } }
Say 'Installing Kitebook on this PC. This takes a few minutes and asks nothing.'

# 1. tools
if (-not (Have git)) {
  Say '  getting git'
  if (Have winget) { Quiet winget install --id Git.Git -e --silent --scope user --accept-package-agreements --accept-source-agreements | Out-Null
    foreach ($d in @((Join-Path $Local 'Programs\Git\cmd'), "$env:ProgramFiles\Git\cmd")) { if (Test-Path (Join-Path $d 'git.exe')) { AddPath $d } } }
  if (-not (Have git)) { # no winget (or it failed): a private MinGit, checked against the digest GitHub publishes for the asset
    $rel = Invoke-RestMethod -UseBasicParsing -ErrorAction Stop 'https://api.github.com/repos/git-for-windows/git/releases/latest'
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { '64-bit' }
    $asset = $rel.assets | Where-Object { $_.name -match "^MinGit-[\d.]+-$arch\.zip$" } | Select-Object -First 1
    if (-not $asset) { Die "no MinGit for this PC on GitHub" }
    $zip = Join-Path $env:TEMP $asset.name; Invoke-WebRequest -UseBasicParsing -ErrorAction Stop $asset.browser_download_url -OutFile $zip
    $want = "$($asset.digest)" -replace '^sha256:', ''
    if (-not $want -or (Get-FileHash $zip -Algorithm SHA256).Hash -ne $want.ToUpper()) { Die "the git download didn't match GitHub's checksum; nothing was installed" }
    $gd = Join-Path $HOME '.kitebook-git'; if (Test-Path $gd) { Remove-Item -Recurse -Force $gd }; Expand-Archive -ErrorAction Stop -Path $zip -DestinationPath $gd; Remove-Item $zip
    AddPath (Join-Path $gd 'cmd')
  }
  if (-not (Have git)) { Die "git didn't install" }
}
$Bun = (Get-Command bun -ErrorAction SilentlyContinue).Source; if (-not $Bun -and (Test-Path "$HOME\.bun\bin\bun.exe")) { $Bun = "$HOME\.bun\bin\bun.exe" }
if (-not $Bun) { Say '  getting bun (from bun.sh)'; $s = Invoke-RestMethod -UseBasicParsing -ErrorAction Stop 'https://bun.sh/install.ps1'; $null = (& ([scriptblock]::Create($s)) *>&1 | Out-String)
  $Bun = "$HOME\.bun\bin\bun.exe"; if (-not (Test-Path $Bun)) { Die "bun didn't install" } }
AddPath (Split-Path $Bun)
# Node 22.18+ builds the server. An older or missing node gets a private copy, checked against nodejs.org's sums.
function NodeOk($n) { if (-not $n -or -not (Test-Path $n)) { return $false } # node --version, parsed here (5.1 mangles quotes in a -e argument)
  $v = "$(& $n --version 2>$null)".TrimStart('v').Split('.'); if ($v.Count -lt 2) { return $false }; $a = [int]$v[0]; $b = [int]$v[1]; return ($a -gt 22 -or ($a -eq 22 -and $b -ge 18)) }
$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not (NodeOk $Node)) {
  $Node = Join-Path $HOME '.kitebook-node\node.exe'
  if (-not (NodeOk $Node)) {
    Say '  getting Node 22 (a private copy for Kitebook in ~\.kitebook-node)'
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }; $D = 'https://nodejs.org/dist/latest-v22.x'
    $sums = (Invoke-WebRequest -UseBasicParsing -ErrorAction Stop "$D/SHASUMS256.txt").Content -split "`n"
    $line = $sums | Where-Object { $_ -match "node-v22[\d.]+-win-$arch\.zip$" } | Select-Object -First 1; if (-not $line) { Die "no Node 22 for this PC on nodejs.org" }
    $sum, $F = ($line.Trim() -split '\s+'); $zip = Join-Path $env:TEMP $F; Invoke-WebRequest -UseBasicParsing -ErrorAction Stop "$D/$F" -OutFile $zip
    if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $sum.ToUpper()) { Die "the Node download didn't match nodejs.org's checksum; nothing was installed" }
    $nd = Join-Path $HOME '.kitebook-node'; $tmp = Join-Path $env:TEMP "kitebook-node-$PID"; if (Test-Path $nd) { Remove-Item -Recurse -Force $nd }
    Expand-Archive -ErrorAction Stop -Path $zip -DestinationPath $tmp; Move-Item (Get-ChildItem $tmp | Select-Object -First 1).FullName $nd; Remove-Item -Recurse -Force $tmp, $zip
  }
}
AddPath (Split-Path $Node)

# 2. the code (the stable branch; a second run fast-forwards it, like an update you asked for)
if (Test-Path (Join-Path $App '.git')) {
  if (-not ((Quiet git -C $App fetch -q origin $Branch) -and (Quiet git -C $App merge --ff-only -q "origin/$Branch"))) { Say "  (kept the Kitebook code as it is: $App has changes of its own)" }
} else { Say '  getting Kitebook'; if (-not (Quiet git clone -q -b $Branch $Repo $App)) { Die "couldn't download Kitebook from $Repo" } }
Set-Location $App
if (-not (Test-Path 'node_modules')) { Say '  installing its parts (npm, once)'; if (-not (Quiet npm.cmd install --no-audit --no-fund)) { Die 'npm install failed' } }

# 3. the server, local only (public access is a later switch in Settings -> Connection)
Say '  starting the server'
if (-not (Test-Path '.dev.vars') -or -not (Select-String -Path '.dev.vars' -Pattern '^ADMIN_TOKEN=' -Quiet)) {
  $b = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); $tok = -join ($b | ForEach-Object { $_.ToString('x2') })
  Set-Content -Path '.dev.vars' -Value "ADMIN_TOKEN=$tok" -Encoding ASCII; $tok = $null
  icacls .dev.vars /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null # only you can read it (the 0600 of Windows)
}
$Data = & $Old (Join-Path $HOME '.kitebook-server') (Join-Path $HOME '.relay-server')
$null = Quiet $Bun client/rebrand.ts $Cfg # the rest of the rename for an older install (its jobs, runner.json, the relay command); nothing for a new one
if (-not (Quiet $Bun scripts/serve.ts build)) { Die "couldn't build the server" }
if (-not (Quiet $Bun client/jobs.ts install kitebook-server --cwd $App --env "PORT=$Port" --env "KITEBOOK_DATA=$Data" --env "PATH=$env:Path" --run $Bun (Join-Path $App 'scripts\serve.ts'))) { Die "the server didn't start" }
$up = $false; for ($i = 0; $i -lt 90 -and -not $up; $i++) { try { $up = (Invoke-WebRequest -UseBasicParsing "$Url/health" -TimeoutSec 2 -ErrorAction Stop).StatusCode -eq 200 } catch { Start-Sleep 1 } }
if (-not $up) { Die "the server isn't answering on $Url (kitebook logs server)" }

# 4. this PC as its runner (the invite is made with the server's own key from .dev.vars; it's never printed)
$NewRun = $false
if (-not ((Test-Path $Cfg) -and (Select-String -Path $Cfg -Pattern ([regex]::Escape("`"url`": `"$Url`"")) -Quiet))) {
  if (Test-Path $Cfg) { Move-Item $Cfg "$Cfg.before-$(Get-Date -Format yyyyMMdd-HHmmss)"; Say "  (set your earlier runner settings aside next to $Cfg)" }
  Say '  connecting this PC'
  $env:KITEBOOK_URL = $Url; $env:KITEBOOK_ADMIN_TOKEN = ((Get-Content '.dev.vars' | Where-Object { $_ -match '^ADMIN_TOKEN=' }) -replace '^ADMIN_TOKEN=', '').Trim()
  $inv = (& $Bun client/admin.ts invite main runner 'read,write,delete,dispatch' 'tasks/**' 'shared/**' 'repos/**' 'kb/**' 2>>$Log) -replace '.*/join/', ''
  Remove-Item Env:KITEBOOK_ADMIN_TOKEN
  if ("$inv" -notmatch '^inv_') { Die "couldn't make the runner's invite" }
  if (-not (Quiet $Bun client/runner.ts init $Url "$inv" --out $Cfg --no-install --installer)) { Die "couldn't connect this PC to its server" }; $inv = $null; $NewRun = $true
}
# where updates come from: this checkout runs both the server and the runner, and updates itself (stable, when idle)
# (a script file, not bun -e: Windows PowerShell 5.1 mangles double quotes inside native-command arguments)
$js = Join-Path $env:TEMP "kitebook-cfg-$PID.ts"
Set-Content -Path $js -Encoding UTF8 -Value 'const fs = require("fs"), [f, app, url, auto] = process.argv.slice(2), c = JSON.parse(fs.readFileSync(f, "utf8")); c.source = app; c.server = { ...(c.server ?? {}), dir: app, health: url + "/health" }; if (auto === "1" && c.autoUpdate == null) c.autoUpdate = true; fs.writeFileSync(f, JSON.stringify(c, null, 2), { mode: 0o600 }); const G = await import(require("url").pathToFileURL(app + "/client/guard.ts").href); G.stampOwnerEdit(f);'
$saved = Quiet $Bun $js $Cfg $App $Url $(if ($NewRun) { '1' } else { '0' }); Remove-Item $js -ErrorAction SilentlyContinue
if (-not $saved) { Die "couldn't save the runner's settings" }
$AG = ''; if ($env:KITEBOOK_AGENTS -ne '0') { $env:KITEBOOK_RUNNER_CONFIG = $Cfg; $AG = (& $Bun client/runner.ts connect $Cfg --installer 2>>$Log | Select-Object -Last 1) }
if (-not (Quiet $Bun client/runner.ts install $Cfg)) { Die "the runner didn't start" }
# the built-in tunnel's helper, kept running the same way, public access off (Settings -> Connection or `kitebook tunnel on` turns it on); not fatal
$env:KITEBOOK_RUNNER_CONFIG = $Cfg; if (-not (Quiet $Bun client/tunnel.ts install --port $Port --server-dir $App)) { Say "  (public access isn't set up yet: $CLI tunnel on does it later)" }

# 5. the kitebook command, on PATH for new terminals
New-Item -ItemType Directory -Force -Path $Bin | Out-Null; $cmd = Join-Path $Bin "$CLI.cmd"
if ((Test-Path $cmd) -and -not (Select-String -Path $cmd -Pattern '^rem Kitebook CLI' -Quiet)) { Say "  (left $cmd alone: it isn't Kitebook's)" }
else { Set-Content -Path $cmd -Encoding ASCII -Value "@echo off`r`nrem Kitebook CLI, installed by get.ps1: $CLI help`r`nif not defined KITEBOOK_RUNNER_CONFIG set `"KITEBOOK_RUNNER_CONFIG=$Cfg`"`r`n`"$Bun`" `"$(Join-Path $App 'client\cli.ts')`" %*" }
$up = [Environment]::GetEnvironmentVariable('Path', 'User'); if ((("$up" -split ';') -notcontains $Bin)) { [Environment]::SetEnvironmentVariable('Path', ((@($Bin, $up) | Where-Object { $_ }) -join ';'), 'User') }
# ...and check it: the user PATH must now hold the folder (client/cli-path.ts re-checks, adds it once more if not, else one line with the exact fix)
$env:KITEBOOK_BIN_DIR = $Bin; & $Bun client/cli-path.ts verify $Cfg | Out-Null; Remove-Item Env:KITEBOOK_BIN_DIR

# 5b. the master password (client/password.ts): the person at this console types it (hidden, twice). No console (an agent or a script):
#     Kitebook stays LOCKED and the summary shows a one-time local setup link (15 minutes, once) for the person. Never picked by the installer.
$PW = ''; if ($env:KITEBOOK_PASSWORD_STEP -ne '0') { $env:KITEBOOK_RUNNER_CONFIG = $Cfg; $PW = (& $Bun client/cli.ts password set --installer --wait 2>>$Log) -join "`n" }

# 6. the browser, signed in (a single-use 5-minute link the server makes with its own key)
$Opened = $false
if ($env:KITEBOOK_NO_OPEN -ne '1') {
  $env:KITEBOOK_URL = $Url; $env:KITEBOOK_ADMIN_TOKEN = ((Get-Content '.dev.vars' | Where-Object { $_ -match '^ADMIN_TOKEN=' }) -replace '^ADMIN_TOKEN=', '').Trim()
  $l = (& $Bun client/admin.ts open --print 2>>$Log | Select-String -Pattern 'http\S*#login=\S*' | Select-Object -Last 1).Matches.Value; Remove-Item Env:KITEBOOK_ADMIN_TOKEN
  if ($l) { Start-Process $l; $Opened = $true }
}
Say ''
Say "$OK Kitebook is installed and running on this PC (it starts by itself when you sign in and keeps itself up to date)."
if ("$AG" -like "$OK *") { Say (("$AG" -split ':')[0] + '.') }
if ($Opened) { Say "$OK Opened Kitebook in your browser, signed in." } else { Say "Open Kitebook any time at $Url/start" }
if ($PW) { Say $PW }
Say "Type $CLI in a new terminal window for help."
