# 🏢 Claude Office — VisualNacert

Oficina virtual que muestra en tiempo real los agentes de Claude Code activos en tu máquina.

## Instalación

```bash
git clone https://github.com/W17ant/Claude-Office.git
cd Claude-Office
npm install
```

## Uso

```bash
npm start
```

Abre automáticamente `http://localhost:3456` en el navegador.

## ¿Cómo funciona?

- Vigila `~/.claude/projects/` con `chokidar`
- Lee los archivos `.jsonl` de transcripciones de Claude Code en tiempo real
- Actualiza el estado de cada agente (idle / working / waiting / done) via WebSocket
- Cada sesión activa de `claude` aparece como un personaje en la oficina

## Auto-arranque con Claude Code

Añade esto a `~/.claude/settings.json` para que la oficina arranque sola:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "cd /ruta/a/Claude-Office && npm start &"
      }
    ]
  }
}
```

## Stack

- **Servidor**: Node.js + Express + WebSocket (`ws`) + `chokidar`
- **UI**: HTML/Canvas puro, sin build step
- **Chat**: Anthropic API (claude-sonnet-4)
