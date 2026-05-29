#!/bin/bash
echo "  Desinstalando Claude Office..."
launchctl unload "$HOME/Library/LaunchAgents/com.visualnacert.claude-office.plist" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.visualnacert.claude-office.plist"
pkill -f "node.*claude-office/server.js" 2>/dev/null || true
read -p "  ¿Eliminar también los archivos de la app? [s/N] " yn
yn=${yn:-N}
if [[ "$yn" =~ ^[Ss]$ ]]; then
    rm -rf "$HOME/.claude-office"
    echo "  Archivos eliminados."
fi
echo "  Claude Office desinstalado."
