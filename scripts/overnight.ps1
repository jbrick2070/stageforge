<#
StageForge overnight runner.

Runs Antigravity (agy) once per sprint from HANDOFF.md, each in a fresh session, on a local
branch "overnight/<date>". Commits stay local: pushing is disabled for the length of the run.
It keeps the PC awake while it runs and stops starting sprints at the stop time.

Stop it any time by closing its window. If you do, re-enable pushing with:
  git config --local --unset remote.origin.pushurl
#>
param(
  [int[]]$Sprints = @(0, 1, 2, 3),
  [string]$StopAt = '07:00',
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$logDir = Join-Path $env:TEMP 'stageforge-overnight'
New-Item -ItemType Directory -Force $logDir | Out-Null
$runnerLog = Join-Path $logDir 'runner.log'

function Write-RunLog([string]$message) {
  $line = '{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $message
  Write-Host $line
  Add-Content -Path $runnerLog -Value $line -Encoding utf8
}

function Stop-RepoProcesses {
  # Dev servers and Electron windows the sprint's tests left behind; only ones started from this repo.
  Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='electron.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$repo*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

$stop = [datetime]::Today.Add([timespan]::Parse($StopAt))
if ($stop -le (Get-Date)) { $stop = $stop.AddDays(1) }

if (git status --porcelain) {
  Write-RunLog 'The working tree has uncommitted changes. Commit or stash them, then run this again.'
  exit 1
}
$branch = 'overnight/' + (Get-Date -Format 'yyyy-MM-dd')
Write-RunLog "Overnight run: sprints $($Sprints -join ', ') on branch $branch, no new sprint after $($stop.ToString('yyyy-MM-dd HH:mm'))."
if ($DryRun) {
  Write-RunLog 'Dry run: no branch switch, no push guard, no agy sessions.'
} else {
  git show-ref --verify --quiet "refs/heads/$branch"
  if ($LASTEXITCODE -eq 0) { git switch $branch } else { git switch -c $branch }
}

# Keep the PC awake while this window runs (the display may still sleep); released on exit.
Add-Type -Namespace StageForgeRunner -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
$previousPushUrl = git config --local --get remote.origin.pushurl

try {
  if (-not $DryRun) {
    [void][StageForgeRunner.Power]::SetThreadExecutionState([uint32]'0x80000001')
    git config --local remote.origin.pushurl 'DISABLED-during-overnight-run'
    Write-RunLog 'Pushing is disabled for this run.'
    Write-RunLog 'Updating Claude Code (Opus 5.5 design consults need 2.1.280 or newer)...'
    claude update 2>&1 | ForEach-Object { Write-RunLog "  $_" }
  }

  foreach ($n in $Sprints) {
    if ((Get-Date) -ge $stop) { Write-RunLog "Reached $StopAt; not starting Sprint $n."; break }
    $prompt = "Read HANDOFF.md in this folder, especially 'Overnight run (unattended)'. You are running unattended overnight on branch $branch and the user is asleep, so make reasonable decisions yourself and log them. Run Sprint $n following the loop: implement with tests, pass the gate, run the Sonnet 5.5 QA review through Claude CLI, verify and fix findings, re-run the gate, commit locally, then append your report to the Overnight log in HANDOFF.md and commit that too. Consult Claude Opus 5.5 on design choices as HANDOFF.md describes. Never push and never switch branches. Do not start new work after $StopAt local time."
    $sprintLog = Join-Path $logDir "sprint-$n.log"
    Write-RunLog "Starting Sprint $n (log: $sprintLog)"
    if ($DryRun) { Write-RunLog "  would run: agy -p <prompt> --mode accept-edits --dangerously-skip-permissions"; continue }

    agy -p $prompt --mode accept-edits --dangerously-skip-permissions --print-timeout 0 2>&1 |
      ForEach-Object { "$_" } | Tee-Object -FilePath $sprintLog -Append
    Write-RunLog "Sprint $n session ended (exit code $LASTEXITCODE)."
    Stop-RepoProcesses

    if (git status --porcelain) {
      git stash push --include-untracked -m "overnight sprint $n unfinished" | Out-Null
      Write-RunLog "Sprint $n left uncommitted work; stashed as 'overnight sprint $n unfinished'."
    }
    $current = git branch --show-current
    if ($current -ne $branch) {
      Write-RunLog "The session switched to '$current'; switching back to $branch."
      git switch $branch
    }
  }
} finally {
  if (-not $DryRun) {
    if ($previousPushUrl) { git config --local remote.origin.pushurl $previousPushUrl }
    else { git config --local --unset remote.origin.pushurl }
    [void][StageForgeRunner.Power]::SetThreadExecutionState([uint32]'0x80000000')
  }
  Write-RunLog "Overnight run ended. Commits are on branch $branch; nothing was pushed. Logs: $logDir"
}
