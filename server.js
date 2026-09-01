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
const CAPTIONS_PER_BATCH = parseInt(process.env.CAPTIONS_PER_BATCH || "5", 10);
// Cron format: min hour day month weekday, interpreted in CRON_TIMEZONE below.
// Default: every day at 07:00 Norway time (auto-adjusts for daylight saving).
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "0 7 * * *";
const CRON_TIMEZONE = process.env.CRON_TIMEZONE || "Europe/Oslo";

// ---- Brand contexts: one per tab. Override any of these via env vars if the
// details ever change; defaults reflect the real Palm Tree Productions setup. ----
const CATEGORIES = ["kygo", "palm-tree-productions", "johannes-lovund"];

// Kygo-specific sub-filters for the New Ideas / Used / Favorites views. Other
// categories don't use these yet.
const SUBCATEGORIES = {
  kygo: {
    shows: "Shows - live performance content: performing, backstage, crowd energy, touring life",
    lifestyle: "Lifestyle - sunset/tropical/travel/personal-life content, non-performance moments",
    "music-production": "Music Production - studio, DAW, sound design, the creative process of making music",
  },
};
function isValidSubcategory(category, subcategory) {
  return !!SUBCATEGORIES[category] && Object.prototype.hasOwnProperty.call(SUBCATEGORIES[category], subcategory);
}

const BRAND_CONTEXTS = {
  "kygo":
    process.env.BRAND_CONTEXT_KYGO ||
    `
Kygo (Kyrre Gørvell-Dahll) is a globally renowned Norwegian DJ and producer, and pioneer of the
tropical house genre, with hundreds of millions of streams and major festival headline slots
worldwide. Content for this tab is about Kygo the artist - his music, his live shows, and his
lifestyle. Do NOT center ideas on his business ventures (Palm Tree Records, Palm Tree Crew, Palm
Tree Music Festival) - those are separate brand/business concerns, not artist content.
Evergreen facts (still true regardless of the current date): he tours and headlines major
festivals, club nights, and residencies worldwide - the specific venues and dates change
constantly, so none of them should be treated as a fixed, reusable anchor. His sound blends
tropical house with pop/vocal collaborations.
Lifestyle/visual identity: tropical paradise and sunset imagery, a blend of laid-back luxury and
high-energy festival euphoria, life on the road between shows.
Audience: a huge international fanbase across Instagram, TikTok, and YouTube Shorts who respond
to sun-drenched visuals, festival-mainstage energy, feel-good dance music, and glimpses of life
on tour.
IMPORTANT - do not name a specific venue, city, residency, or show: even ones that seem
recurring change lineup, dates, or stop happening entirely, and a named show goes stale the
moment it's over. Write show-related ideas so they work at WHATEVER show is happening next -
phrase filming instructions generically ("at the next show", "backstage before walking out",
"the closing track of the set") rather than naming a place. The same applies to studio/lifestyle
content: describe a reusable moment or process (a first-listen reaction, packing for the next
trip, a soundcheck ritual), not a specific past session or trip.
IMPORTANT - staying current: do not rely on any specific song, city, or tour stop from your
training data or a past conversation - those go stale fast. If it's genuinely useful, use the
web search tool to check what his actual current/most recent single is before writing ideas, and
prefer ideas anchored to what's current over anything already past - but even then, keep the
filming instructions themselves generic and reusable rather than tied to one specific event.
Ideas must be concrete enough to actually film or produce within a few days.
    `.trim(),
  "palm-tree-productions":
    process.env.BRAND_CONTEXT_PTP ||
    `
Palm Tree Productions is a high-end video and photo production company based in Ålesund, Norway,
founded in 2018 as a joint venture between director Johannes Lovund and Kygo (the DJ/producer),
dual-based in Ålesund, Norway and Miami, Florida. Focus: music videos, live productions, artist
storytelling, and bold commercial/brand and fashion films - hands-on from shoot through final
edit, valuing emotional depth and strong visual style over generic corporate polish. Real project
credits to draw on (use these, don't invent client names): Kygo, Frank Walker, Joe Jonas, Shawn
Mendes, Rita Ora, Dean Lewis, Jamie Foxx, and 50 Cent.
Audience: prospective clients (artists, brands, agencies) and the wider creative/production
industry, mainly on Instagram (@palmtree.productions) and LinkedIn.
Content style: behind-the-scenes of real shoots, crew and gear spotlights, the contrast between
the Ålesund/Nordic fjord setting and the Miami setting as a dual visual signature, and
craft-focused storytelling about how the work actually gets made - never generic "book us now"
sales pitches. Ideas should work for most shoots/projects, not one specific one - describe a
reusable moment or technique (a lighting setup reveal, a rough-cut-vs-final comparison, a gear
walkthrough) rather than naming one particular past shoot or client by name unless it's being
used purely as a credibility reference, not the whole premise of the idea.
    `.trim(),
  "johannes-lovund":
    process.env.BRAND_CONTEXT_JOHANNES ||
    `
Johannes Lovund is a director, producer, and photographer, and the co-founder & CEO of Palm Tree
Productions (a joint venture with Kygo). He was ranked the #1 music photographer by EDMSauce.com
readers (19,000 votes across 63 countries, out of 50 nominees) - a genuine, citable credibility
marker, not a vague claim. From Ålesund, Norway; grounded small-town roots contrasted with a
career shooting/directing globally for artists including Kygo, Frank Walker, Joe Jonas, Shawn
Mendes, Rita Ora, Dean Lewis, Jamie Foxx, and 50 Cent.
This is his PERSONAL creator account, distinct from the Palm Tree Productions company account.
Audience: other filmmakers, photographers, and creative entrepreneurs, plus people curious about
the person behind the camera - not primarily prospective clients (that's the company account's
job). Content style: personal, first-person, founder/creator-voice storytelling - what it
actually feels like directing and shooting globally-known artists while still being based in a
small Norwegian town, the craft/eye behind the photography, on-set decisions, lessons learned.
Should feel authentic and personal, never corporate. Ideas should work for most shoots/trips, not
one specific one - describe a reusable moment, ritual, or reflection rather than naming one
particular past session unless it's purely a credibility reference.
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
    subcategory TEXT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    template TEXT,
    platform TEXT,
    hook TEXT,
    format TEXT,
    used INTEGER NOT NULL DEFAULT 0,
    favorited INTEGER NOT NULL DEFAULT 0,
    trend_note TEXT,
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
    subcategory TEXT,
    topic TEXT,
    label TEXT NOT NULL,
    text TEXT NOT NULL,
    favorited INTEGER NOT NULL DEFAULT 0,
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
ensureColumn("captions", "subcategory", "TEXT");
ensureColumn("captions", "favorited", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("inspiration", "source_url", "TEXT");
ensureColumn("inspiration", "source_name", "TEXT");
ensureColumn("ideas", "trend_note", "TEXT");
ensureColumn("ideas", "template", "TEXT");
ensureColumn("ideas", "subcategory", "TEXT");

const insertIdea = db.prepare(`
  INSERT INTO ideas (category, subcategory, title, description, template, platform, hook, format, trend_note, plan_id, phase)
  VALUES (@category, @subcategory, @title, @description, @template, @platform, @hook, @format, @trend_note, @plan_id, @phase)
`);

const insertCaption = db.prepare(`
  INSERT INTO captions (idea_id, category, subcategory, topic, label, text)
  VALUES (@idea_id, @category, @subcategory, @topic, @label, @text)
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

function looksLikeJson(text) {
  return /[[{][\s\S]*[\]}]/.test(text.trim());
}

// Temporary diagnostics for a search-generation bug: captures a summary of each
// turn's raw content blocks so it can be inspected via GET /api/debug/last-search
// without needing shell access to the container. Safe to leave in - no secrets,
// small ring buffer.
const searchDebugLog = [];
function recordSearchDebug(label, response) {
  searchDebugLog.push({
    at: new Date().toISOString(),
    label,
    stop_reason: response.stop_reason,
    blocks: response.content.map((b) => ({
      type: b.type,
      preview: b.type === "text" ? b.text.slice(0, 300) : b.type === "server_tool_use" ? JSON.stringify(b.input) : undefined,
    })),
  });
  while (searchDebugLog.length > 20) searchDebugLog.shift();
}

// For prompts that use the web search tool. Two failure modes this guards against:
// 1. A long search sequence can make the API pause the turn mid-work (stop_reason
//    "pause_turn") before Claude ever writes the final answer - we resend the paused
//    assistant content and continue, per Anthropic's documented pattern.
// 2. Even without pausing, Claude sometimes ends a long search sequence with only
//    narration ("I now have enough info to...") and never actually writes the JSON.
//    If nothing in the response looks like JSON, we give it one explicit nudge to
//    just answer, instead of failing outright.
async function askClaudeWithSearch(prompt, maxTokens = 2000, maxSearches = 5) {
  const messages = [{ role: "user", content: prompt }];
  const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: maxSearches }];

  async function runTurn() {
    let response = await anthropic.messages.create({ model: MODEL, max_tokens: maxTokens, messages, tools });
    recordSearchDebug("turn", response);
    let loops = 0;
    while (response.stop_reason === "pause_turn" && loops < 5) {
      messages.push({ role: "assistant", content: response.content });
      response = await anthropic.messages.create({ model: MODEL, max_tokens: maxTokens, messages, tools });
      recordSearchDebug("pause_turn continuation", response);
      loops++;
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error("Claude's response was cut off before finishing (hit the token limit) - try again.");
    }
    const textBlocks = response.content.filter((b) => b.type === "text");
    if (!textBlocks.length) throw new Error("No text in Claude's response.");
    return { response, text: textBlocks.map((b) => b.text).join("\n\n") };
  }

  let { response, text } = await runTurn();

  if (!looksLikeJson(text)) {
    messages.push({ role: "assistant", content: response.content });
    messages.push({
      role: "user",
      content: "You did not include the requested JSON in your last response. Respond with ONLY the JSON now - no other text.",
    });
    ({ text } = await runTurn());
  }

  return text;
}

async function generateIdeas(category, count = IDEAS_PER_BATCH, subcategory = null) {
  requireAnthropic();
  const subcats = SUBCATEGORIES[category];
  let subcategoryInstruction = "";
  if (subcats) {
    const list = Object.entries(subcats).map(([key, desc]) => `- "${key}": ${desc}`).join("\n");
    subcategoryInstruction = subcategory
      ? `\nEvery one of the ${count} ideas must be in the "${subcategory}" subcategory specifically:\n${subcats[subcategory]}\n`
      : `\nEach idea must be tagged with exactly one of these subcategories, spread roughly evenly across all of them:\n${list}\n`;
  }

  const prompt = `${brandContextFor(category)}
${subcategoryInstruction}
Generate ${count} new, concrete short-form video content ideas (Reels/TikTok/Shorts) for this
brand, executable moving forward from today. Avoid repeating generic "show your studio life"
suggestions - be specific about WHAT TO FILM, even when the idea itself is a generic, evergreen
format.

Ideas should work for MOST shows, studio sessions, or lifestyle moments, not one specific one -
never name a specific venue, city, or date. Write show ideas so they're just as usable at
whatever show comes up next ("backstage before walking out", "the last track of the set"), and
studio/lifestyle ideas as a reusable moment or ritual, not a specific past session or trip.
If it's genuinely useful, search the web first to check what his current/most recent single is,
so a caption or hook can reference the right song by name - but keep the FILMING instructions
themselves generic and reusable regardless of which song or show it ends up being used for.

Also search for what's broadly going viral right now - not just in this niche, but trending
sounds, memes, formats, and cultural moments across social media generally - and see if 1-2 of
the ${count} ideas can genuinely and naturally tie into one of them (e.g. using a trending sound
or format, riding a lighthearted meme). Only do this where the connection feels natural, not
forced.
HARD RULE: never tie an idea to anything sensitive - a death, tragedy, disaster, injury, illness,
or controversy, celebrity or otherwise. Trend-jacking a tragedy for engagement is exactly the
kind of thing that damages a brand rather than helping it. If the only trending topics you find
are sensitive in nature, skip trend-tie-ins entirely for this batch and just write evergreen
ideas instead - do not force a connection to something inappropriate.

For the level of specificity expected in the FILMING instructions themselves (this is about
concreteness of execution, not about naming specific past events):
BAD (too vague to act on): "Post a clip of the artist in the studio working on new music."
GOOD (concrete and evergreen): "Film a single continuous take from the moment a new idea's first
loop plays back for the first time, ending exactly on the artist's unfiltered reaction - no
retakes, no cuts."

Also write each idea as a reusable, fill-in-the-blank TEMPLATE, separate from the concrete
description - the abstracted formula behind the idea, with the swappable parts in [brackets], so
it can be reused again later with different specifics. Example pairing:
description: "Film the exact moment the drop hits in the new single, played for the first time
on someone's car speakers, captioned with their genuine reaction."
template: "Play [a specific track] for [someone] on [an everyday speaker/setting] for the first
time → hold on their unfiltered reaction → caption with what they said, verbatim."

Respond with ONLY valid JSON, a list of objects with exactly these fields:
[
  {
    "title": "Short title (max 8 words)",
    "description": "1-3 sentences explaining concretely what to film/create",
    "template": "The reusable fill-in-the-blank formula behind this idea, with [bracketed] parts",
    "platform": "Instagram Reels | TikTok | YouTube Shorts | All",
    "hook": "Suggested first 1-3 seconds / hook line",
    "format": "e.g. POV, Behind-the-scenes, Skit, Tutorial, Countdown, Duet/Collab, Storytime",
    "trendNote": "if this idea rides a current trend, briefly name it (e.g. 'uses trending sound: [name]'); otherwise null"${subcats ? `,\n    "subcategory": "one of: ${Object.keys(subcats).join(" | ")}"` : ""}
  }
]

Do not include anything other than the JSON array itself - no markdown fences, no explanation
text. Write the final JSON as your last message, after any searching.`;

  const text = await askClaudeWithSearch(prompt, 2800, 5);
  const ideas = parseJsonFromClaude(text, "ideas");

  const insertMany = db.transaction((items) => {
    for (const item of items) {
      insertIdea.run({
        category,
        subcategory: subcategory || (isValidSubcategory(category, item.subcategory) ? item.subcategory : null),
        title: item.title || "Untitled",
        description: item.description || "",
        template: item.template || null,
        platform: item.platform || "",
        hook: item.hook || "",
        format: item.format || "",
        trend_note: item.trendNote || null,
        plan_id: null,
        phase: null,
      });
    }
  });
  insertMany(ideas);
  return ideas.length;
}

async function generateCaptions({ ideaId, topic, category, count = CAPTIONS_PER_BATCH }) {
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

  const effectiveSubcategory = idea ? idea.subcategory || null : null;
  const insertMany = db.transaction((items) => {
    for (const item of items) {
      insertCaption.run({
        idea_id: ideaId || null,
        category: effectiveCategory,
        subcategory: effectiveSubcategory,
        topic: ideaId ? null : topic.trim(),
        label: item.label || "Suggestion",
        text: item.text || "",
      });
    }
  });
  insertMany(captions);
  return captions;
}

// Standalone, subcategory-scoped captions: not tied to one specific idea or user-provided
// topic - each caption imagines its own plausible, evergreen scenario within the subcategory,
// so the batch reads as ready-to-grab caption starters rather than one caption for one post.
async function generateSubcategoryCaptions(category, subcategory, count = CAPTIONS_PER_BATCH) {
  requireAnthropic();
  if (!isValidSubcategory(category, subcategory)) {
    throw new Error("Invalid subcategory for this category.");
  }
  const prompt = `${brandContextFor(category)}

Write ${count} standalone caption ideas for the "${subcategory}" content subcategory:
${SUBCATEGORIES[category][subcategory]}

Each caption should imagine its own plausible, evergreen scenario within this subcategory (don't
reuse the same scenario twice) - something generic enough to pair with a real post later, not
tied to one specific past event, date, or venue.

Requirements:
- SHORT AND PRECISE - 1-2 sentences, rarely 3. Every word must earn its place. No filler, no
  wall of text.
- They must still feel PERSONAL - written in first person, as if the account owner wrote it
  themselves, not a marketing department. Avoid generic phrases like "Check this out!" or "New
  content out now!".
- They must be written to drive ENGAGEMENT - use techniques like a genuine question to followers,
  a small cliffhanger/unfinished thought, a vulnerable/honest detail, or something that invites
  comments - vary the technique between suggestions.
- Use emojis sparingly and naturally, not in every sentence.
- Do NOT include hashtags of any kind.

Respond with ONLY valid JSON, a list of objects with exactly these fields:
[
  {
    "scenario": "A short description of the evergreen scenario this caption imagines (e.g. 'walking out before a show')",
    "label": "Short style label, e.g. Honest/vulnerable, Question to followers, Cliffhanger, Bold claim, Storytime",
    "text": "The caption text itself - no hashtags"
  }
]

Do not include anything other than the JSON array itself - no markdown fences, no explanation text.`;

  const text = await askClaude(prompt, 1800);
  const captions = parseJsonFromClaude(text, "subcategory captions");

  const insertMany = db.transaction((items) => {
    for (const item of items) {
      insertCaption.run({
        idea_id: null,
        category,
        subcategory,
        topic: item.scenario || null,
        label: item.label || "Suggestion",
        text: item.text || "",
      });
    }
  });
  insertMany(captions);
  return captions.length;
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

If it's genuinely useful, search the web for what's currently trending in short-form video
generally, and use a currently-relevant format or sound where it's a natural fit for the song's
mood - never force it. HARD RULE: never tie an idea to anything sensitive (a death, tragedy,
disaster, or controversy) - skip trend references entirely rather than risk that.

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

Do not include anything other than the JSON object itself - no markdown fences, no explanation
text. Write the final JSON as your last message, after any searching.`;

  const text = await askClaudeWithSearch(prompt, 3500, 3);
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
        subcategory: null,
        title: item.title || "Untitled",
        description: item.description || "",
        template: null,
        platform: item.platform || "",
        hook: item.hook || "",
        format: item.format || "",
        trend_note: null,
        plan_id: planId,
        phase: item.phase || "",
      });
    }
    return planId;
  })();

  return result;
}

async function generateMoreSongIdeas(planId, count = 3) {
  requireAnthropic();
  const plan = db.prepare(`SELECT * FROM song_release_plans WHERE id = ?`).get(planId);
  if (!plan) throw new Error("Rollout plan not found.");
  const existingIdeas = db.prepare(`SELECT title, phase FROM ideas WHERE plan_id = ? ORDER BY id ASC`).all(planId);
  const existingList = existingIdeas.length
    ? existingIdeas.map((i) => `- [${i.phase}] ${i.title}`).join("\n")
    : "(none yet)";

  const prompt = `${brandContextFor("kygo")}

A song rollout plan already exists for:
Song title: ${plan.song_title}
Description: ${plan.song_description}
Overall strategy: ${plan.strategy_summary || "(none)"}

Ideas already in this plan (do not repeat these or anything too similar):
${existingList}

Generate ${count} NEW, additional content ideas for this rollout. Assign each to one of the
three phases: "Teaser (pre-release)", "Release Day", or "Sustain (weeks after release)".

Respond with ONLY valid JSON, a list of objects with exactly these fields:
[
  {
    "phase": "Teaser (pre-release)" | "Release Day" | "Sustain (weeks after release)",
    "title": "Short title (max 8 words)",
    "description": "1-3 sentences explaining concretely what to film/create",
    "platform": "Instagram Reels | TikTok | YouTube Shorts | All",
    "hook": "Suggested first 1-3 seconds / hook line",
    "format": "e.g. POV, Behind-the-scenes, Skit, Tutorial, Countdown, Duet/Collab, Storytime"
  }
]

Do not include anything other than the JSON array itself - no markdown fences, no explanation text.`;

  const text = await askClaude(prompt, 2000);
  const newIdeas = parseJsonFromClaude(text, "more song ideas");

  const insertMany = db.transaction((items) => {
    for (const item of items) {
      insertIdea.run({
        category: "song-release-plan",
        subcategory: null,
        title: item.title || "Untitled",
        description: item.description || "",
        template: null,
        platform: item.platform || "",
        hook: item.hook || "",
        format: item.format || "",
        trend_note: null,
        plan_id: planId,
        phase: item.phase || "",
      });
    }
  });
  insertMany(newIdeas);
  return newIdeas.length;
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
  const subcategory = req.query.subcategory;
  if (subcategory && !isValidSubcategory(category, subcategory)) {
    return res.status(400).json({ error: "Invalid subcategory for this category" });
  }

  const conditions = [];
  const params = [];
  // Favorites are shown regardless of used state - they persist until manually
  // unfavorited or deleted, independent of the new/used workflow.
  if (req.query.favorited === "1") {
    conditions.push("favorited = 1");
  } else {
    conditions.push("used = ?");
    params.push(req.query.used === "1" ? 1 : 0);
  }
  if (category) {
    conditions.push("category = ?");
    params.push(category);
  }
  if (subcategory) {
    conditions.push("subcategory = ?");
    params.push(subcategory);
  }

  const rows = db
    .prepare(`SELECT * FROM ideas WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT 200`)
    .all(...params);
  res.json(rows);
});

app.post("/api/ideas/generate", async (req, res) => {
  try {
    const category = req.body?.category;
    if (!isValidCategory(category)) {
      return res.status(400).json({ ok: false, error: "Invalid or missing category" });
    }
    const subcategory = req.body?.subcategory || null;
    if (subcategory && !isValidSubcategory(category, subcategory)) {
      return res.status(400).json({ ok: false, error: "Invalid subcategory for this category" });
    }
    const count = parseInt(req.body?.count, 10) || IDEAS_PER_BATCH;
    const n = await generateIdeas(category, count, subcategory);
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

app.put("/api/ideas/:id", (req, res) => {
  const existing = db.prepare(`SELECT * FROM ideas WHERE id = ?`).get(req.params.id);
  if (!existing) return res.status(404).json({ ok: false, error: "Idea not found" });
  const { title, description, hook, platform, format } = req.body || {};
  db.prepare(`UPDATE ideas SET title = ?, description = ?, hook = ?, platform = ?, format = ? WHERE id = ?`).run(
    title !== undefined ? title : existing.title,
    description !== undefined ? description : existing.description,
    hook !== undefined ? hook : existing.hook,
    platform !== undefined ? platform : existing.platform,
    format !== undefined ? format : existing.format,
    req.params.id
  );
  res.json({ ok: true });
});

app.delete("/api/ideas/:id", (req, res) => {
  db.prepare(`DELETE FROM ideas WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ---- Captions ----
app.post("/api/captions/generate", async (req, res) => {
  try {
    const { ideaId, topic, category, subcategory, count } = req.body || {};
    // Subcategory batch mode: standalone captions for a Kygo sub-tab, no idea/topic needed.
    // Keeps the existing idea-based and free-text-topic modes fully intact alongside this.
    if (!ideaId && !topic && subcategory) {
      if (!isValidCategory(category)) {
        return res.status(400).json({ ok: false, error: "Invalid or missing category" });
      }
      const n = await generateSubcategoryCaptions(category, subcategory, parseInt(count, 10) || CAPTIONS_PER_BATCH);
      return res.json({ ok: true, generated: n });
    }
    const captions = await generateCaptions({
      ideaId: ideaId || null,
      topic: topic || null,
      category: category || null,
      count: parseInt(count, 10) || CAPTIONS_PER_BATCH,
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
  const category = req.query.category;
  const subcategory = req.query.subcategory;
  if (subcategory && !isValidSubcategory(category, subcategory)) {
    return res.status(400).json({ error: "Invalid subcategory for this category" });
  }
  // Standalone (free-text topic, or subcategory-batch) captions.
  const conditions = ["idea_id IS NULL"];
  const params = [];
  if (req.query.favorited === "1") conditions.push("favorited = 1");
  if (category) {
    conditions.push("category = ?");
    params.push(category);
  }
  if (subcategory) {
    conditions.push("subcategory = ?");
    params.push(subcategory);
  }
  const rows = db
    .prepare(`SELECT * FROM captions WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT 100`)
    .all(...params);
  res.json(rows);
});

app.post("/api/captions/:id/favorite", (req, res) => {
  const favorited = req.body?.favorited ? 1 : 0;
  db.prepare(`UPDATE captions SET favorited = ? WHERE id = ?`).run(favorited, req.params.id);
  res.json({ ok: true });
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

app.post("/api/song-release-plans/:id/generate-more", async (req, res) => {
  try {
    const count = parseInt(req.body?.count, 10) || 3;
    const n = await generateMoreSongIdeas(req.params.id, count);
    res.json({ ok: true, generated: n });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete("/api/song-release-plans/:id", (req, res) => {
  db.prepare(`DELETE FROM song_release_plans WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, hasApiKey: !!ANTHROPIC_API_KEY, cron: CRON_SCHEDULE, cronTimezone: CRON_TIMEZONE, categories: CATEGORIES });
});

app.get("/api/debug/last-search", (req, res) => {
  res.json(searchDebugLog);
});

if (ANTHROPIC_API_KEY) {
  cron.schedule(
    CRON_SCHEDULE,
    () => {
      for (const category of CATEGORIES) {
        generateIdeas(category).catch((e) => console.error(`Cron generation failed for ${category}:`, e.message));
        const subcats = SUBCATEGORIES[category];
        if (subcats) {
          for (const subcategory of Object.keys(subcats)) {
            generateSubcategoryCaptions(category, subcategory).catch((e) =>
              console.error(`Cron caption generation failed for ${category}/${subcategory}:`, e.message)
            );
          }
        }
      }
    },
    { timezone: CRON_TIMEZONE }
  );
  console.log(`Cron set up: generates ${IDEAS_PER_BATCH} ideas per category (${CATEGORIES.join(", ")}), plus ${CAPTIONS_PER_BATCH} captions per Kygo subcategory, on schedule "${CRON_SCHEDULE}" (${CRON_TIMEZONE})`);
} else {
  console.warn("ANTHROPIC_API_KEY is missing - automatic generation is off. Set it in .env.");
}

app.listen(PORT, () => {
  console.log(`Daily Content Ideas running on http://localhost:${PORT}`);
});
