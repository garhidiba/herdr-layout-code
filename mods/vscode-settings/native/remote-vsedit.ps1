# The remote bundle's launcher on Windows, remote-vsedit.sh's twin (build-remote.sh ships it as
# <root>\<version>\vsedit.ps1; root is %LOCALAPPDATA%\herdr-vscode). The Explorer opens a remote file with it in a tab
# on that machine:
#   powershell -NoProfile -ExecutionPolicy Bypass -File vsedit.ps1 <file> [--close-on-exit] [--os mac|win|linux]
#     [--settings <json>] [--keybindings <json>]
# The options mean what they mean to remote-vsedit.sh. They are read from the process's command line, not through
# PowerShell's parameter binding (which would take --close-on-exit and the like as its own). Everything it writes is
# under <root>. When the editor can't start, it says why and waits for Enter.
$here = $PSScriptRoot
$root = Split-Path -Parent $here
$env:HERDR_APP_HOME = $root
$env:VSEDIT_SETTINGS = Join-Path $root 'vscode-settings.json'
$env:VSEDIT_KEYBINDINGS = Join-Path $root 'vscode-keybindings.json'
$env:VSEDIT_BACKUPS = Join-Path $root 'backups'
$env:VSEDIT_DESKTOPS = Join-Path $root 'desktops'
# language servers and formatters the user installed
$env:PATH = "$env:PATH;$env:USERPROFILE\.local\bin;$env:USERPROFILE\.cargo\bin"

# written only when it changed (compared without trailing newlines), through a temp file and a rename
function Put([string]$text, [string]$file) {
  $new = $text.TrimEnd("`r", "`n")
  $old = if (Test-Path -LiteralPath $file) { [IO.File]::ReadAllText($file).TrimEnd("`r", "`n") } else { $null }
  if ($old -ne $new) {
    $tmp = "$file.tmp.$PID"
    [IO.File]::WriteAllText($tmp, $new + "`n", (New-Object Text.UTF8Encoding $false))
    Move-Item -LiteralPath $tmp -Destination $file -Force
  }
}

# the arguments after this script's path on powershell.exe's command line
$all = [Environment]::GetCommandLineArgs()
$at = [Array]::FindIndex($all, [Predicate[string]] { param($a) $a -ieq '-File' })
$given = if ($at -ge 0 -and $at + 2 -lt $all.Count) { $all[($at + 2)..($all.Count - 1)] } else { @() }
$rest = @()
for ($i = 0; $i -lt $given.Count; $i++) {
  $a = $given[$i]
  if ($a -in '--os', '--settings', '--keybindings') {
    if ($i + 1 -ge $given.Count) { continue } # a flag without its value is dropped
    $i++
    switch ($a) {
      '--os' { $env:VSEDIT_OS = $given[$i] }
      '--settings' { Put $given[$i] $env:VSEDIT_SETTINGS }
      default { Put $given[$i] $env:VSEDIT_KEYBINDINGS }
    }
  } else { $rest += $a }
}

& (Join-Path $here 'vsedit.exe') --vscode (Join-Path $here 'vscode') @rest
$code = $LASTEXITCODE
if ($code -eq 86) {
  Write-Host "The editor could not start on this machine (run $here\vsedit.exe with VSEDIT_DEBUG=1 to see why)."
  Read-Host 'Press Enter to close' | Out-Null
}
exit $code
