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

// ---- Brand contexts: one per tab. Override any of these via env vars if the
// details ever change; defaults reflect the real Palm Tree Productions setup. ----
const CATEGORIES = ["kygo", "palm-tree-productions", "johannes-lovund"];

const BRAND_CONTEXTS = {
  "kygo":
    process.env.BRAND_CONTEXT_KYGO ||
    `
Kygo (Kyrre Gørvell-Dahll) is a globally renowned Norwegian DJ and producer, and pioneer of the
tropical house genre, with hundreds of millions of streams and major festival headline slots
worldwide. Content for this tab is about Kygo the artist - his music, his live shows, and his
lifestyle. Do NOT center ideas on his business ventures (Palm Tree Records, Palm Tree Crew, Palm
Tree Music Festival) - those are separate brand/business concerns, not artist content.
Recurring, evergreen facts (still true regardless of the current date): he plays a recurring
summer residency at Ushuaïa Ibiza; he tours and headlines major festivals worldwide; his sound
blends tropical house with pop/vocal collaborations.
Lifestyle/visual identity: tropical paradise and sunset imagery, a blend of laid-back luxury and
high-energy festival euphoria, life on the road between shows.
Audience: a huge international fanbase across Instagram, TikTok, and YouTube Shorts who respond
to sun-drenched visuals, festival-mainstage energy, feel-good dance music, and glimpses of life
on tour.
IMPORTANT - staying current: do not rely on any specific song, city, or tour stop from your
training data or a past conversation - those go stale fast (a promo cycle ends, a tour moves on
to the next city). Use the web search tool to check what his actual current/most recent single is
and what shows are genuinely upcoming before writing ideas, and prefer ideas anchored to what's
current or upcoming over anything already past. If a search doesn't turn up anything currently
promotable, default to generic, evergreen show/lifestyle formats (soundcheck, life between shows,
studio process, festival crowd energy) that don't depend on one specific place or moment and stay
executable indefinitely going forward - never anchor an idea to a location or event that has
already passed.
Ideas must be concrete enough to actually film or produce within a few days.
    `.trim(),
  "palm-tree-productions":
    process.env.BRAND_CONTEXT_PTP ||
    `
Palm Tree Productions is a high-end video and photo production company based in Ålesund, Norway,
founded in 2018 by Johannes Lovund. The studio produces music videos, live performance films,
commercials, and fashion content for artists including Kygo, Sam Feldt, Frank Walker, and Martin
Garrix & DubVision. Audience: prospective clients (artists, brands, agencies) and the wider creative
industry, mainly on Instagram and LinkedIn. Content style: behind-the-scenes of real shoots, crew
and gear spotlights, the fjord/Nordic setting as a visual signature, and craft-focused storytelling
about how the work actually gets made - never generic "book us now" sales pitches.
    `.trim(),
  "johannes-lovund":
    process.env.BRAND_CONTEXT_JOHANNES ||
    `
Johannes Lovund is the founder and director of Palm Tree Productions, a video/photo production
company based in Ålesund, Norway. This is his personal creator account, distinct from the company's
own. Audience: other filmmakers, creative entrepreneurs, and people curious about the person behind
the camera. Content style: personal, first-person, founder-voice storytelling - what it's actually
like building an internationally-booked production company from a small Norwegian town, on-set
decisions, travel between shoots, lessons learned. Should feel authentic, never corporate.
    `.trim(),
};

function brandContextFor(category) {
  return BRAND_CONTEXTS[category] || BRAND_CONTEXTS["kygo"];
}
function isValidCategory(category) {
  return CATEGORIES.includes(category);
}

const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS song_release_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    song_title TEXT NOT NULL,
    song_description TEXT NOT NULL,
    strategy_summary TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS ideas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL DEFAULT 'kygo',
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    platform TEXT,
    hook TEXT,
    format TEXT,
    used INTEGER NOT NULL DEFAULT 0,
    favorited INTEGER NOT NULL DEFAULT 0,
    plan_id INTEGER,
    phase TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(plan_id) REFERENCES song_release_plans(id) ON DELETE CASCADE
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS captions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idea_id INTEGER,
    category TEXT,
    topic TEXT,
    label TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(idea_id) REFERENCES ideas(id) ON DELETE CASCADE
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS inspiration (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    format TEXT,
    why_it_works TEXT,
    source_url TEXT,
    source_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Safe migration for DBs created before this schema (adds columns if missing).
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn("ideas", "category", "TEXT NOT NULL DEFAULT 'kygo'");
ensureColumn("ideas", "plan_id", "INTEGER");
ensureColumn("ideas", "phase", "TEXT");
ensureColumn("ideas", "favorited", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("captions", "category", "TEXT");
ensureColumn("inspiration", "source_url", "TEXT");
ensureColumn("inspiration", "source_name", "TEXT");

const insertIdea = db.prepare(`
  INSERT INTO ideas (category, title, description, platform, hook, format, plan_id, phase)
  VALUES (@category, @title, @description, @platform, @hook, @format, @plan_id, @phase)
`);

const insertCaption = db.prepare(`
  INSERT INTO captions (idea_id, category, topic, label, text)
  VALUES (@idea_id, @category, @topic, @label, @text)
`);

const insertInspiration = db.prepare(`
  INSERT INTO inspiration (category, title, description, format, why_it_works, source_url, source_name)
  VALUES (@category, @title, @description, @format, @why_it_works, @source_url, @source_name)
`);

const insertPlan = db.prepare(`
  INSERT INTO song_release_plans (song_title, song_description, strategy_summary)
  VALUES (@song_title, @song_description, @strategy_summary)
`);

function requireAnthropic() {
  if (!anthropic) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env and restart the container.");
  }
}

function parseJsonFromClaude(text, label) {
  const cleaned = text.trim().replace(/^```json\s*|^```\s*|```$/g, "");
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Claude sometimes wraps the JSON in a sentence or two, even when asked not to
    // (more likely when web search is involved). Fall back to grabbing the outermost
    // [...] or {...} block before giving up.
    const match = cleaned.match(/[[{][\s\S]*[\]}]/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e2) {
        // fall through to the original error below
      }
    }
    throw new Error(`Could not parse JSON from Claude (${label}): ${e.message}`);
  }
}

async function askClaude(prompt, maxTokens = 2000) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text in Claude's response.");
  return textBlock.text;
}

// For prompts that use the web search tool: Claude's content array can contain an
// early "I'll search for..." text block before the search runs, so the FINAL text
// block (after any search results) is the one with the actual answer.
async function askClaudeWithSearch(prompt, maxTokens = 2000, maxSearches = 5) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxSearches }],
  });
  const textBlocks = response.content.filter((b) => b.type === "text");
  if (!textBlocks.length) throw new Error("No text in Claude's response.");
  return textBlocks[textBlocks.length - 1].text;
}

async function generateIdeas(category, count = IDEAS_PER_BATCH) {
  requireAnthropic();
  const prompt = `${brandContextFor(category)}

Generate ${count} new, concrete short-form video content ideas (Reels/TikTok/Shorts) for this
brand, executable moving forward from today. Avoid repeating generic "show your studio life"
suggestions - be specific about WHAT TO FILM, even when the idea itself is a generic, evergreen
format.

If it's genuinely useful, search the web first to check for anything current or upcoming (a
recent release, an announced show) worth anchoring an idea to. But do NOT force every idea to
reference a specific fact - most ideas should be generic, evergreen show/lifestyle/creative-
process formats that don't depend on one place or moment and stay executable indefinitely. Only
anchor an idea to a specific real detail if it is CURRENT or UPCOMING - never to something that
has already happened or a promo cycle that has already ended (e.g. a city already toured through,
a single no longer being actively promoted).
For the level of specificity expected in the FILMING instructions themselves (this is about
concreteness of execution, not about naming specific past events):
BAD (too vague to act on): "Post a clip of the artist in the studio working on new music."
GOOD (concrete and evergreen): "Film a single continuous take from the moment a new idea's first
loop plays back for the first time, ending exactly on the artist's unfiltered reaction - no
retakes, no cuts."

Respond with ONLY valid JSON, a list of objects with exactly these fields:
[
  {
    "title": "Short title (max 8 words)",
    "description": "1-3 sentences explaining concretely what to film/create",
    "platform": "Instagram Reels | TikTok | YouTube Shorts | All",
    "hook": "Suggested first 1-3 seconds / hook line",
    "format": "e.g. POV, Behind-the-scenes, Skit, Tutorial, Countdown, Duet/Collab, Storytime"
  }
]

Do not include anything other than the JSON array itself - no markdown fences, no explanation
text. Write the final JSON as your last message, after any searching.`;

  const text = await askClaudeWithSearch(prompt, 2500, 3);
  const ideas = parseJsonFromClaude(text, "ideas");

  const insertMany = db.transaction((items) => {
    for (const item of items) {
      insertIdea.run({
        category,
        title: item.title || "Untitled",
        description: item.description || "",
        platform: item.platform || "",
        hook: item.hook || "",
        format: item.format || "",
        plan_id: null,
        phase: null,
      });
    }
  });
  insertMany(ideas);
  return ideas.length;
}

async function generateCaptions({ ideaId, topic, category, count = 4 }) {
  requireAnthropic();

  let subjectContext;
  let idea = null;
  let effectiveCategory = category;
  if (ideaId) {
    idea = db.prepare(`SELECT * FROM ideas WHERE id = ?`).get(ideaId);
    if (!idea) throw new Error("Could not find that content idea.");
    effectiveCategory = idea.category;
    subjectContext = `The post this caption is for:
Title: ${idea.title}
Description: ${idea.description}
Hook: ${idea.hook || "(none)"}
Format: ${idea.format || "(unknown)"}
Platform: ${idea.platform || "(unknown)"}`;
  } else if (topic && topic.trim()) {
    if (!isValidCategory(effectiveCategory)) {
      throw new Error("A valid category is required when writing a caption from a free-text topic.");
    }
    subjectContext = `The post this caption is for: ${topic.trim()}`;
  } else {
    throw new Error("Need either a content idea or a free-text topic to write a caption for.");
  }

  const prompt = `${brandContextFor(effectiveCategory)}

${subjectContext}

Write ${count} different caption suggestions for this post.
Requirements:
- SHORT AND PRECISE - 1-2 sentences, rarely 3. Every word must earn its place. No filler, no
  wall of text.
- They must still feel PERSONAL - written in first person, as if the account owner wrote it
  themselves, not a marketing department. Avoid generic phrases like "Check this out!" or "New
  content out now!".
- They must be written to drive ENGAGEMENT - use techniques like a genuine question to followers,
  a small cliffhanger/unfinished thought, a vulnerable/honest detail, or something that invites
  comments (disagreement, "tag someone who...", "who else relates", etc.) - vary the technique
  between suggestions.
- Use emojis sparingly and naturally, not in every sentence.
- Do NOT include hashtags of any kind.
- Give each suggestion a short style label explaining the technique, e.g. "Honest/vulnerable",
  "Question to followers", "Cliffhanger", "Bold claim", "Storytime".

Respond with ONLY valid JSON, a list of objects with exactly these fields:
[
  { "label": "Short style label", "text": "The caption text itself - no hashtags" }
]

Do not include anything other than the JSON array itself - no markdown fences, no explanation text.`;

  const text = await askClaude(prompt, 1500);
  const captions = parseJsonFromClaude(text, "captions");

  const insertMany = db.transaction((items) => {
    for (const item of items) {
      insertCaption.run({
        idea_id: ideaId || null,
        category: effectiveCategory,
        topic: ideaId ? null : topic.trim(),
        label: item.label || "Suggestion",
        text: item.text || "",
      });
    }
  });
  insertMany(captions);
  return captions;
}

// "Inspiration" searches the live web for real, currently-circulating posts/moments in this
// niche and cites a real source URL for each one - it does not invent examples. If search
// doesn't turn up enough verifiable, on-topic results, it returns fewer items rather than
// padding the list with anything unsourced.
async function generateInspiration(category, count = 6) {
  requireAnthropic();
  const prompt = `${brandContextFor(category)}

Search the web for up to ${count} REAL, currently-circulating social media posts, clips, or
short-form video moments that are relevant to this brand's niche and are getting strong
engagement or being written about as trending/viral right now. This can include: the artist's
own posts, other artists/DJs in the same niche, or fan-made content reacting to them.

Rules:
- Every item MUST be backed by something you actually found via search - a real article, post,
  or page you can cite a URL for. Do not invent or reconstruct examples from memory alone.
- If you can't find ${count} genuinely real, verifiable, on-topic examples, return fewer items.
  Returning 2 real ones is better than padding to ${count} with anything unverified.
- For each item, explain concretely why it's relevant/well-performing, and how the ideas behind
  it could translate into a new piece of content for this brand.

Respond with ONLY valid JSON, a list of objects with exactly these fields:
[
  {
    "title": "Short name for this real post/moment (max 10 words)",
    "description": "1-3 sentences on what it actually is and what's happening in it",
    "format": "e.g. Reaction, Duet/Stitch, POV, Countdown, Transformation, Storytime",
    "whyItWorks": "1-2 sentences on why it's working, and how to adapt the idea for this brand",
    "sourceUrl": "the real URL you found this via search",
    "sourceName": "short name of the source, e.g. the platform or publication"
  }
]

Do not include anything other than the JSON array itself - no markdown fences, no explanation text.
Write the final JSON as your last message, after any searching.`;

  const text = await askClaudeWithSearch(prompt, 3000, 6);
  const items = parseJsonFromClaude(text, "inspiration");

  const insertMany = db.transaction((rows) => {
    for (const item of rows) {
      insertInspiration.run({
        category,
        title: item.title || "Untitled",
        description: item.description || "",
        format: item.format || "",
        why_it_works: item.whyItWorks || "",
        source_url: item.sourceUrl || null,
        source_name: item.sourceName || null,
      });
    }
  });
  insertMany(items);
  return items.length;
}

async function generateSongReleasePlan(songTitle, songDescription) {
  requireAnthropic();
  const prompt = `${brandContextFor("kygo")}

A new song is being planned for release:
Song title: ${songTitle}
Description: ${songDescription}

Create a social media rollout plan for short-form video (Reels/TikTok/Shorts) covering three
phases: "Teaser (pre-release)", "Release Day", and "Sustain (weeks after release)".
For each phase, give 3-5 concrete content ideas specific to THIS song (use its title/description/
mood, don't be generic). Also write a short overall strategy summary (2-4 sentences) explaining
the narrative arc across the phases.

Respond with ONLY valid JSON with exactly this shape:
{
  "strategySummary": "2-4 sentence overall strategy",
  "ideas": [
    {
      "phase": "Teaser (pre-release)" | "Release Day" | "Sustain (weeks after release)",
      "title": "Short title (max 8 words)",
      "description": "1-3 sentences explaining concretely what to film/create",
      "platform": "Instagram Reels | TikTok | YouTube Shorts | All",
      "hook": "Suggested first 1-3 seconds / hook line",
      "format": "e.g. POV, Behind-the-scenes, Skit, Tutorial, Countdown, Duet/Collab, Storytime"
    }
  ]
}

Do not include anything other than the JSON object itself - no markdown fences, no explanation text.`;

  const text = await askClaude(prompt, 3000);
  const plan = parseJsonFromClaude(text, "song release plan");
  if (!plan || !Array.isArray(plan.ideas)) {
    throw new Error("Claude's response was missing the expected 'ideas' list.");
  }

  const result = db.transaction(() => {
    const info = insertPlan.run({
      song_title: songTitle,
      song_description: songDescription,
      strategy_summary: plan.strategySummary || "",
    });
    const planId = info.lastInsertRowid;
    for (const item of plan.ideas) {
      insertIdea.run({
        category: "song-release-plan",
        title: item.title || "Untitled",
        description: item.description || "",
        platform: item.platform || "",
        hook: item.hook || "",
        format: item.format || "",
        plan_id: planId,
        phase: item.phase || "",
      });
    }
    return planId;
  })();

  return result;
}

const app = express();
// CORS: lets ptp-internal (a different origin) call this API.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";
app.use(cors({ origin: ALLOWED_ORIGIN ? ALLOWED_ORIGIN.split(",") : true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---- Ideas ----
app.get("/api/ideas", (req, res) => {
  const category = req.query.category;
  if (category && !isValidCategory(category) && category !== "song-release-plan") {
    return res.status(400).json({ error: "Invalid category" });
  }
  // Favorites are shown regardless of used state - they persist until manually
  // unfavorited or deleted, independent of the new/used workflow.
  if (req.query.favorited === "1") {
    const rows = category
      ? db
          .prepare(`SELECT * FROM ideas WHERE favorited = 1 AND category = ? ORDER BY created_at DESC LIMIT 200`)
          .all(category)
      : db.prepare(`SELECT * FROM ideas WHERE favorited = 1 ORDER BY created_at DESC LIMIT 200`).all();
    return res.json(rows);
  }
  const showUsed = req.query.used === "1";
  const rows = category
    ? db
        .prepare(`SELECT * FROM ideas WHERE used = ? AND category = ? ORDER BY created_at DESC LIMIT 200`)
        .all(showUsed ? 1 : 0, category)
    : db.prepare(`SELECT * FROM ideas WHERE used = ? ORDER BY created_at DESC LIMIT 200`).all(showUsed ? 1 : 0);
  res.json(rows);
});

app.post("/api/ideas/generate", async (req, res) => {
  try {
    const category = req.body?.category;
    if (!isValidCategory(category)) {
      return res.status(400).json({ ok: false, error: "Invalid or missing category" });
    }
    const count = parseInt(req.body?.count, 10) || IDEAS_PER_BATCH;
    const n = await generateIdeas(category, count);
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

app.post("/api/ideas/:id/favorite", (req, res) => {
  const favorited = req.body?.favorited ? 1 : 0;
  db.prepare(`UPDATE ideas SET favorited = ? WHERE id = ?`).run(favorited, req.params.id);
  res.json({ ok: true });
});

app.delete("/api/ideas/:id", (req, res) => {
  db.prepare(`DELETE FROM ideas WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ---- Captions ----
app.post("/api/captions/generate", async (req, res) => {
  try {
    const { ideaId, topic, category, count } = req.body || {};
    const captions = await generateCaptions({
      ideaId: ideaId || null,
      topic: topic || null,
      category: category || null,
      count: parseInt(count, 10) || 4,
    });
    res.json({ ok: true, captions });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/captions", (req, res) => {
  if (req.query.ideaId) {
    const rows = db.prepare(`SELECT * FROM captions WHERE idea_id = ? ORDER BY created_at DESC`).all(req.query.ideaId);
    return res.json(rows);
  }
  // Standalone (free-text topic) captions, grouped client-side by topic + minute created.
  const category = req.query.category;
  const rows = category
    ? db
        .prepare(`SELECT * FROM captions WHERE idea_id IS NULL AND category = ? ORDER BY created_at DESC LIMIT 100`)
        .all(category)
    : db.prepare(`SELECT * FROM captions WHERE idea_id IS NULL ORDER BY created_at DESC LIMIT 100`).all();
  res.json(rows);
});

app.delete("/api/captions/:id", (req, res) => {
  db.prepare(`DELETE FROM captions WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ---- Inspiration ----
app.get("/api/inspiration", (req, res) => {
  const category = req.query.category;
  if (!isValidCategory(category)) {
    return res.status(400).json({ error: "Invalid or missing category" });
  }
  const rows = db
    .prepare(`SELECT * FROM inspiration WHERE category = ? ORDER BY created_at DESC LIMIT 100`)
    .all(category);
  res.json(rows);
});

app.post("/api/inspiration/generate", async (req, res) => {
  try {
    const category = req.body?.category;
    if (!isValidCategory(category)) {
      return res.status(400).json({ ok: false, error: "Invalid or missing category" });
    }
    const count = parseInt(req.body?.count, 10) || 6;
    const n = await generateInspiration(category, count);
    res.json({ ok: true, generated: n });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete("/api/inspiration/:id", (req, res) => {
  db.prepare(`DELETE FROM inspiration WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ---- Song Release Plans ----
app.get("/api/song-release-plans", (req, res) => {
  const plans = db.prepare(`SELECT * FROM song_release_plans ORDER BY created_at DESC LIMIT 50`).all();
  res.json(plans);
});

app.get("/api/song-release-plans/:id", (req, res) => {
  const plan = db.prepare(`SELECT * FROM song_release_plans WHERE id = ?`).get(req.params.id);
  if (!plan) return res.status(404).json({ error: "Plan not found" });
  const ideas = db
    .prepare(`SELECT * FROM ideas WHERE plan_id = ? ORDER BY id ASC`)
    .all(req.params.id);
  res.json({ ...plan, ideas });
});

app.post("/api/song-release-plans/generate", async (req, res) => {
  try {
    const { songTitle, songDescription } = req.body || {};
    if (!songTitle || !songTitle.trim() || !songDescription || !songDescription.trim()) {
      return res.status(400).json({ ok: false, error: "Song title and description are both required." });
    }
    const planId = await generateSongReleasePlan(songTitle.trim(), songDescription.trim());
    res.json({ ok: true, planId });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete("/api/song-release-plans/:id", (req, res) => {
  db.prepare(`DELETE FROM song_release_plans WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, hasApiKey: !!ANTHROPIC_API_KEY, cron: CRON_SCHEDULE, categories: CATEGORIES });
});

if (ANTHROPIC_API_KEY) {
  cron.schedule(CRON_SCHEDULE, () => {
    for (const category of CATEGORIES) {
      generateIdeas(category).catch((e) => console.error(`Cron generation failed for ${category}:`, e.message));
    }
  });
  console.log(`Cron set up: generates ${IDEAS_PER_BATCH} ideas per category (${CATEGORIES.join(", ")}) on schedule "${CRON_SCHEDULE}"`);
} else {
  console.warn("ANTHROPIC_API_KEY is missing - automatic generation is off. Set it in .env.");
}

app.listen(PORT, () => {
  console.log(`Daily Content Ideas running on http://localhost:${PORT}`);
});
