# CCC_openwhispr launcher, Windows bootstrap. Started by Run_windows.bat.
#
# Makes sure the Node.js major version pinned in .nvmrc is available, then hands
# over to sync-and-run.js, which syncs the fork, installs and starts the app.
# A Node.js on PATH with the right major version is used as-is. Otherwise a
# private copy is downloaded from nodejs.org (SHA-256 verified) into
# %LOCALAPPDATA%\CCC_openwhispr\node\v<major> and used only for this app, so
# nothing else on the PC is touched.
#
# Arguments are passed through to sync-and-run.js, except:
#   -InstallOnly   only make sure Node.js is available and print NODE_DIR=<path>
#                  (sync-and-run.js uses this when a sync changes .nvmrc)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
}

$installOnly = $false
$scriptArgs = @()
foreach ($arg in $args) {
  if ("$arg" -eq "-InstallOnly") {
    $installOnly = $true
  } else {
    $scriptArgs += "$arg"
  }
}

$repoDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$localAppData = $env:LOCALAPPDATA
if (-not $localAppData) {
  $localAppData = [Environment]::GetFolderPath("LocalApplicationData")
}
$toolsRoot = Join-Path $localAppData "CCC_openwhispr"
$defaultNodeMajor = 24

function Write-Step([string]$Message) {
  Write-Host "[fork-sync] $Message"
}

function Get-RequiredNodeMajor {
  $nvmrc = Join-Path $repoDir ".nvmrc"
  if (Test-Path -LiteralPath $nvmrc) {
    $text = (Get-Content -LiteralPath $nvmrc -Raw).Trim()
    if ($text -match '^v?(\d+)') {
      return [int]$Matches[1]
    }
  }
  return $defaultNodeMajor
}

function Get-NodeMajor([string]$NodeExe) {
  # Native commands that write to stderr must not become terminating errors here.
  $ErrorActionPreference = "Continue"
  try {
    $output = & $NodeExe -v 2>$null
    if ($LASTEXITCODE -eq 0 -and "$output" -match '^v(\d+)\.') {
      return [int]$Matches[1]
    }
  } catch {
  }
  return $null
}

function Find-NodeOnPath([int]$Major) {
  $command = Get-Command node -ErrorAction SilentlyContinue
  if (-not $command) {
    return $null
  }
  $exe = $command.Source
  if (-not $exe) {
    $exe = $command.Path
  }
  if ($exe -and (Get-NodeMajor $exe) -eq $Major) {
    return Split-Path -Parent $exe
  }
  return $null
}

function Expand-ZipFile([string]$ZipPath, [string]$Destination) {
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
  if ($tar) {
    $ErrorActionPreference = "Continue"
    & $tar.Source -xf $ZipPath -C $Destination
    $tarExit = $LASTEXITCODE
    $ErrorActionPreference = "Stop"
    if ($tarExit -eq 0) {
      return
    }
    Write-Step "tar.exe could not extract the archive, trying Expand-Archive..."
  }
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $Destination -Force
}

function Install-PrivateNode([int]$Major, [string]$Destination) {
  # x64 on purpose, also on ARM64 Windows: the helper binaries the project downloads
  # are x64, and an arm64 Node.js would make its scripts look for arm64 builds.
  $arch = "x64"
  $baseUrl = "https://nodejs.org/dist/latest-v$Major.x/"
  Write-Step "Node.js $Major is not installed on this PC. Downloading a private copy from nodejs.org..."

  $shasums = (Invoke-WebRequest -UseBasicParsing -Uri ($baseUrl + "SHASUMS256.txt")).Content
  $pattern = "node-v$Major\.\d+\.\d+-win-$arch\.zip\s*$"
  $line = ($shasums -split "`n") | Where-Object { $_ -match $pattern } | Select-Object -First 1
  if (-not $line) {
    throw "nodejs.org lists no Windows $arch build for Node.js $Major."
  }
  $parts = ("$line".Trim() -split '\s+')
  $expectedHash = $parts[0].ToLowerInvariant()
  $zipName = $parts[$parts.Length - 1]

  $tempDir = Join-Path ([IO.Path]::GetTempPath()) ("ccc-node-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
  try {
    $zipPath = Join-Path $tempDir $zipName
    Write-Step "Downloading $zipName..."
    Invoke-WebRequest -UseBasicParsing -Uri ($baseUrl + $zipName) -OutFile $zipPath

    $actualHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
      throw "Checksum mismatch for $zipName (expected $expectedHash, got $actualHash). Not installing it."
    }
    Unblock-File -LiteralPath $zipPath -ErrorAction SilentlyContinue

    $extractDir = Join-Path $tempDir "extract"
    Expand-ZipFile $zipPath $extractDir
    $inner = Get-ChildItem -LiteralPath $extractDir -Directory |
      Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "node.exe") } |
      Select-Object -First 1
    if (-not $inner) {
      throw "node.exe was not found inside $zipName."
    }

    if (Test-Path -LiteralPath $Destination) {
      Remove-Item -LiteralPath $Destination -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
    Move-Item -LiteralPath $inner.FullName -Destination $Destination
    Write-Step "Installed $($inner.Name) into $Destination"
    return $Destination
  } finally {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$major = Get-RequiredNodeMajor
$nodeDir = Find-NodeOnPath $major
$source = "already installed"
if (-not $nodeDir) {
  $privateDir = Join-Path $toolsRoot "node\v$major"
  if (Test-Path -LiteralPath (Join-Path $privateDir "node.exe")) {
    $nodeDir = $privateDir
    $source = "private copy"
  } else {
    $nodeDir = Install-PrivateNode $major $privateDir
    $source = "downloaded"
  }
}

$env:Path = "$nodeDir;" + $env:Path

if ($installOnly) {
  Write-Output "NODE_DIR=$nodeDir"
  exit 0
}

# From here on stderr output from node/npm/electron is ordinary program output.
$ErrorActionPreference = "Continue"
$nodeExe = Join-Path $nodeDir "node.exe"
$nodeVersion = & $nodeExe -v
Write-Step "Using Node.js $nodeVersion ($source) from $nodeDir"
& $nodeExe (Join-Path $PSScriptRoot "sync-and-run.js") @scriptArgs
exit $LASTEXITCODE
