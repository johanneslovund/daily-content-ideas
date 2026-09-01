const express = require("express");
const cors = require("cors");
const path = require("path");
const cron = require("node-cron");
const Database = require("better-sqlite3");
const Anthropic = require("@anthropic-ai/sdk");

const PORT = process.env.PORT || 3060;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "ideas.db");
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
const IDEAS_PER_BATCH = parseInt(process.env.IDEAS_PER_BATCH || "8", 10);
// Cron format: min hour day month weekday. Default: every day at 07:00 server time.
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "0 7 * * *";

// ---- Context: tilpass denne til merkevaren(e) dere lager innhold for ----
const BRAND_CONTEXT = process.env.BRAND_CONTEXT || `
Vi lager innhold for en tropical house / DJ-artist og festival-merkevaren "Palm Tree Music Festival".
Målgruppe: unge, festival- og musikkinteresserte følgere på Instagram Reels, TikTok og YouTube Shorts.
Stil: solfylt, tropisk, "disco palm tree"-visuell identitet, backstage/studio-glimt, festival-øyeblikk,
samarbeid med andre artister, remix-drops, behind-the-scenes fra produksjon og turné.
Idéene skal være konkrete nok til å filmes/produseres i løpet av noen dager, ikke generiske "post mer"-tips.
`.trim();

const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS ideas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    platform TEXT,
    hook TEXT,
    format TEXT,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS captions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idea_id INTEGER,
    topic TEXT,
    label TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(idea_id) REFERENCES ideas(id) ON DELETE CASCADE
  );
`);

const insertIdea = db.prepare(`
  INSERT INTO ideas (title, description, platform, hook, format)
  VALUES (@title, @description, @platform, @hook, @format)
`);

const insertCaption = db.prepare(`
  INSERT INTO captions (idea_id, topic, label, text)
  VALUES (@idea_id, @topic, @label, @text)
`);

async function generateIdeas(count = IDEAS_PER_BATCH) {
  if (!anthropic) {
    throw new Error("ANTHROPIC_API_KEY er ikke satt. Legg den til i .env og restart containeren.");
  }

  const prompt = `${BRAND_CONTEXT}

Generer ${count} nye, konkrete content-idéer for kortformat-video (Reels/TikTok/Shorts) for denne merkevaren.
Unngå å gjenta idéer som ligner på generiske "vis studio-livet ditt"-forslag - vær spesifikk.

Svar KUN med gyldig JSON, en liste av objekter med nøyaktig disse feltene:
[
  {
    "title": "Kort tittel (maks 8 ord)",
    "description": "1-3 setninger som forklarer konkret hva som skal filmes/lages",
    "platform": "Instagram Reels | TikTok | YouTube Shorts | Alle",
    "hook": "Forslag til de første 1-3 sekundene / hook-tekst",
    "format": "f.eks. POV, Behind-the-scenes, Skit, Tutorial, Countdown, Duet/Collab, Storytime"
  }
]

Ikke inkluder noe annet enn selve JSON-arrayen - ingen markdown-fences, ingen forklaringstekst.`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("Ingen tekst i svaret fra Claude.");

  let cleaned = textBlock.text.trim().replace(/^```json\s*|^```\s*|```$/g, "");
  let ideas;
  try {
    ideas = JSON.parse(cleaned);
  } catch (e) {
    throw new Error("Kunne ikke parse JSON fra Claude: " + e.message);
  }

  const insertMany = db.transaction((items) => {
    for (const item of items) {
      insertIdea.run({
        title: item.title || "Uten tittel",
        description: item.description || "",
        platform: item.platform || "",
        hook: item.hook || "",
        format: item.format || "",
      });
    }
  });
  insertMany(ideas);
  return ideas.length;
}

async function generateCaptions({ ideaId, topic, count = 4 }) {
  if (!anthropic) {
    throw new Error("ANTHROPIC_API_KEY er ikke satt. Legg den til i .env og restart containeren.");
  }

  let subjectContext;
  let idea = null;
  if (ideaId) {
    idea = db.prepare(`SELECT * FROM ideas WHERE id = ?`).get(ideaId);
    if (!idea) throw new Error("Fant ikke content-idéen.");
    subjectContext = `Innlegget dette er en caption til:
Tittel: ${idea.title}
Beskrivelse: ${idea.description}
Hook: ${idea.hook || "(ingen)"}
Format: ${idea.format || "(ukjent)"}
Plattform: ${idea.platform || "(ukjent)"}`;
  } else if (topic && topic.trim()) {
    subjectContext = `Innlegget dette er en caption til: ${topic.trim()}`;
  } else {
    throw new Error("Må ha enten en idé eller et fritekst-tema å skrive caption for.");
  }

  const prompt = `${BRAND_CONTEXT}

${subjectContext}

Skriv ${count} forskjellige forslag til caption/billedtekst for dette innlegget.
Kravene til captionene:
- De skal føles PERSONLIGE - skrevet i jeg-form, som om artisten selv skriver det,
  ikke som en markedsavdeling. Unngå generiske fraser som "Sjekk ut dette!" eller "Ny musikk ute nå!".
- De skal være skrevet for å skape ENGASJEMENT - bruk teknikker som et ekte spørsmål til følgerne,
  en liten cliffhanger/uferdig tanke, en sårbar/ærlig detalj, eller noe som inviterer til kommentarer
  (uenighet, "tag noen som...", "hvem kjenner seg igjen", osv.) - varier teknikken mellom forslagene.
- Naturlig lengde for kortformat-video-captions (typisk 1-4 setninger, ikke en vegg med tekst).
- Bruk emojis sparsomt og naturlig, ikke i hver setning.
- Inkluder 3-6 relevante hashtags til slutt i hver caption (relevant for musikk/DJ/festival-nisjen),
  ikke overdriv antallet.
- Gi hvert forslag en kort stil-label som forklarer teknikken, f.eks. "Ærlig/sårbar", "Spørsmål til følgere",
  "Cliffhanger", "Dristig påstand", "Storytime".

Svar KUN med gyldig JSON, en liste av objekter med nøyaktig disse feltene:
[
  { "label": "Kort stil-label", "text": "Selve caption-teksten inkl. hashtags" }
]

Ikke inkluder noe annet enn selve JSON-arrayen - ingen markdown-fences, ingen forklaringstekst.`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("Ingen tekst i svaret fra Claude.");

  const cleaned = textBlock.text.trim().replace(/^```json\s*|^```\s*|```$/g, "");
  let captions;
  try {
    captions = JSON.parse(cleaned);
  } catch (e) {
    throw new Error("Kunne ikke parse JSON fra Claude: " + e.message);
  }

  const insertMany = db.transaction((items) => {
    for (const item of items) {
      insertCaption.run({
        idea_id: ideaId || null,
        topic: ideaId ? null : topic.trim(),
        label: item.label || "Forslag",
        text: item.text || "",
      });
    }
  });
  insertMany(captions);
  return captions;
}

const app = express();
// CORS: la ptp-internal (statisk side via Web Station, annen port/opphav) kalle dette API-et.
// Sett ALLOWED_ORIGIN til f.eks. "http://<NAS-IP>:<web-station-port>" for å begrense,
// eller la stå tom for å tillate alle opphav på det lokale nettverket (enklest for internt bruk).
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";
app.use(cors({ origin: ALLOWED_ORIGIN ? ALLOWED_ORIGIN.split(",") : true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/ideas", (req, res) => {
  const showUsed = req.query.used === "1";
  const rows = db
    .prepare(
      `SELECT * FROM ideas WHERE used = ? ORDER BY created_at DESC LIMIT 200`
    )
    .all(showUsed ? 1 : 0);
  res.json(rows);
});

app.post("/api/ideas/generate", async (req, res) => {
  try {
    const count = parseInt(req.body?.count, 10) || IDEAS_PER_BATCH;
    const n = await generateIdeas(count);
    res.json({ ok: true, generated: n });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/ideas/:id/used", (req, res) => {
  const used = req.body?.used ? 1 : 0;
  db.prepare(`UPDATE ideas SET used = ? WHERE id = ?`).run(used, req.params.id);
  res.json({ ok: true });
});

app.delete("/api/ideas/:id", (req, res) => {
  db.prepare(`DELETE FROM ideas WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

app.post("/api/captions/generate", async (req, res) => {
  try {
    const { ideaId, topic, count } = req.body || {};
    const captions = await generateCaptions({
      ideaId: ideaId || null,
      topic: topic || null,
      count: parseInt(count, 10) || 4,
    });
    res.json({ ok: true, captions });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/captions", (req, res) => {
  if (req.query.ideaId) {
    const rows = db
      .prepare(`SELECT * FROM captions WHERE idea_id = ? ORDER BY created_at DESC`)
      .all(req.query.ideaId);
    return res.json(rows);
  }
  // Standalone (fritekst-tema) captions, gruppert per generering (samme created_at-minutt)
  const rows = db
    .prepare(`SELECT * FROM captions WHERE idea_id IS NULL ORDER BY created_at DESC LIMIT 100`)
    .all();
  res.json(rows);
});

app.delete("/api/captions/:id", (req, res) => {
  db.prepare(`DELETE FROM captions WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, hasApiKey: !!ANTHROPIC_API_KEY, cron: CRON_SCHEDULE });
});

if (ANTHROPIC_API_KEY) {
  cron.schedule(CRON_SCHEDULE, () => {
    generateIdeas().catch((e) => console.error("Cron-generering feilet:", e.message));
  });
  console.log(`Cron satt opp: genererer ${IDEAS_PER_BATCH} idéer på schedule "${CRON_SCHEDULE}"`);
} else {
  console.warn("ANTHROPIC_API_KEY mangler - automatisk generering er av. Sett den i .env.");
}

app.listen(PORT, () => {
  console.log(`Daily Content Ideas kjører på http://localhost:${PORT}`);
});
