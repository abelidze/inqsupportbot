[CmdletBinding()]
param(
    [string]$BindHost = '127.0.0.1',
    [int]$Port = 8891,
    [string]$Ref = 'master',
    [switch]$RefreshSource,
    [switch]$PrepareOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = Split-Path -Parent $PSCommandPath
$CacheDir = Join-Path $Root '.cache'
$RuntimeDir = Join-Path $Root 'runtime'
$SourceDir = Join-Path $Root 'source'
$VenvDir = Join-Path $Root '.venv'
$SettingsPath = Join-Path $RuntimeDir 'settings.yml'
$LimiterPath = Join-Path $RuntimeDir 'limiter.toml'
$InstallMarker = Join-Path $RuntimeDir 'venv-ready.txt'

function Get-PythonCommand {
    $python = Get-Command python -ErrorAction SilentlyContinue
    if ($python) {
        return [pscustomobject]@{
            Executable = $python.Source
            Prefix = @()
        }
    }

    $launcher = Get-Command py -ErrorAction SilentlyContinue
    if ($launcher) {
        return [pscustomobject]@{
            Executable = $launcher.Source
            Prefix = @('-3')
        }
    }

    throw 'Python 3 is required to run local SearXNG development on Windows.'
}

$Python = Get-PythonCommand

function Invoke-Python {
    param(
        [string[]]$Arguments
    )

    & $Python.Executable @($Python.Prefix + $Arguments)
}

function Invoke-PythonSnippet {
    param(
        [string]$Code,
        [string[]]$Arguments = @()
    )

    New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
    $scriptPath = Join-Path $CacheDir ('snippet-' + [System.Guid]::NewGuid().ToString('N') + '.py')
    try {
        [System.IO.File]::WriteAllText($scriptPath, $Code, [System.Text.UTF8Encoding]::new($false))
        Invoke-Python -Arguments (@($scriptPath) + $Arguments)
    } finally {
        if (Test-Path -LiteralPath $scriptPath) {
            Remove-Item -LiteralPath $scriptPath -Force
        }
    }
}

function Remove-Tree {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    $resolvedRoot = [System.IO.Path]::GetFullPath($Root)
    $resolvedPath = [System.IO.Path]::GetFullPath($Path)
    if (-not $resolvedPath.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove path outside the local searxng workspace: $resolvedPath"
    }

    Remove-Item -LiteralPath $Path -Recurse -Force
}

function Get-DownloadUrl {
    if ($Ref -match '^refs/tags/') {
        return "https://github.com/searxng/searxng/archive/$Ref.zip"
    }

    if ($Ref -match '^refs/heads/') {
        return "https://github.com/searxng/searxng/archive/$Ref.zip"
    }

    if ($Ref -match '^[0-9v]') {
        return "https://github.com/searxng/searxng/archive/refs/tags/$Ref.zip"
    }

    return "https://github.com/searxng/searxng/archive/refs/heads/$Ref.zip"
}

function Ensure-Source {
    New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null

    if ((Test-Path -LiteralPath $SourceDir) -and -not $RefreshSource) {
        Patch-Source
        return
    }

    $zipName = ('searxng-' + ($Ref -replace '[^a-zA-Z0-9._-]', '-') + '.zip')
    $zipPath = Join-Path $CacheDir $zipName
    $downloadUrl = Get-DownloadUrl

    Remove-Tree $SourceDir
    Write-Host "Downloading SearXNG source from $downloadUrl"
    Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath

    $extractCode = @'
import pathlib
import shutil
import sys
import zipfile

zip_path = pathlib.Path(sys.argv[1])
dest = pathlib.Path(sys.argv[2])
invalid_chars = set('<>:"\\|?*')

if dest.exists():
    shutil.rmtree(dest)
dest.mkdir(parents=True, exist_ok=True)

skipped = []
with zipfile.ZipFile(zip_path) as archive:
    for member in archive.infolist():
        if member.is_dir():
            continue

        parts = pathlib.PurePosixPath(member.filename).parts
        if len(parts) <= 1:
            continue

        rel_parts = parts[1:]
        if any(any(ch in invalid_chars for ch in part) or part.endswith(' ') or part.endswith('.') for part in rel_parts):
            skipped.append(member.filename)
            continue

        target = dest.joinpath(*rel_parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        with archive.open(member) as src, open(target, 'wb') as dst:
            shutil.copyfileobj(src, dst)

print(f'Extracted SearXNG to {dest}')
if skipped:
    print(f'Skipped {len(skipped)} Windows-incompatible template paths:')
    for name in skipped:
        print(f'  - {name}')
'@

    Invoke-PythonSnippet -Code $extractCode -Arguments @($zipPath, $SourceDir)
    Patch-Source
}

function Patch-Source {
    $valkeyPath = Join-Path $SourceDir 'searx\valkeydb.py'
    if (-not (Test-Path -LiteralPath $valkeyPath)) {
        throw "SearXNG source is missing expected file: $valkeyPath"
    }
    $trustedProxiesPath = Join-Path $SourceDir 'searx\botdetection\trusted_proxies.py'
    if (-not (Test-Path -LiteralPath $trustedProxiesPath)) {
        throw "SearXNG source is missing expected file: $trustedProxiesPath"
    }

    $patchCode = @'
from pathlib import Path
import sys

valkey_path = Path(sys.argv[1])
trusted_proxies_path = Path(sys.argv[2])
valkey_text = valkey_path.read_text(encoding='utf-8')
trusted_proxies_text = trusted_proxies_path.read_text(encoding='utf-8')

original_import = 'import os\nimport pwd\nimport logging\nimport warnings\n'
patched_import = 'import os\nimport logging\nimport warnings\n\ntry:\n    import pwd\nexcept ImportError:\n    pwd = None\n'

original_error = """    except valkey.exceptions.ValkeyError:\n        _CLIENT = None\n        _pw = pwd.getpwuid(os.getuid())\n        logger.exception(\"[%s (%s)] can't connect valkey DB ...\", _pw.pw_name, _pw.pw_uid)\n    return False\n"""
patched_error = """    except valkey.exceptions.ValkeyError:\n        _CLIENT = None\n        if pwd is not None and hasattr(os, 'getuid'):\n            _pw = pwd.getpwuid(os.getuid())\n            logger.exception(\"[%s (%s)] can't connect valkey DB ...\", _pw.pw_name, _pw.pw_uid)\n        else:\n            logger.exception(\"can't connect valkey DB ...\")\n    return False\n"""

proxy_warning_marker = 'if not x_forwarded_for and not x_real_ip:'
patched_proxy_warning = """        is_local_direct_request = orig_remote_addr in (\"127.0.0.1\", \"::1\")\n        if not x_forwarded_for and not x_real_ip and not is_local_direct_request:"""

if original_import in valkey_text:
    valkey_text = valkey_text.replace(original_import, patched_import)

if original_error in valkey_text:
    valkey_text = valkey_text.replace(original_error, patched_error)

if 'is_local_direct_request = orig_remote_addr in ("127.0.0.1", "::1")' not in trusted_proxies_text:
    trusted_proxies_text = trusted_proxies_text.replace(proxy_warning_marker, patched_proxy_warning, 1)

valkey_path.write_text(valkey_text, encoding='utf-8')
trusted_proxies_path.write_text(trusted_proxies_text, encoding='utf-8')
'@

    Invoke-PythonSnippet -Code $patchCode -Arguments @($valkeyPath, $trustedProxiesPath)
}

function Ensure-Venv {
    $venvPython = Join-Path $VenvDir 'Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $venvPython)) {
        Write-Host 'Creating local Python virtualenv'
        Invoke-Python -Arguments @('-m', 'venv', $VenvDir)
    }

    $markerValues = @{}
    if (Test-Path -LiteralPath $InstallMarker) {
        Get-Content -LiteralPath $InstallMarker | ForEach-Object {
            if ($_ -match '^([^=]+)=(.*)$') {
                $markerValues[$matches[1]] = $matches[2]
            }
        }
    }

    $needsInstall = $RefreshSource `
        -or -not (Test-Path -LiteralPath $InstallMarker) `
        -or ($markerValues['source'] -ne $SourceDir)

    if ($needsInstall) {
        New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
        & $venvPython -m pip install -U pip setuptools wheel
        & $venvPython -m pip install -U pyyaml msgspec typing-extensions pybind11
        & $venvPython -m pip install --use-pep517 --no-build-isolation -e $SourceDir
        "prepared=$([DateTime]::UtcNow.ToString('o'))`nref=$Ref`nsource=$SourceDir" | Set-Content -LiteralPath $InstallMarker
    }

    return $venvPython
}

function Write-Settings {
    New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null

    $settings = @"
use_default_settings: true

general:
  debug: false
  instance_name: "inq.name local SearXNG"

search:
  safe_search: 0
  autocomplete: ""
  formats:
    - html
    - json

server:
  secret_key: "inq-name-local-dev-secret"
  limiter: false
  image_proxy: false
  bind_address: "$BindHost"
  port: $Port
  base_url: "http://$BindHost`:$Port/"

engines:
  - name: ahmia
    inactive: true

  - name: torch
    inactive: true

  - name: wikidata
    inactive: true

  - name: karmasearch
    inactive: true

  - name: karmasearch videos
    inactive: true

  - name: startpage
    inactive: true

  - name: startpage news
    inactive: true

  - name: startpage images
    inactive: true
"@

    $settings | Set-Content -LiteralPath $SettingsPath
    "# Limiter is disabled for local Windows development." | Set-Content -LiteralPath $LimiterPath
}

Ensure-Source
$venvPython = Ensure-Venv
Write-Settings

if ($PrepareOnly) {
    Write-Host "Prepared local SearXNG at $SourceDir"
    Write-Host "Settings file: $SettingsPath"
    exit 0
}

$env:SEARXNG_SETTINGS_PATH = $SettingsPath
$env:SEARXNG_DEBUG = '0'

Write-Host "Starting local SearXNG on http://$BindHost`:$Port"
Write-Host "Chatbot URL: http://$BindHost`:$Port"
Push-Location $SourceDir
try {
    & $venvPython -m searx.webapp
} finally {
    Pop-Location
}
