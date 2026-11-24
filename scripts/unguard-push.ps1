<#
Removes the push guards that scripts/overnight.ps1 installs, if a run was stopped before it could
clean up (for example by closing its window). Safe to run any time.
#>
$repo = Split-Path -Parent $PSScriptRoot
$hook = Join-Path $repo '.git\hooks\pre-push'
if ((Test-Path $hook) -and ((Get-Content $hook -Raw) -match 'StageForge overnight run')) {
  Remove-Item $hook -Force
  'Removed the pre-push hook.'
}
if ((git -C $repo config --local --get remote.origin.pushurl) -like 'DISABLED*') {
  git -C $repo config --local --unset remote.origin.pushurl
  'Removed the disabled pushurl.'
}
'Push guards are off. Pushing works again.'
