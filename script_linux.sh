#!/usr/bin/env bash
(set -o igncr) 2>/dev/null && set -o igncr # tolera finales de línea CRLF si el repo pasó por Windows. No quitar.
#
# Music Box Melody Creator: instalador y lanzador para Linux.
# (Para Windows está script_windows.sh.)
#
#   Instalar:  en una terminal:  bash script_linux.sh
#              Comprueba Node.js (si falta, ofrece instalar Node 24 LTS en tu carpeta de usuario, sin
#              sudo), instala las dependencias y crea el acceso directo "Music Box Melody Creator" en el
#              escritorio, con el icono public/shortcut-icon.png.
#   Arrancar:  doble clic en el acceso directo (ejecuta en una terminal: bash script_linux.sh --run).
#              Inicia la app (npm run dev) y abre el navegador. Al cerrar la terminal se detiene.
#
# Si mueves la carpeta del proyecto, vuelve a ejecutar script_linux.sh para rehacer el acceso directo.

set -u -o pipefail

APP_NAME="Music Box Melody Creator"
APP_ID="music-box-melody-creator"
APP_TITLE="<title>MIDI to Music Box</title>"   # para reconocer la app si ya está abierta
URL="http://localhost:5173/"                   # puerto por defecto de Vite
NODE_MAJOR=24                                  # versión que se ofrece instalar
ICON_PNG="public/shortcut-icon.png"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/$APP_ID" # icono y Node propio (si se instala)

pause() {
  if [ -t 0 ]; then
    echo
    read -rp "Pulsa Enter para cerrar..." _ || true
  fi
}
die() { echo; echo "ERROR: $*" >&2; pause; exit 1; }

[ "$(uname -s)" = Linux ] ||
  { echo "Este script es para Linux. En Windows usa script_windows.sh." >&2; exit 1; }

SELF=$(readlink -f "${BASH_SOURCE[0]}")
SELF_NAME=$(basename "$SELF")
cd "$(dirname "$SELF")" || die "No se pudo entrar en la carpeta del proyecto."

download() { # download URL DESTINO   (DESTINO "-" = salida estándar)
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    die "Hace falta curl o wget."
  fi
}

# ---------------------------------------------------------------- Node.js

# Un acceso directo no carga ~/.bashrc, así que Node instalado con nvm, fnm o volta no estaría en el
# PATH. Se buscan aquí. El Node propio de este script (si se instaló) tiene prioridad.
load_node_path() {
  local d
  for d in "$HOME/.volta/bin" "$HOME/.local/share/fnm/aliases/default/bin" "$HOME/.fnm/aliases/default/bin"; do
    [ -d "$d" ] && PATH="$d:$PATH"
  done
  if ! command -v node >/dev/null 2>&1 && [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null 2>&1 || true
  fi
  [ -x "$DATA_DIR/node/bin/node" ] && PATH="$DATA_DIR/node/bin:$PATH"
  export PATH
}

node_version() { node --version 2>/dev/null | sed 's/^v//'; }
version_ge() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" = "$2" ]; }

# Lo que exige Vite: ^20.19.0 || >=22.12.0
node_ok() {
  local v=$1
  [ -n "$v" ] || return 1
  version_ge "$v" 22.12.0 && return 0
  [ "${v%%.*}" = 20 ] && version_ge "$v" 20.19.0
}

# Descarga el Node oficial de nodejs.org, comprueba su SHA-256 y lo deja en $DATA_DIR/node.
# No necesita sudo ni toca el Node del sistema: solo lo usa esta app.
install_node() {
  local arch
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    armv7l) arch=armv7l ;;
    ppc64le) arch=ppc64le ;;
    s390x) arch=s390x ;;
    *) die "No hay Node.js oficial para esta arquitectura ($(uname -m)). Instálalo con tu gestor de paquetes." ;;
  esac
  local base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  echo "Buscando la última versión de Node.js $NODE_MAJOR..."
  local sums file expected tmp
  sums=$(download "$base/SHASUMS256.txt" -) || die "No se pudo conectar con nodejs.org."
  file=$(printf '%s\n' "$sums" | grep -oE "node-v${NODE_MAJOR}\.[0-9]+\.[0-9]+-linux-${arch}\.tar\.gz$" | head -n1)
  [ -n "$file" ] || die "nodejs.org no ofrece Node.js $NODE_MAJOR para linux-$arch."
  expected=$(printf '%s\n' "$sums" | grep -F "  $file" | cut -d' ' -f1)
  tmp=$(mktemp -d) || die "No se pudo crear una carpeta temporal."
  echo "Descargando $file..."
  download "$base/$file" "$tmp/$file" || { rm -rf "$tmp"; die "Falló la descarga de Node.js."; }
  if [ "$(sha256sum "$tmp/$file" | cut -d' ' -f1)" != "$expected" ]; then
    rm -rf "$tmp"
    die "La descarga de Node.js está dañada (el SHA-256 no coincide)."
  fi
  mkdir -p "$DATA_DIR" && tar -xzf "$tmp/$file" -C "$tmp" ||
    { rm -rf "$tmp"; die "No se pudo descomprimir Node.js."; }
  rm -rf "$DATA_DIR/node"
  mv "$tmp/${file%.tar.gz}" "$DATA_DIR/node" || { rm -rf "$tmp"; die "No se pudo instalar Node.js en $DATA_DIR."; }
  rm -rf "$tmp"
  PATH="$DATA_DIR/node/bin:$PATH"
  export PATH
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
  read -rp "¿Instalar Node.js $NODE_MAJOR LTS para esta app (en $DATA_DIR, sin sudo)? [s/N] " ans || ans=""
  case "$ans" in
    [sSyY]*) install_node ;;
    *) die "Instala Node.js $NODE_MAJOR LTS (https://nodejs.org/ o tu gestor de paquetes) y vuelve a intentarlo." ;;
  esac
  v=$(node_version)
  node_ok "$v" || die "Node.js se instaló, pero no funciona en este sistema. Instálalo con tu gestor de paquetes."
  echo "Node.js $v listo."
}

# ---------------------------------------------------------------- dependencias

# npm ci si no hay node_modules, si viene de Windows (tiene los lanzadores .cmd de Windows y los
# binarios nativos equivocados) o si package-lock.json cambió desde la última instalación.
ensure_deps() {
  if [ ! -f node_modules/.package-lock.json ] || [ ! -f node_modules/.bin/vite ] ||
    [ -f node_modules/.bin/vite.cmd ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
    echo "Instalando dependencias (npm ci), puede tardar un par de minutos..."
    npm ci --no-audit --no-fund || die "Falló la instalación de dependencias (npm ci)."
  fi
}

# ---------------------------------------------------------------- acceso directo

# Escapa un argumento para la línea Exec= de un .desktop (especificación freedesktop).
desktop_quote() {
  local s=$1
  s=${s//\\/\\\\\\\\}
  s=${s//\"/\\\\\"}
  s=${s//\`/\\\\\`}
  s=${s//\$/\\\\\$}
  s=${s//%/%%}
  printf '"%s"' "$s"
}

desktop_dir() {
  local d=""
  command -v xdg-user-dir >/dev/null 2>&1 && d=$(xdg-user-dir DESKTOP 2>/dev/null)
  # xdg-user-dir devuelve $HOME si no hay escritorio configurado
  if [ -z "$d" ] || [ "$d" = "$HOME" ]; then d="$HOME/Desktop"; fi
  printf '%s' "$d"
}

create_shortcut() {
  [ -f "$ICON_PNG" ] || die "No se encontró el icono $ICON_PNG."
  local desk lnk icon
  desk=$(desktop_dir)
  mkdir -p "$desk" "$DATA_DIR" || die "No se pudo crear $desk."
  icon="$DATA_DIR/icon.png"
  cp -f "$ICON_PNG" "$icon" || die "No se pudo copiar el icono."
  lnk="$desk/$APP_ID.desktop"
  cat >"$lnk" <<EOF || die "No se pudo crear $lnk."
[Desktop Entry]
Type=Application
Version=1.0
Name=$APP_NAME
Comment=Abre $APP_NAME
Exec=bash $(desktop_quote "$SELF") --run
Path=$PWD
Icon=$icon
Terminal=true
Categories=AudioVideo;Audio;
EOF
  chmod +x "$lnk"
  # GNOME (y Ubuntu) solo deja abrir lanzadores del escritorio marcados como "de confianza".
  command -v gio >/dev/null 2>&1 && gio set "$lnk" metadata::trusted true >/dev/null 2>&1
  printf '%s\n' "$lnk"
}

# ---------------------------------------------------------------- arrancar la app

app_running() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 2 "$URL" 2>/dev/null | grep -qF "$APP_TITLE"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- --timeout=2 "$URL" 2>/dev/null | grep -qF "$APP_TITLE"
  else
    return 1
  fi
}
open_browser() { xdg-open "$URL" >/dev/null 2>&1 || echo "Abre $URL en tu navegador."; }

run_app() {
  printf '\033]0;%s\007' "$APP_NAME"
  load_node_path
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
  load_node_path
  ensure_node
  echo "Node.js $(node_version)"
  ensure_deps
  echo "Creando el acceso directo..."
  lnk=$(create_shortcut) || exit 1
  echo
  echo "Listo. Acceso directo creado en:"
  echo "  $lnk"
  echo "Haz doble clic en él para abrir la app."
  echo "(Si tu escritorio pregunta, elige \"Permitir ejecutar\" o \"Confiar y abrir\".)"
  pause
fi
