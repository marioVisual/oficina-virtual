#!/bin/bash
# ============================================================
#  Claude Office — VisualNacert
#  Instalador para Mac/Linux
#  Uso: bash install.sh
# ============================================================

set -e

INSTALL_DIR="$HOME/.claude-office"
PLIST_FILE="$HOME/Library/LaunchAgents/com.visualnacert.claude-office.plist"
REPO_URL="https://raw.githubusercontent.com/marioVisual/oficina-virtual/main"
GREEN='\033[0;32m'
AMBER='\033[0;33m'
RED='\033[0;31m'
DIM='\033[0;90m'
NC='\033[0m'
BOLD='\033[1m'

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║   VISUALNACERT · CLAUDE OFFICE       ║"
echo "  ║   Instalador v1.0                    ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# ── CHECK NODE.JS ─────────────────────────────────────────
if ! command -v node &> /dev/null; then
    echo -e "  ${RED}✗ Node.js no está instalado.${NC}"
    echo ""
    echo "  Instálalo con Homebrew:"
    echo -e "  ${AMBER}  brew install node${NC}"
    echo ""
    echo "  O descárgalo en: https://nodejs.org"
    echo ""

    if command -v brew &> /dev/null; then
        read -p "  ¿Instalar Node.js ahora con Homebrew? [S/n] " yn
        yn=${yn:-S}
        if [[ "$yn" =~ ^[Ss]$ ]]; then
            brew install node
        else
            echo "  Instala Node.js y vuelve a ejecutar este script."
            exit 1
        fi
    else
        open "https://nodejs.org" 2>/dev/null || true
        echo "  Instala Node.js y vuelve a ejecutar este script."
        exit 1
    fi
fi

echo -e "  ${GREEN}✓ Node.js $(node --version)${NC}"

# ── CHECK NPM ─────────────────────────────────────────────
if ! command -v npm &> /dev/null; then
    echo -e "  ${RED}✗ npm no encontrado.${NC}"
    exit 1
fi

echo -e "  ${GREEN}✓ npm $(npm --version)${NC}"
echo ""

# ── DOWNLOAD FILES ────────────────────────────────────────
echo -e "  ${BOLD}Descargando Claude Office...${NC}"

mkdir -p "$INSTALL_DIR/public"

FILES=(
    "server.js"
    "package.json"
    "public/index.html"
    "public/setup.html"
)

for file in "${FILES[@]}"; do
    echo -e "  ${DIM}↓ $file${NC}"
    curl -fsSL "$REPO_URL/$file" -o "$INSTALL_DIR/$file" || {
        echo -e "  ${RED}✗ Error descargando $file${NC}"
        echo "  Comprueba tu conexión o que el repositorio sea accesible."
        exit 1
    }
done

echo -e "  ${GREEN}✓ Archivos descargados${NC}"
echo ""

# ── INSTALL DEPENDENCIES ──────────────────────────────────
echo -e "  ${BOLD}Instalando dependencias...${NC}"
cd "$INSTALL_DIR"
npm install --silent
echo -e "  ${GREEN}✓ Dependencias instaladas${NC}"
echo ""

# ── CONFIGURACIÓN ─────────────────────────────────────────
echo -e "  ${BOLD}Configuración${NC}"
echo -e "  ${DIM}(pulsa Enter para saltar un campo opcional)${NC}"
echo ""

ENV_FILE="$INSTALL_DIR/.env"

# Si ya existe .env, preguntar si sobreescribir
if [ -f "$ENV_FILE" ]; then
    read -p "  Ya existe configuración. ¿Actualizar? [s/N] " update
    update=${update:-N}
    if [[ ! "$update" =~ ^[Ss]$ ]]; then
        echo -e "  ${DIM}Manteniendo configuración existente.${NC}"
        SKIP_CONFIG=true
    fi
fi

if [ -z "$SKIP_CONFIG" ]; then
    echo -n "  Tu nombre en la oficina: "
    read OFFICE_NAME
    while [ -z "$OFFICE_NAME" ]; do
        echo -e "  ${AMBER}El nombre es obligatorio.${NC}"
        echo -n "  Tu nombre en la oficina: "
        read OFFICE_NAME
    done

    echo ""
    echo -e "  ${DIM}── Confluencia (opcional, para sincronizar con el equipo) ──${NC}"
    echo -n "  Email de Atlassian: "
    read ATLASSIAN_EMAIL

    if [ -n "$ATLASSIAN_EMAIL" ]; then
        echo -n "  Token de Atlassian: "
        read -s ATLASSIAN_TOKEN
        echo ""
        echo -e "  ${DIM}Token en: https://id.atlassian.com → Security → API tokens${NC}"
    fi

    echo ""
    echo -e "  ${DIM}── Chat IA (opcional) ──${NC}"
    echo -n "  API Key de Anthropic (sk-ant-...): "
    read -s ANTHROPIC_API_KEY
    echo ""

    # Write .env
    {
        echo "OFFICE_NAME=$OFFICE_NAME"
        [ -n "$ATLASSIAN_EMAIL" ] && echo "ATLASSIAN_EMAIL=$ATLASSIAN_EMAIL"
        [ -n "$ATLASSIAN_TOKEN" ] && echo "ATLASSIAN_TOKEN=$ATLASSIAN_TOKEN"
        [ -n "$ANTHROPIC_API_KEY" ] && echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"
    } > "$ENV_FILE"

    echo -e "  ${GREEN}✓ Configuración guardada${NC}"
fi

echo ""

# ── LAUNCH AGENT (autostart) ──────────────────────────────
IS_MAC=false
if [[ "$OSTYPE" == "darwin"* ]]; then
    IS_MAC=true
fi

if $IS_MAC; then
    echo -e "  ${BOLD}Configurando arranque automático...${NC}"

    mkdir -p "$HOME/Library/LaunchAgents"

    cat > "$PLIST_FILE" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.visualnacert.claude-office</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(which node)</string>
        <string>$INSTALL_DIR/server.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$INSTALL_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>$HOME/.claude-office/office.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/.claude-office/office.log</string>
</dict>
</plist>
PLIST

    # Load launch agent
    launchctl unload "$PLIST_FILE" 2>/dev/null || true
    launchctl load "$PLIST_FILE"

    echo -e "  ${GREEN}✓ Claude Office arrancará automáticamente al iniciar sesión${NC}"
fi

# ── CREATE ALIAS ──────────────────────────────────────────
ALIAS_LINE="alias claude-office='node $INSTALL_DIR/server.js'"
for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
    if [ -f "$rc" ] && ! grep -q "claude-office" "$rc"; then
        echo "" >> "$rc"
        echo "# Claude Office VisualNacert" >> "$rc"
        echo "$ALIAS_LINE" >> "$rc"
    fi
done

# ── START NOW ─────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}Arrancando Claude Office...${NC}"

# Kill any existing instance
pkill -f "node.*claude-office/server.js" 2>/dev/null || true
sleep 1

# Start in background
cd "$INSTALL_DIR"
nohup node server.js > office.log 2>&1 &
OFFICE_PID=$!

sleep 2

# Check it started
if kill -0 $OFFICE_PID 2>/dev/null; then
    echo -e "  ${GREEN}✓ Claude Office corriendo (PID $OFFICE_PID)${NC}"
    echo ""
    echo "  ╔══════════════════════════════════════╗"
    echo -e "  ║  ${GREEN}✓ Instalación completada${NC}             ║"
    echo "  ║                                      ║"
    echo "  ║  Abriendo en el navegador...         ║"
    echo "  ║  http://localhost:3456               ║"
    echo "  ║                                      ║"
    if $IS_MAC; then
    echo "  ║  Se iniciará automáticamente         ║"
    echo "  ║  al encender el Mac.                 ║"
    fi
    echo "  ╚══════════════════════════════════════╝"
    echo ""
    sleep 1
    open "http://localhost:3456" 2>/dev/null || xdg-open "http://localhost:3456" 2>/dev/null || true
else
    echo -e "  ${RED}✗ Error al arrancar. Revisa el log:${NC}"
    echo "  cat $INSTALL_DIR/office.log"
    exit 1
fi
