#!/usr/bin/env bash
(set -o igncr) 2>/dev/null && set -o igncr # tolera finales de línea CRLF (git autocrlf en Windows). No quitar.
#
# Music Box Melody Creator: instalador y lanzador para Windows (requiere Git para Windows / Git Bash).
#
#   Instalar:  doble clic en script_windows.sh, o en Git Bash:  bash script_windows.sh
#              Comprueba Node.js (si falta, ofrece instalar Node 24 LTS con winget), instala las
#              dependencias y crea el acceso directo "Music Box Melody Creator" en el escritorio,
#              con el icono public/shortcut-icon.png.
#   Arrancar:  doble clic en el acceso directo (ejecuta: bash script_windows.sh --run).
#              Inicia la app (npm run dev) y abre el navegador. Al cerrar la ventana se detiene.
#
# Si mueves la carpeta del proyecto, vuelve a ejecutar script_windows.sh para rehacer el acceso directo.

set -u -o pipefail

APP_NAME="Music Box Melody Creator"
APP_TITLE="<title>MIDI to Music Box</title>"   # para reconocer la app si ya está abierta
URL="http://localhost:5173/"                   # puerto por defecto de Vite
NODE_MAJOR=24                                  # versión que se ofrece instalar
ICON_PNG="public/shortcut-icon.png"

pause() { echo; read -rp "Pulsa Enter para cerrar..." _ || true; }
die() { echo; echo "ERROR: $*" >&2; pause; exit 1; }

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) ;;
  *) echo "Este script es solo para Windows (ejecútalo con Git Bash). En Linux usa script_linux.sh." >&2; exit 1 ;;
esac

SELF=$(readlink -f "${BASH_SOURCE[0]}")
SELF_NAME=$(basename "$SELF")
cd "$(dirname "$SELF")" || die "No se pudo entrar en la carpeta del proyecto."
export MSYS_NO_PATHCONV=1 # no convertir rutas al llamar a programas de Windows

# Ejecuta código PowerShell (pasado en UTF-16 + base64: sin problemas de comillas, espacios ni acentos).
ps_run() {
  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
    -EncodedCommand "$(printf '%s' "\$ProgressPreference = 'SilentlyContinue'; $1" | iconv -f UTF-8 -t UTF-16LE | base64 -w0)"
}

# ---------------------------------------------------------------- Node.js

node_version() { node --version 2>/dev/null | tr -d '\r' | sed 's/^v//'; }
version_ge() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" = "$2" ]; }

# Lo que exige Vite: ^20.19.0 || >=22.12.0
node_ok() {
  local v=$1
  [ -n "$v" ] || return 1
  version_ge "$v" 22.12.0 && return 0
  [ "${v%%.*}" = 20 ] && version_ge "$v" 20.19.0
}

# Toma el PATH actualizado del registro (tras instalar Node, esta ventana aún no lo ve).
refresh_path() {
  local winpath
  winpath=$(ps_run "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')" | tr -d '\r')
  [ -n "$winpath" ] && PATH="$(cygpath -u -p "$winpath"):$PATH"
}

install_node() {
  command -v winget.exe >/dev/null 2>&1 ||
    die "No se encontró winget. Instala Node.js $NODE_MAJOR LTS desde https://nodejs.org/ y vuelve a ejecutar $SELF_NAME."
  echo "Buscando la última versión de Node.js $NODE_MAJOR..."
  local ver
  ver=$(winget.exe show --id OpenJS.NodeJS.LTS --exact --versions --accept-source-agreements 2>/dev/null |
    tr -d '\r' | grep -E "^${NODE_MAJOR}\.[0-9]+\.[0-9]+$" | sort -V | tail -n1)
  [ -n "$ver" ] || die "winget no ofrece Node.js $NODE_MAJOR. Instálalo desde https://nodejs.org/."
  echo "Instalando Node.js $ver (Windows puede pedir permiso de administrador)..."
  winget.exe install --id OpenJS.NodeJS.LTS --exact --version "$ver" \
    --accept-package-agreements --accept-source-agreements ||
    die "No se pudo instalar Node.js. Instálalo desde https://nodejs.org/ y vuelve a ejecutar $SELF_NAME."
  # Que "winget upgrade --all" no lo suba a otra versión mayor.
  winget.exe pin add --id OpenJS.NodeJS.LTS --version "${NODE_MAJOR}.*" >/dev/null 2>&1 || true
  refresh_path
}

ensure_node() {
  local v
  v=$(node_version)
  node_ok "$v" && return 0
  if [ -z "$v" ]; then
    echo "Node.js no está instalado."
  else
    echo "Node.js $v no sirve para esta app (se necesita 20.19+ o 22.12+; se recomienda $NODE_MAJOR LTS)."
  fi
  local ans
  read -rp "¿Instalar Node.js $NODE_MAJOR LTS con winget? [s/N] " ans || ans=""
  case "$ans" in
    [sSyY]*) install_node ;;
    *) die "Instala Node.js $NODE_MAJOR LTS desde https://nodejs.org/ y vuelve a intentarlo." ;;
  esac
  v=$(node_version)
  node_ok "$v" || die "Node.js se instaló, pero esta ventana no lo encuentra. Ciérrala y vuelve a intentarlo."
  echo "Node.js $v listo."
}

# ---------------------------------------------------------------- dependencias

# npm ci si no hay node_modules, si viene de Linux/Mac (sin los lanzadores .cmd de Windows)
# o si package-lock.json cambió desde la última instalación.
ensure_deps() {
  if [ ! -f node_modules/.package-lock.json ] || [ ! -f node_modules/.bin/vite.cmd ] ||
    [ package-lock.json -nt node_modules/.package-lock.json ]; then
    echo "Instalando dependencias (npm ci), puede tardar un par de minutos..."
    npm ci --no-audit --no-fund || die "Falló la instalación de dependencias (npm ci)."
  fi
}

# ---------------------------------------------------------------- acceso directo

create_shortcut() {
  [ -f "$ICON_PNG" ] || die "No se encontró el icono $ICON_PNG."
  local git_root icon_dir
  git_root=$(cygpath -w /)
  git_root=${git_root%\\}
  export MB_BASH="$git_root\\bin\\bash.exe" # el bash de Git con su PATH completo
  [ -f "$(cygpath -u "$MB_BASH")" ] || die "No se encontró $MB_BASH."
  icon_dir="${LOCALAPPDATA:-$USERPROFILE\\AppData\\Local}\\MusicBoxMelodyCreator"
  export MB_NAME="$APP_NAME"
  export MB_PNG MB_ICO MB_SCRIPT MB_ROOT
  MB_PNG=$(cygpath -w "$PWD/$ICON_PNG")
  MB_ICO="$icon_dir\\icon.ico"
  MB_SCRIPT=$(cygpath -m "$SELF")
  MB_ROOT=$(cygpath -w "$PWD")

  # Los accesos directos de Windows no aceptan PNG: se convierte a .ico (varios tamaños, cada uno
  # como PNG dentro del .ico) y se guarda fuera del proyecto.
  ps_run '
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force -Path (Split-Path $env:MB_ICO) | Out-Null
$src = [System.Drawing.Image]::FromFile($env:MB_PNG)
$sizes = @(256, 128, 64, 48, 32, 24, 16)
$images = @()
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = "HighQualityBicubic"
  $g.SmoothingMode = "HighQuality"
  $g.PixelOffsetMode = "HighQuality"
  $g.CompositingQuality = "HighQuality"
  $scale = [Math]::Min($s / $src.Width, $s / $src.Height)
  $w = [int][Math]::Round($src.Width * $scale); $h = [int][Math]::Round($src.Height * $scale)
  $g.DrawImage($src, [int](($s - $w) / 2), [int](($s - $h) / 2), $w, $h)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $images += , $ms.ToArray()
}
$src.Dispose()
$fs = [System.IO.File]::Create($env:MB_ICO)
$bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i] % 256
  $bw.Write([byte]$s); $bw.Write([byte]$s); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([UInt16]1); $bw.Write([UInt16]32)
  $bw.Write([UInt32]$images[$i].Length); $bw.Write([UInt32]$offset)
  $offset += $images[$i].Length
}
foreach ($img in $images) { $bw.Write($img) }
$bw.Close()

$lnk = Join-Path ([Environment]::GetFolderPath("Desktop")) ($env:MB_NAME + ".lnk")
if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force }
$sc = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$sc.TargetPath = $env:MB_BASH
$sc.Arguments = "`"" + $env:MB_SCRIPT + "`" --run"
$sc.WorkingDirectory = $env:MB_ROOT
$sc.IconLocation = $env:MB_ICO + ",0"
$sc.Description = "Abre " + $env:MB_NAME
$sc.Save()
Write-Output $lnk
' || die "No se pudo crear el acceso directo."
  ie4uinit.exe -show >/dev/null 2>&1 || true # refresca la caché de iconos de Windows
}

# ---------------------------------------------------------------- arrancar la app

app_running() { curl -fsS --max-time 2 "$URL" 2>/dev/null | grep -qF "$APP_TITLE"; }
open_browser() { explorer.exe "$URL" || true; } # explorer.exe siempre devuelve 1

run_app() {
  chcp.com 65001 >/dev/null 2>&1 || true # acentos bien en la consola
  printf '\033]0;%s\007' "$APP_NAME"
  ensure_node
  ensure_deps
  if app_running; then
    echo "La app ya está abierta. Abriendo el navegador..."
    open_browser
    sleep 2
    exit 0
  fi
  echo "Iniciando $APP_NAME. Se abrirá en el navegador."
  echo "Para detener la app, cierra esta ventana."
  echo
  npm run dev -- --open || die "La app se detuvo con un error."
}

# ---------------------------------------------------------------- principal

if [ "${1:-}" = "--run" ]; then
  run_app
else
  echo "== $APP_NAME: instalación =="
  echo
  ensure_node
  echo "Node.js $(node_version)"
  ensure_deps
  echo "Creando el acceso directo..."
  lnk=$(create_shortcut | tr -d '\r') || exit 1
  echo
  echo "Listo. Acceso directo creado en:"
  echo "  $lnk"
  echo "Haz doble clic en él para abrir la app."
  pause
fi
