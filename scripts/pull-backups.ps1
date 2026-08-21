# Pull the server's sealed backups down to this machine.
#
# The direction is deliberate. The point of a second copy is to survive what
# happens to the first, and a server that mounts this folder and writes into it
# can also erase it — ransomware, a bad command, a wrong path. Nothing on the
# server holds credentials for this machine, so the copies here are out of its
# reach entirely.
#
# Only sealed archives (*.tar.gz.gpg) are fetched: they carry .env with every
# key the installation has, so they are encrypted on the server before they
# move. The passphrase is NOT here and must not be — keep it in a password
# manager. An archive nobody can decrypt is not a backup.
#
# Run once by hand to check, then schedule it (see docs/OPERATIONS.md).

[CmdletBinding()]
param(
  [string]$Server      = "admilana@172.16.10.6",
  [string]$KeyPath     = "$env:USERPROFILE\.ssh\agentos_codex_deploy",
  [string]$RemotePath  = "backups/agentic-os",
  [string]$Destination = "$env:USERPROFILE\AgenticOS-Backups",
  # Long enough to notice a server that quietly stopped backing up, short
  # enough that a week of holidays does not raise a false alarm.
  [int]$StaleAfterDays = 3
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $KeyPath)) { throw "SSH key not found: $KeyPath" }
if (-not (Test-Path $Destination)) { New-Item -ItemType Directory -Path $Destination | Out-Null }

$sshOptions = @("-i", $KeyPath, "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=15", "-o", "BatchMode=yes")

# What the server has, newest first.
$listing = & ssh @sshOptions $Server "ls -1t $RemotePath/*.tar.gz.gpg 2>/dev/null"
if ($LASTEXITCODE -ne 0) { throw "Could not reach $Server" }

$remoteFiles = @($listing | Where-Object { $_ })
if ($remoteFiles.Count -eq 0) {
  throw "The server has no sealed archives. Is OPS_BACKUP_PASSPHRASE_FILE set in its .env? Without a passphrase the backup stays an unencrypted directory and is never sealed."
}

$fetched = 0
foreach ($remote in $remoteFiles) {
  $name  = Split-Path $remote -Leaf
  $local = Join-Path $Destination $name
  if (Test-Path $local) { continue }

  # Download beside the target and rename, so an interrupted copy is never
  # mistaken for a usable backup.
  $staging = "$local.partial"
  & scp @sshOptions "${Server}:$remote" $staging
  if ($LASTEXITCODE -ne 0) {
    Remove-Item $staging -ErrorAction SilentlyContinue
    throw "Download failed: $name"
  }
  Move-Item $staging $local -Force
  $fetched++
  Write-Output "fetched $name ($([math]::Round((Get-Item $local).Length / 1MB, 1)) MB)"
}

$newest = Get-ChildItem $Destination -Filter "*.tar.gz.gpg" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $newest) { throw "Nothing was downloaded and nothing is stored here." }

$ageDays = [math]::Round(((Get-Date) - $newest.LastWriteTime).TotalDays, 1)
Write-Output "copies here: $((Get-ChildItem $Destination -Filter '*.tar.gz.gpg').Count), newest: $($newest.Name), age: $ageDays d, new this run: $fetched"

# A backup job that silently stops is worse than none, because it is trusted.
if ($ageDays -gt $StaleAfterDays) {
  Write-Warning "The newest backup is $ageDays days old — the server may have stopped making them."
  exit 2
}
