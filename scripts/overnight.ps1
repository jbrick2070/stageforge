<#
StageForge overnight runner.

Runs Antigravity (agy) in Turbo-equivalent mode on the main branch: Sprints 0-3 from HANDOFF.md,
then self-directed improvement rounds that Claude Opus 5.5 helps choose, until the deadline or a
STOP file appears. Each round is one agy conversation, with up to two follow-up turns in the same
conversation (--conversation) to make sure the work is committed and the gate is green.

Pushing is blocked at the git level for the whole run (a pre-push hook plus a disabled pushurl),
because Antigravity's own deny rule does not stop `git push` under always-proceed.

Stop it early:  create the file  $env:TEMP\stageforge-overnight\STOP   (the current round finishes first)
Or close this window; then remove the guards with:  scripts\unguard-push.ps1
#>
param(
  [int[]]$Sprints = @(5),
  [double]$Hours = 10,   # 0 = no deadline
  [int]$FollowUps = 2,
  [string]$Model = 'gemini-4-carbon-high',   # agy model; run `agy models` for the list
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$logDir = Join-Path $env:TEMP 'stageforge-overnight'
$qaDir = Join-Path $env:TEMP 'stageforge-qa'
New-Item -ItemType Directory -Force $logDir, $qaDir | Out-Null
$runnerLog = Join-Path $logDir 'runner.log'
$stopFile = Join-Path $logDir 'STOP'
$settingsFile = Join-Path $env:TEMP 'agy-turbo.json'
$hookFile = Join-Path $repo '.git\hooks\pre-push'
$hookMarker = 'StageForge overnight run'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-RunLog([string]$message) {
  $line = '{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $message
  Write-Host $line
  Add-Content -Path $runnerLog -Value $line -Encoding utf8
}

function Stop-RepoProcesses {
  # Dev servers and Electron windows a round's tests left behind; only ones started from this repo.
  Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='electron.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$repo*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

# Antigravity Turbo equivalent: everything allowed, no sandbox, no review pauses. The deny rule is kept
# as documented, but it does not stop git push in this mode, so the git-level guards below do.
function Write-AgySettings {
  [IO.File]::WriteAllText($settingsFile, (@{
    agentMode = 'accept-edits'; toolPermission = 'always-proceed'; artifactReviewPolicy = 'always-proceed'
    allowNonWorkspaceAccess = $true; enableTerminalSandbox = $false
    permissions = @{ deny = @('command(git push)') }
  } | ConvertTo-Json -Depth 5), $utf8)
}

# Files under %TEMP% can be swept away mid-run: a tidy-up during Sprint 6 once deleted the settings file and
# the whole log folder, and every later agy call then failed instantly. Recreate what the run needs before
# every call.
function Restore-RunnerFiles {
  New-Item -ItemType Directory -Force $logDir, $qaDir | Out-Null
  if (-not (Test-Path $settingsFile)) { Write-AgySettings; Write-RunLog 'Recreated the missing agy settings file.' }
  $statusFile = Join-Path $logDir 'opus-status.txt'
  if ($script:opusStatus -and -not (Test-Path $statusFile)) { [IO.File]::WriteAllText($statusFile, $script:opusStatus, $utf8) }
}

function Invoke-Agy([string]$prompt, [string]$conversation, [string]$logFile) {
  Restore-RunnerFiles
  $agyArgs = @('-p', $prompt, '--settings', $settingsFile, '--output-format', 'json', '--print-timeout', '0')
  if ($Model) { $agyArgs += @('--model', $Model) }
  if ($conversation) { $agyArgs += @('--conversation', $conversation) }
  $raw = (& agy @agyArgs 2>&1 | Out-String)
  Add-Content -Path $logFile -Value $raw -Encoding utf8
  $line = ($raw -split "`r?`n" | Where-Object { $_ -match '^\s*\{' } | Select-Object -Last 1)
  if (-not $line) { return [pscustomobject]@{ status = 'NO_JSON'; conversation_id = $conversation; response = $raw } }
  try { return ($line | ConvertFrom-Json) } catch { return [pscustomobject]@{ status = 'BAD_JSON'; conversation_id = $conversation; response = $raw } }
}

if (-not $DryRun -and (git status --porcelain)) {
  Write-RunLog 'The working tree has uncommitted changes. Commit or stash them, then run this again.'
  exit 1
}
if (-not $DryRun -and (git branch --show-current) -ne 'main') {
  Write-RunLog "Not on main (on '$(git branch --show-current)'). Switch to main, then run this again."
  exit 1
}

Write-AgySettings

$deadline = if ($Hours -gt 0) { (Get-Date).AddHours($Hours) } else { [datetime]::MaxValue }
$baseline = (git ls-remote origin main 2>$null) -split "\s+" | Select-Object -First 1
Write-RunLog "Overnight run on main: sprints $($Sprints -join ', '), then self-directed rounds. Deadline: $(if ($Hours -gt 0) { $deadline.ToString('yyyy-MM-dd HH:mm') } else { 'none' }). origin/main is $($baseline.Substring(0, [Math]::Min(7, $baseline.Length)))."
if (Test-Path $stopFile) { Remove-Item $stopFile -Force }

Add-Type -Namespace StageForgeRunner -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
$previousPushUrl = git config --local --get remote.origin.pushurl
$hookInstalled = $false

try {
  if (-not $DryRun) {
    [void][StageForgeRunner.Power]::SetThreadExecutionState([uint32]'0x80000001')  # keep the PC awake
    if ((Test-Path $hookFile) -and -not ((Get-Content $hookFile -Raw) -match $hookMarker)) {
      Write-RunLog "A different pre-push hook already exists at $hookFile; not overwriting it. Remove it and run again."
      exit 1
    }
    [IO.File]::WriteAllText($hookFile, "#!/bin/sh`n# $hookMarker`necho 'pre-push: pushing is blocked during the overnight run. Do not bypass; the user pushes after review.' >&2`nexit 1`n", $utf8)
    $hookInstalled = $true
    git config --local remote.origin.pushurl 'DISABLED-during-overnight-run'
    Write-RunLog 'Push guards on: pre-push hook and disabled pushurl.'

    Write-RunLog 'Updating Claude Code so Opus 5.5 works for design and coding help...'
    claude update 2>&1 | ForEach-Object { Write-RunLog "  $_" }
    Write-RunLog "Claude Code version: $((claude --version) 2>&1)"
    $opus = ('Reply with exactly: OPUS-OK' | claude -p --model claude-opus-5-5 --allowedTools 'Bash(git log:*)' 2>&1 | Out-String).Trim()
    $opusStatus = if ($opus -match 'OPUS-OK') { 'Opus 5.5 WORKS: use --model claude-opus-5-5 for design and coding consults.' }
      else { "Opus 5.5 FAILED here (use --model claude-sonnet-5-5 for consults instead and log it). Output: $opus" }
    [IO.File]::WriteAllText((Join-Path $logDir 'opus-status.txt'), $opusStatus, $utf8)
    Write-RunLog $opusStatus
  }

  $rounds = @($Sprints | ForEach-Object { [pscustomobject]@{ kind = 'sprint'; n = $_ } })
  $k = 0
  $index = 0
  $failStreak = 0
  while ($true) {
    if (Test-Path $stopFile) { Write-RunLog 'STOP file found; ending.'; break }
    if ((Get-Date) -ge $deadline) { Write-RunLog 'Deadline reached; ending.'; break }
    if ($index -lt $rounds.Count) { $round = $rounds[$index]; $index++ }
    else { $k++; $round = [pscustomobject]@{ kind = 'self'; n = $k } }

    $common = "You are running unattended overnight, directly on the main branch, and the user is asleep, so make reasonable decisions yourself and log them. Read HANDOFF.md in this folder first, especially the Overnight run section, and read $logDir\opus-status.txt to see whether Claude Opus 5.5 is available. Use Claude Opus 5.5 through Claude CLI for design, architecture and coding help whenever it would improve the result, as HANDOFF.md describes; you decide and apply the code. Use Claude Sonnet 5.5 through Claude CLI to QA all code you change, verify each finding against the code before fixing it, and add a regression test for each real one. Pass the full gate on the final code, commit locally, and append your report to the Overnight log in HANDOFF.md and commit that too. Pushing is blocked by a pre-push hook and a disabled pushurl; never push, never bypass or remove those guards, never use --no-verify, never rewrite history."
    if ($round.kind -eq 'sprint') {
      $label = "Sprint $($round.n)"
      $prompt = "$common Run Sprint $($round.n) from the HANDOFF.md backlog in full, without cutting features."
    } else {
      $label = "Self-directed round $($round.n)"
      $prompt = "$common The HANDOFF.md sprints are finished or logged as blocked, so now choose the work yourself. First write a design consult to $qaDir\round-$($round.n)-design.md and send it to Claude Opus 5.5 as HANDOFF.md describes. In it, list what is already done (read the Overnight log and git log so nothing is repeated), and ask Opus to rank the five highest-value next improvements for StageForge, covering usability on a phone through the GitHub Pages site, correctness, performance, accessibility, stage-design realism, the open-standards roadmap including Sprint 4 items, and test gaps. Pick the top one worth doing, then implement it end to end following the loop."
    }
    $logFile = Join-Path $logDir ("{0}-{1}.log" -f $round.kind, $round.n)
    Write-RunLog "Starting $label (log: $logFile)"
    if ($DryRun) { Write-RunLog "  would run: agy -p <prompt> --settings $settingsFile --output-format json (+ up to $FollowUps follow-ups)"; if ($index -ge $rounds.Count -and $round.kind -eq 'sprint') { break } else { continue } }

    $result = Invoke-Agy $prompt $null $logFile
    Write-RunLog "$label turn 1: $($result.status), $([math]::Round([double]$result.duration_seconds / 60, 1)) min, conversation $($result.conversation_id)"
    # A call that fails at once (settings file gone, login expired, agy missing) is not a finished round. Retry the
    # same round, and stop after three in a row instead of spinning through the backlog.
    if ($result.status -ne 'SUCCESS' -and [double]$result.duration_seconds -lt 60) {
      $failStreak++
      if ($failStreak -ge 3) { Write-RunLog "agy failed immediately $failStreak times in a row ($($result.status)); stopping so the run does not spin. Fix the cause and run again."; break }
      Write-RunLog "agy failed immediately ($($result.status)); retrying $label in 20 s (attempt $($failStreak + 1) of 3)."
      Start-Sleep -Seconds 20
      if ($round.kind -eq 'sprint') { $index-- } else { $k-- }
      continue
    }
    $failStreak = 0
    for ($f = 1; $f -le $FollowUps -and $result.conversation_id; $f++) {
      $follow = 'Follow-up check. Run git status and git log -5. If your work for this round is not committed, or the full gate was not green on the final code, finish it now: fix, re-run the gate, commit. If the Overnight log entry is missing, add it and commit. If you cannot get to green, stash the unfinished work, say why in the Overnight log, and commit that note. Reply with one line: DONE, or BLOCKED followed by the reason.'
      $result = Invoke-Agy $follow $result.conversation_id $logFile
      $reply = ("$($result.response)").Trim()
      Write-RunLog "$label follow-up $f : $($result.status) : $($reply.Substring(0, [Math]::Min(160, $reply.Length)))"
      if ($reply -match '^\W*DONE') { break }
    }
    Stop-RepoProcesses

    if (git status --porcelain) {
      git stash push --include-untracked -m "overnight $label unfinished" | Out-Null
      Write-RunLog "$label left uncommitted work; stashed as 'overnight $label unfinished'."
    }
    if ((git branch --show-current) -ne 'main') {
      Write-RunLog "The session moved to '$(git branch --show-current)'; switching back to main."
      git switch main
    }
    $now = (git ls-remote origin main 2>$null) -split "\s+" | Select-Object -First 1
    if ($now -and $baseline -and $now -ne $baseline) { Write-RunLog "WARNING: origin/main changed ($now) during the run." }
    Write-RunLog "$label finished. Local main: $(git log --oneline -1)"
  }
} finally {
  if (-not $DryRun) {
    if ($hookInstalled -and (Test-Path $hookFile) -and ((Get-Content $hookFile -Raw) -match $hookMarker)) { Remove-Item $hookFile -Force }
    if ($previousPushUrl) { git config --local remote.origin.pushurl $previousPushUrl }
    else { git config --local --unset remote.origin.pushurl }
    [void][StageForgeRunner.Power]::SetThreadExecutionState([uint32]'0x80000000')
  }
  Write-RunLog "Overnight run ended; push guards removed. Commits are on local main, nothing was pushed. Logs: $logDir"
}
