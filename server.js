#!/usr/bin/env node
require("dotenv").config();

const express  = require("express");
const { WebSocketServer } = require("ws");
const http     = require("http");
const path     = require("path");
const fs       = require("fs");
const os       = require("os");
const chokidar = require("chokidar");

const PORT       = process.env.PORT || 3456;
const CLAUDE_DIR = path.join(os.homedir(), ".claude", "projects");
const STALE_MS   = 24 * 60 * 60 * 1000; // sesiones >24h se ocultan
const SYNC_MS    = 60 * 60 * 1000;       // re-sincronizar cada hora

// ── PERSONA DEL USUARIO LOCAL ─────────────────────────────────────────────────
// Se usa como "Persona" al subir proyectos a Confluence
const LOCAL_PERSONA = process.env.OFFICE_NAME || os.userInfo().username;

// ── CONFLUENCE CONFIG ─────────────────────────────────────────────────────────
const CONFLUENCE = {
  cloudId:    "fb372880-3bb3-4382-a807-0d84045bbb5c",
  repoPageId: "4528308226",
  email:      process.env.ATLASSIAN_EMAIL,
  token:      process.env.ATLASSIAN_TOKEN,
};

function confluenceOk() { return !!(CONFLUENCE.email && CONFLUENCE.token); }
function authHeader()    { return "Basic " + Buffer.from(`${CONFLUENCE.email}:${CONFLUENCE.token}`).toString("base64"); }

// ── CONFLUENCE READ ───────────────────────────────────────────────────────────
async function fetchPage(pageId) {
  const url = `https://api.atlassian.com/ex/confluence/${CONFLUENCE.cloudId}/wiki/api/v2/pages/${pageId}?body-format=storage`;
  const res = await fetch(url, { headers: { "Authorization": authHeader(), "Accept": "application/json" } });
  if (!res.ok) throw new Error(`Confluence ${res.status}: ${await res.text()}`);
  return res.json();
}

function parseTable(html) {
  const agents = [];
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  if (rows.length === 0) return agents;

  // Detect column positions from header
  const headerCells = (rows[0].match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || [])
    .map(c => c.replace(/<[^>]+>/g,"").toLowerCase().trim());
  const col = key => headerCells.findIndex(c => c.includes(key));

  // Confluence table: Persona | Agente | Descripción | Página de detalle | Departamento
  const iPersona = col("persona");
  const iNombre  = col("agente");
  const iDesc    = col("descripci");
  const iDetalle = col("detalle") !== -1 ? col("detalle") : col("página");
  const iDept    = col("departamento");

  // Fallback to positional
  const colPersona = iPersona !== -1 ? iPersona : 0;
  const colNombre  = iNombre  !== -1 ? iNombre  : 1;
  const colDesc    = iDesc    !== -1 ? iDesc    : 2;
  const colDetalle = iDetalle !== -1 ? iDetalle : 3;
  const colDept    = iDept    !== -1 ? iDept    : 4;

  let lastPersona = "";
  for (const row of rows.slice(1)) {
    const cells = row.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || [];
    if (cells.length < 3) continue;
    const text = c => (c||"").replace(/<[^>]+>/g,"").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&#\d+;/g," ").replace(/\s+/g," ").trim();
    const get = i => text(cells[i] || "");

    const personaRaw = get(colPersona);
    if (personaRaw) lastPersona = personaRaw;
    const persona = lastPersona;

    const nombre = get(colNombre);
    if (!nombre || nombre.length < 2) continue;

    const linkMatch = (cells[colDetalle]||"").match(/href="([^"]+)"/);

    agents.push({
      persona,
      nombre,
      descripcion: get(colDesc),
      herramientas: "",
      estado: "Activo",
      departamento: colDept < cells.length ? get(colDept) : "",
      url: linkMatch ? linkMatch[1] : null,
    });
  }
  return agents;
}

// ── CONFLUENCE WRITE ──────────────────────────────────────────────────────────
function rowHtml(a) {
  const esc = s => (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  return `<tr><td><p>${esc(a.persona)}</p></td><td><p>${esc(a.nombre)}</p></td><td><p>${esc(a.descripcion)}</p></td><td><p>${esc(a.herramientas)}</p></td><td><p>${esc(a.estado)}</p></td><td><p>${esc(a.departamento||"")}</p></td><td><p></p></td></tr>`;
}

function buildFullTable(agents) {
  return `<table data-table-width="880" data-layout="default"><colgroup><col/><col/><col/><col/><col/><col/><col/></colgroup><tbody>
<tr><th><p><strong>Persona</strong></p></th><th><p><strong>Agente</strong></p></th><th><p><strong>Descripción</strong></p></th><th><p><strong>Herramientas / Integraciones</strong></p></th><th><p><strong>Estado</strong></p></th><th><p><strong>Departamento</strong></p></th><th><p><strong>Página de detalle</strong></p></th></tr>
${agents.map(rowHtml).join("\n")}
</tbody></table>`;
}

async function updatePage(pageId, title, newBody, currentVersion) {
  const url = `https://api.atlassian.com/ex/confluence/${CONFLUENCE.cloudId}/wiki/api/v2/pages/${pageId}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Authorization": authHeader(), "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      id: pageId, status: "current", title,
      version: { number: currentVersion + 1 },
      body: { storage: { value: newBody, representation: "storage" } },
    }),
  });
  if (!res.ok) throw new Error(`Confluence update ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── EXTRACT PROJECTS FROM LOCAL ~/.claude/projects ────────────────────────────
const SKIP_PATTERNS = [
  /^</,/^caveat:/i,/^the messages below/i,/^\s*$/,/^system:/i,
  /^\[/,/stdout|stderr/i,/^failed to/i,/^got new credentials/i,/^reconnect/i,
];

function isRealMessage(text) {
  if (!text || text.length < 5) return false;
  return !SKIP_PATTERNS.some(p => p.test(text.trim()));
}

function extractFirstTask(filePath) {
  try {
    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        const role = e.message?.role || e.role;
        const cv   = e.message?.content || e.content;
        if (role !== "user" || !cv) continue;
        let text = typeof cv === "string" ? cv : cv.find?.(b => b.type==="text"&&b.text)?.text || "";
        text = text.trim().replace(/\s+/g, " ");
        if (isRealMessage(text)) return text.length > 80 ? text.slice(0,78)+"…" : text;
      } catch { /* skip */ }
    }
  } catch { /* unreadable */ }
  return null;
}

function getLocalProjects() {
  const projects = [];
  if (!fs.existsSync(CLAUDE_DIR)) return projects;

  const projectFolders = fs.readdirSync(CLAUDE_DIR, { withFileTypes:true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const folder of projectFolders) {
    const folderPath = path.join(CLAUDE_DIR, folder);
    let jsonlFiles = [];
    try {
      jsonlFiles = fs.readdirSync(folderPath)
        .filter(f => f.endsWith(".jsonl"))
        .map(f => ({ file:f, path:path.join(folderPath, f), mtime: (() => { try { return fs.statSync(path.join(folderPath,f)).mtimeMs; } catch { return 0; } })() }))
        .filter(f => f.mtime > 0)
        .sort((a,b) => b.mtime - a.mtime); // most recent first
    } catch { continue; }

    if (jsonlFiles.length === 0) continue;

    // Use most recent session's first task as the project description
    for (const jf of jsonlFiles) {
      const task = extractFirstTask(jf.path);
      if (task) {
        // Derive a readable project name from the folder
        // e.g. "C--Users-Mario-repos-mi-proyecto" → "mi-proyecto"
        const parts = folder.replace(/^[A-Za-z]--/,"").split("-").filter(Boolean);
        const skip  = new Set(["Users","Desktop","Documents","home","repos","projects","code","dev","src","Downloads"]);
        const meaningful = parts.filter(p => p.length>1 && !skip.has(p) && !/^[A-Z][a-z]+$/.test(p) || parts.indexOf(p) > 2);
        const projectName = meaningful.slice(-2).join("-") || folder.slice(0,20);

        projects.push({
          nombre:      projectName,
          descripcion: task,
          persona:     LOCAL_PERSONA,
          herramientas:"Claude Code",
          estado:      "Activo",
          _key:        projectName.toLowerCase().trim(), // dedup key
        });
        break; // one entry per project folder
      }
    }
  }
  return projects;
}

// ── SYNC LOCAL PROJECTS → CONFLUENCE ─────────────────────────────────────────
async function syncLocalProjectsToConfluence() {
  if (!confluenceOk()) return;
  try {
    const page           = await fetchPage(CONFLUENCE.repoPageId);
    const currentVersion = page.version?.number || 1;
    const currentBody    = page?.body?.storage?.value || "";
    const existing       = parseTable(currentBody);

    // Build dedup set from existing names (lowercase, trimmed)
    const existingKeys = new Set(existing.map(a => a.nombre.toLowerCase().trim()));

    const localProjects = getLocalProjects();
    const toAdd = localProjects.filter(p => !existingKeys.has(p._key));

    if (toAdd.length === 0) {
      console.log(`🔄 Sync: sin proyectos nuevos (${localProjects.length} locales, ${existing.length} en Confluence)`);
      return;
    }

    console.log(`📤 Sync: añadiendo ${toAdd.length} proyecto(s) nuevo(s) a Confluence...`);
    toAdd.forEach(p => console.log(`   + ${p.nombre}: "${p.descripcion.slice(0,50)}…"`));

    const allAgents = [...existing, ...toAdd];
    // Rebuild body preserving any intro text before the table
    const introMatch = currentBody.match(/^([\s\S]*?)(?=<table)/i);
    const intro = introMatch ? introMatch[1] : "<p>Repositorio centralizado de agentes IA del equipo VisualNacert.</p>\n";
    const newBody = intro + buildFullTable(allAgents);

    await updatePage(CONFLUENCE.repoPageId, "Base de Datos – Agentes del Equipo", newBody, currentVersion);
    console.log(`✅ Sync: ${toAdd.length} proyecto(s) añadido(s) a Confluence`);

    // Refresh cache
    await refreshConfluenceAgents();
  } catch (err) {
    console.error("⚠️  Sync error:", err.message);
  }
}

// ── CONFLUENCE CACHE ──────────────────────────────────────────────────────────
let confluenceAgents = [];
let lastConfluenceFetch = 0;
const CONFLUENCE_TTL = 5 * 60 * 1000;

async function refreshConfluenceAgents() {
  if (!confluenceOk()) return;
  try {
    const page = await fetchPage(CONFLUENCE.repoPageId);
    confluenceAgents = parseTable(page?.body?.storage?.value || "");
    lastConfluenceFetch = Date.now();
    console.log(`📋 Confluence: ${confluenceAgents.length} agentes cargados`);
    broadcast({ type:"confluence_agents", agents:confluenceAgents });
  } catch (err) {
    console.error("⚠️  Confluence error:", err.message);
  }
}

// ── SESSION TASK EXTRACTION ───────────────────────────────────────────────────
function extractTask(filePath) {
  try {
    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        const role = e.message?.role || e.role;
        const cv   = e.message?.content || e.content;
        if (role !== "user" || !cv) continue;
        let text = typeof cv === "string" ? cv : cv.find?.(b => b.type==="text"&&b.text)?.text || "";
        text = text.trim().replace(/\s+/g, " ");
        if (isRealMessage(text)) return text.length > 55 ? text.slice(0,53)+"…" : text;
      } catch { /* skip */ }
    }
  } catch { /* unreadable */ }
  return null;
}

// ── SESSION STATE ─────────────────────────────────────────────────────────────
const sessions = new Map();

function makeSession(id, filePath) {
  const task  = extractTask(filePath);
  const mtime = (() => { try { return fs.statSync(filePath).mtimeMs; } catch { return Date.now(); } })();
  return { id, task:task||`sesión ${id.slice(0,8)}`, filePath, status:"idle", lastTool:null, lastActivity:mtime, linesRead:0, startedAt:mtime };
}

function classifyEntry(e) {
  const t = e.type||"";
  if (t==="tool_use")           return "working";
  if (t==="tool_result")        return "working";
  if (t==="permission_request") return "waiting";
  if (t==="session_end")        return "done";
  const role = e.message?.role||e.role;
  if (role==="assistant") return "working";
  if (role==="user")      return "idle";
  return null;
}

function parseJsonl(filePath, session) {
  try {
    const lines = fs.readFileSync(filePath,"utf8").trim().split("\n").filter(Boolean);
    const newLines = lines.slice(session.linesRead);
    session.linesRead = lines.length;
    let changed = false;
    for (const line of newLines) {
      try {
        const e = JSON.parse(line);
        const s = classifyEntry(e);
        if (s && s!==session.status) { session.status=s; session.lastActivity=Date.now(); changed=true; }
        for (const src of [e,...(Array.isArray(e.message?.content)?e.message.content:[]),...(Array.isArray(e.content)?e.content:[])]) {
          if (src?.type==="tool_use"&&src.name) { session.lastTool=src.name; changed=true; }
        }
      } catch { /* skip */ }
    }
    return changed;
  } catch { return false; }
}

function serializeSession(s) {
  return { id:s.id, task:s.task, status:s.status, lastTool:s.lastTool, lastActivity:s.lastActivity, startedAt:s.startedAt };
}

function sortedSessions() {
  const cutoff = Date.now() - STALE_MS;
  return [...sessions.values()]
    .filter(s => s.lastActivity > cutoff)
    .sort((a,b) => b.lastActivity - a.lastActivity)
    .map(serializeSession);
}

// ── WATCHER ───────────────────────────────────────────────────────────────────
let wss;
function broadcast(data) {
  if (!wss) return;
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState===1) c.send(msg); });
}

function handleFile(filePath) {
  if (!filePath.endsWith(".jsonl")) return;
  const id = path.basename(filePath,".jsonl");
  if (!sessions.has(id)) {
    sessions.set(id, makeSession(id, filePath));
    broadcast({ type:"session_update", session:serializeSession(sessions.get(id)) });
  }
  const s = sessions.get(id);
  if (parseJsonl(filePath,s)) broadcast({ type:"session_update", session:serializeSession(s) });
}

function startWatcher() {
  if (!fs.existsSync(CLAUDE_DIR)) fs.mkdirSync(CLAUDE_DIR,{recursive:true});
  console.log(`👀 Watching: ${CLAUDE_DIR}`);
  chokidar.watch(`${CLAUDE_DIR}/**/*.jsonl`, {
    persistent:true, ignoreInitial:false, ignored:/memory/,
    awaitWriteFinish:{ stabilityThreshold:200, pollInterval:100 },
  })
    .on("add",    handleFile)
    .on("change", handleFile)
    .on("unlink", fp => {
      const id = path.basename(fp,".jsonl");
      if (sessions.has(id)) { sessions.delete(id); broadcast({ type:"session_removed", id }); }
    });
  setInterval(() => broadcast({ type:"sessions_init", sessions:sortedSessions() }), 10_000);
  setInterval(() => refreshConfluenceAgents(), CONFLUENCE_TTL);
  setInterval(() => syncLocalProjectsToConfluence(), SYNC_MS);
}

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname,"public")));

app.get("/api/sessions",          (_req,res) => res.json(sortedSessions()));
app.get("/api/confluence-agents", (_req,res) => res.json(confluenceAgents));
app.get("/api/status", (_req,res) => res.json({
  claudeDir:CLAUDE_DIR, sessionCount:sessions.size,
  confluenceAgents:confluenceAgents.length,
  confluenceConfigured:confluenceOk(),
  lastConfluenceFetch:lastConfluenceFetch?new Date(lastConfluenceFetch).toISOString():null,
  officeName: process.env.OFFICE_NAME || os.userInfo().username,
  atlassianEmail: CONFLUENCE.email || "",
}));

// Forzar sync manual desde la UI
// Actualizar un campo de un agente en Confluence (ej: departamento)
app.patch("/api/agent", async (req, res) => {
  const { nombre, campo, valor } = req.body;
  if (!nombre || !campo) return res.status(400).json({ error:"nombre y campo requeridos" });
  if (!confluenceOk()) return res.status(503).json({ error:"Confluence no configurado" });
  try {
    const page           = await fetchPage(CONFLUENCE.repoPageId);
    const currentVersion = page.version?.number || 1;
    const currentBody    = page?.body?.storage?.value || "";
    const agents         = parseTable(currentBody);

    const idx = agents.findIndex(a => a.nombre.toLowerCase().trim() === nombre.toLowerCase().trim());
    if (idx === -1) return res.status(404).json({ error:`Agente "${nombre}" no encontrado` });

    agents[idx][campo] = valor;

    const introMatch = currentBody.match(/^([\s\S]*?)(?=<table)/i);
    const intro = introMatch ? introMatch[1] : "<p>Repositorio centralizado de agentes IA del equipo VisualNacert.</p>\n";
    const newBody = intro + buildFullTable(agents);

    await updatePage(CONFLUENCE.repoPageId, "Base de Datos – Agentes del Equipo", newBody, currentVersion);

    // Update local cache
    confluenceAgents = agents;
    broadcast({ type:"confluence_agents", agents:confluenceAgents });

    res.json({ ok:true, agent:agents[idx] });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

app.post("/api/sync", async (_req,res) => {
  syncLocalProjectsToConfluence().catch(console.error);
  res.json({ ok:true, message:"Sync iniciado" });
});

app.post("/api/chat", async (req,res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error:"Falta ANTHROPIC_API_KEY en el archivo .env" });
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages",{
      method:"POST",
      headers:{ "Content-Type":"application/json","x-api-key":apiKey,"anthropic-version":"2023-06-01" },
      body:JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:700, ...req.body }),
    });
    res.json(await r.json());
  } catch(err) { res.status(500).json({ error:err.message }); }
});

wss.on("connection", ws => {
  ws.send(JSON.stringify({ type:"init", sessions:sortedSessions(), confluenceAgents }));
});

// ── BOOT ──────────────────────────────────────────────────────────────────────
// ── SETUP ENDPOINT ───────────────────────────────────────────────────────────
app.get("/api/setup-status", (_req, res) => {
  res.json({ configured: !!(CONFLUENCE.email || process.env.ANTHROPIC_API_KEY || process.env.OFFICE_NAME) });
});

app.post("/api/setup", async (req, res) => {
  const { name, email, token, anthKey } = req.body;
  if (!name) return res.status(400).json({ error: "El nombre es obligatorio" });
  try {
    const envPath = path.join(__dirname, ".env");
    const lines = [];
    if (anthKey)  lines.push(`ANTHROPIC_API_KEY=${anthKey}`);
    if (email)    lines.push(`ATLASSIAN_EMAIL=${email}`);
    if (token)    lines.push(`ATLASSIAN_TOKEN=${token}`);
    if (name)     lines.push(`OFFICE_NAME=${name}`);
    fs.writeFileSync(envPath, lines.join("\n") + "\n", "utf8");

    // Apply immediately without restart
    if (anthKey)  process.env.ANTHROPIC_API_KEY = anthKey;
    if (email)  { process.env.ATLASSIAN_EMAIL = email;  CONFLUENCE.email = email; }
    if (token)  { process.env.ATLASSIAN_TOKEN = token;  CONFLUENCE.token = token; }
    if (name)     process.env.OFFICE_NAME = name;

    // Trigger sync with new credentials
    if (confluenceOk()) {
      syncLocalProjectsToConfluence().catch(console.error);
      refreshConfluenceAgents().catch(console.error);
    }

    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Redirect to setup if no .env exists
app.get("/", (req, res, next) => {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) {
    return res.redirect("/setup.html");
  }
  next();
});

server.listen(PORT, async () => {
  console.log(`\n🏢 Claude Office → http://localhost:${PORT}`);
  console.log(`👤 Persona local: ${LOCAL_PERSONA}`);

  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) {
    console.log(`\n⚙️  Primera vez detectada — abriendo asistente de configuración...`);
    try { require("open")(`http://localhost:${PORT}/setup.html`); } catch {}
  } else {
    if (!process.env.ANTHROPIC_API_KEY)
      console.log(`⚠️  Chat desactivado. Añade ANTHROPIC_API_KEY al .env`);
    else
      console.log(`✅ Chat: OK`);

    if (!confluenceOk()) {
      console.log(`⚠️  Confluence desactivado. Añade ATLASSIAN_EMAIL y ATLASSIAN_TOKEN al .env`);
    } else {
      console.log(`🔄 Sincronizando proyectos locales con Confluence...`);
      await syncLocalProjectsToConfluence();
      await refreshConfluenceAgents();
    }
    try { require("open")(`http://localhost:${PORT}`); } catch {}
  }

  startWatcher();
});
