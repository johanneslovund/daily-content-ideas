// Weekly email digest. Summarizes what the Lead Finder / Konkurranse / Event
// automations actually added over the past 7 days, using the private repo's own
// commit history as the source of truth (each automation commits with a
// recognizable "Add lead:" / "Add competitor:" / "Add event:" message) rather than
// requiring the data files themselves to track when something was added.

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const lib = require("./lib");

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const DIGEST_FROM = process.env.DIGEST_FROM_EMAIL || "onboarding@resend.dev";
const DIGEST_TO = (process.env.DIGEST_TO_EMAILS || "jl@palmtreeprod.com,ms@palmtreeprod.com")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SITE_URL = "https://ptp-internal.pages.dev";
// The site's own pages have no per-row anchors or URL-param search, so these are
// page-level deep-links (right tool instead of the homepage) rather than
// jumping straight to a specific row - that would need changes to the site's own
// templates, out of scope for the digest script itself.
const LEAD_FINDER_URL = `${SITE_URL}/${encodeURIComponent("Palm Tree Lead Finder.html")}`;
const PIPELINE_URL = `${SITE_URL}/${encodeURIComponent("Palm Tree Pipeline.html")}`;
const KONKURRANSE_URL = `${SITE_URL}/${encodeURIComponent("Palm Tree Konkurranse.html")}`;
const EVENT_URL = `${SITE_URL}/${encodeURIComponent("Palm Tree Event.html")}`;
const FOLLOWUP_SCORE_THRESHOLD = Number(process.env.LEAD_FOLLOWUP_SCORE_THRESHOLD || 80);
const FOLLOWUP_STALE_DAYS = Number(process.env.LEAD_FOLLOWUP_STALE_DAYS || 14);
const FOLLOWUP_MAX_ITEMS = 5;
const ACTIVE_PIPELINE_STAGES = new Set(["kontaktet", "mote"]);

// Meta (Instagram + Facebook) social media report. META_PAGE_ACCESS_TOKEN is a
// non-expiring Page token generated via the "Palm Tree SoMe Manager" Meta app -
// see functions/api/some-snapshots.js in the private site repo for where weekly
// follower snapshots get stored so growth can be charted over time.
const META_PAGE_ACCESS_TOKEN = process.env.META_PAGE_ACCESS_TOKEN;
const META_PAGE_ID = "480020255390204";
const META_IG_ID = "17841413442620055";
const META_GRAPH_VERSION = "v26.0";

// Gmail read-only access for jl@palmtreeprod.com, via a Google Cloud OAuth
// Desktop-app client ("PTP Internal Digest") + a stored refresh token. Used to flag
// inbox threads that genuinely need a reply this week - see getImportantEmailThreads.
const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;
const GMAIL_ACCOUNT = "jl@palmtreeprod.com";
const EMAIL_THREAD_MAX_ITEMS = 5;

function loadLeadsData() {
  const p = path.join(lib.WORK_DIR, "source-data", "palmtree-leads-data.json");
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function loadEventsData() {
  const p = path.join(lib.WORK_DIR, "source-data", "events-data.json");
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// Trims a longer real description down to one short line for a synopsis - prefers
// the first sentence, falls back to a hard character cut with an ellipsis. Never
// invents text; returns null if there's nothing to summarize.
function shortSynopsis(text, maxLen = 110) {
  if (!text) return null;
  const firstSentence = text.match(/^[^.!?]*[.!?]/)?.[0]?.trim();
  const candidate = firstSentence && firstSentence.length <= maxLen ? firstSentence : text;
  return candidate.length > maxLen ? `${candidate.slice(0, maxLen - 1).trim()}…` : candidate;
}

function getLeadSynopsis(commitMsg, leadsByOrgnr) {
  const orgnrMatch = commitMsg.match(/\((\d+)\)\s*$/);
  const lead = orgnrMatch ? leadsByOrgnr.get(orgnrMatch[1]) : null;
  return shortSynopsis(lead?.begrunnelse);
}

function eventNameFromCommit(commitMsg) {
  return commitMsg.replace(/^Add event:\s*/, "").replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function getEventSynopsis(commitMsg, eventsByName) {
  const event = eventsByName.get(eventNameFromCommit(commitMsg));
  return shortSynopsis(event?.beskrivelse);
}

function getEventUrl(commitMsg, eventsByName) {
  return eventsByName.get(eventNameFromCommit(commitMsg))?.url || null;
}

// Filters out events that have already concluded by the time the digest sends -
// a newly-discovered event isn't relevant in a forward-looking newsletter once
// it's over. Fails open (keeps the event) if we can't find its data or a date,
// rather than silently dropping something we can't actually verify is past.
function isEventUpcoming(commitMsg, eventsByName) {
  const event = eventsByName.get(eventNameFromCommit(commitMsg));
  const endStr = event?.sluttDato || event?.startDato;
  if (!endStr) return true;
  const end = new Date(endStr);
  if (Number.isNaN(end.getTime())) return true;
  const todayStart = new Date(new Date().toDateString());
  return end >= todayStart;
}

// The Konkurranse automation already stores a real website URL per competitor, but
// only inline in the public Konkurranse page's HTML (no separate JSON sidecar like
// leads/events have) - this pulls it back out for the digest rather than
// duplicating storage.
function getCompetitorUrl(commitMsg) {
  const name = commitMsg.replace(/^Add competitor:\s*/, "").replace(/\s*\([^)]*\)\s*$/, "").trim();
  try {
    const htmlPath = path.join(lib.WORK_DIR, "public", "Palm Tree Konkurranse.html");
    if (!fs.existsSync(htmlPath)) return null;
    const html = fs.readFileSync(htmlPath, "utf8");
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rowMatch = html.match(new RegExp(`<tr>[\\s\\S]*?company-name">${escapedName}<[\\s\\S]*?</tr>`));
    if (!rowMatch) return null;
    const urlMatch = rowMatch[0].match(/link-chip"\s+href="([^"]+)"/);
    return urlMatch ? urlMatch[1] : null;
  } catch (e) {
    return null;
  }
}

// The whole site (including these GET endpoints) sits behind site-wide Basic Auth
// via functions/_middleware.js. SITE_BASIC_AUTH is a dedicated "digest-bot:<password>"
// credential added to Cloudflare's SITE_CREDENTIALS just for this script, so it can
// read Pipeline/Archive state without holding a real personal login.
function authHeaders() {
  const cred = process.env.SITE_BASIC_AUTH;
  if (!cred) return {};
  return { Authorization: `Basic ${Buffer.from(cred).toString("base64")}` };
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) {
      lib.log("digest", `${url} responded ${res.status}, skipping.`);
      return null;
    }
    return await res.json();
  } catch (e) {
    lib.log("digest", `Failed to fetch ${url}: ${e.message}`);
    return null;
  }
}

function daysSince(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86400000);
}

// Same trend-awareness pattern used for daily caption generation (see server.js) -
// grounded in a real web search, with a hard rule against tying anything to a
// sensitive event. Purely enrichment: if this fails for any reason, the digest
// still sends without a trends section rather than blocking the whole send.
async function getTrendIdeas() {
  const prompt = `Search the web for what's genuinely going viral RIGHT NOW across Instagram Reels, TikTok, and YouTube Shorts - trending sounds, formats, memes, challenges, or editing styles. From what you find, pick the 3 most relevant ones that Palm Tree Productions (a high-end video/photo production company in Ålesund, Norway, serving brands, businesses, and artists) could realistically and tastefully adapt for their own or a client's social media.

HARD RULE: never tie a suggestion to anything sensitive - a death, tragedy, disaster, injury, illness, or controversy, celebrity or otherwise. If a trend you found is sensitive in nature, skip it and find a different one. If fewer than 3 genuinely safe, relevant trends exist right now, return fewer - do not pad with a weak or forced idea.

Respond in Norwegian (Bokmål). Respond with ONLY valid JSON, a list of objects with exactly these fields:
[
  {
    "trend": "Short name of the trend/format/sound (max 8 words)",
    "idea": "1-2 sentences: concretely how PTP could adapt this for a client or their own channel"
  }
]
Do not include anything other than the JSON array itself - no markdown fences, no explanation.`;

  try {
    const text = await lib.askClaudeWithSearch(prompt, 1500, 6);
    const trends = lib.parseJson(text);
    if (!Array.isArray(trends)) throw new Error("Expected a JSON array.");
    return trends.slice(0, 3).filter((t) => t && t.trend && t.idea);
  } catch (e) {
    lib.log("digest", `Trend ideas skipped (${e.message}).`);
    return [];
  }
}

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

async function fetchMetaJson(url) {
  try {
    const res = await fetch(url);
    const body = await res.json();
    if (!res.ok) {
      lib.log("digest", `Meta API error: ${JSON.stringify(body.error || body)}`);
      return null;
    }
    return body;
  } catch (e) {
    lib.log("digest", `Meta API fetch failed: ${e.message}`);
    return null;
  }
}

// Real account-level activity totals for an arbitrary window (max 30-day span, a
// hard Instagram API limit) - this is the metric that actually answers "how much
// activity did the account get in this period," unlike summing per-post lifetime
// stats for posts published in the window, which reads as zero in any week with no
// new posts even though the account is still getting real reach/likes on older
// content. That mismatch is exactly what looked like a bug before this fix.
async function getIgAccountInsights(sinceEpoch, untilEpoch) {
  const base = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
  const metrics = "reach,likes,comments,shares,saves,total_interactions,accounts_engaged,profile_views";
  const body = await fetchMetaJson(
    `${base}/${META_IG_ID}/insights?metric=${metrics}&metric_type=total_value&period=day&since=${sinceEpoch}&until=${untilEpoch}&access_token=${META_PAGE_ACCESS_TOKEN}`
  );
  const byName = Object.fromEntries((body?.data || []).map((m) => [m.name, m.total_value?.value ?? 0]));
  return {
    reach: byName.reach || 0,
    likes: byName.likes || 0,
    comments: byName.comments || 0,
    shares: byName.shares || 0,
    saved: byName.saves || 0,
    totalInteractions: byName.total_interactions || 0,
    accountsEngaged: byName.accounts_engaged || 0,
    profileViews: byName.profile_views || 0,
  };
}

// Warns BEFORE the SoMe section silently stops appearing one week, rather than
// leaving that failure mode indistinguishable from "a genuinely quiet week." Meta
// Page tokens themselves don't expire, but the data_access grant does (~90 days
// from last real use) and needs re-authorizing via Graph API Explorer when it's
// getting close.
async function checkMetaTokenHealth() {
  if (!META_PAGE_ACCESS_TOKEN) return null;
  const base = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
  const body = await fetchMetaJson(
    `${base}/debug_token?input_token=${META_PAGE_ACCESS_TOKEN}&access_token=${META_PAGE_ACCESS_TOKEN}`
  );
  const data = body?.data;
  if (!data) return { ok: false, reason: "Kunne ikke sjekke Meta-tilgangens status." };
  if (!data.is_valid) return { ok: false, reason: "Meta-tokenet er ikke lenger gyldig." };
  if (data.data_access_expires_at) {
    const daysLeft = Math.floor((data.data_access_expires_at * 1000 - Date.now()) / 86400000);
    if (daysLeft <= 14) {
      return { ok: false, reason: `Datatilgangen for Instagram/Facebook utløper om ${daysLeft} dager.`, daysLeft };
    }
  }
  return { ok: true };
}

// Pulls real account-level activity (this week, prior week for a week-over-week
// arrow, this month) plus post counts and current follower counts from Instagram +
// Facebook via the Meta Graph API. Returns null (section skipped entirely, digest
// still sends) if the token is missing or both platforms fail - this is enrichment,
// not something that should ever block the weekly send.
//
// Year-over-year for these activity metrics isn't available in one call - Instagram
// caps any single insights query at a 30-day span - so it's intentionally omitted
// here rather than faked. Follower count comparisons (a point-in-time value, not a
// windowed total) aren't affected by that cap and still get a real year comparison
// once enough weekly snapshots exist.
async function getSocialMediaReport() {
  if (!META_PAGE_ACCESS_TOKEN) {
    lib.log("digest", "META_PAGE_ACCESS_TOKEN not set - skipping SoMe report.");
    return null;
  }

  const base = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
  const now = Math.floor(Date.now() / 1000);
  const day = 86400;
  const weekAgoMs = Date.now() - 7 * 86400000;

  const [igAccount, igMedia, fbPage, fbPosts, igWeek, igPriorWeek, igMonth] = await Promise.all([
    fetchMetaJson(`${base}/${META_IG_ID}?fields=username,followers_count,media_count&access_token=${META_PAGE_ACCESS_TOKEN}`),
    fetchMetaJson(
      `${base}/${META_IG_ID}/media?fields=id,timestamp,caption,media_type,like_count,comments_count&limit=25&access_token=${META_PAGE_ACCESS_TOKEN}`
    ),
    fetchMetaJson(`${base}/${META_PAGE_ID}?fields=fan_count&access_token=${META_PAGE_ACCESS_TOKEN}`),
    fetchMetaJson(
      `${base}/${META_PAGE_ID}/posts?fields=id,created_time,likes.summary(true).limit(0),comments.summary(true).limit(0)&limit=25&access_token=${META_PAGE_ACCESS_TOKEN}`
    ),
    getIgAccountInsights(now - 7 * day, now),
    getIgAccountInsights(now - 14 * day, now - 7 * day),
    getIgAccountInsights(now - 30 * day, now),
  ]);

  if (!igAccount && !fbPage) return null;

  const monthAgoMs = Date.now() - 30 * 86400000;
  const igRecent = (igMedia?.data || []).filter((m) => new Date(m.timestamp).getTime() >= weekAgoMs);
  const igRecentMonth = (igMedia?.data || []).filter((m) => new Date(m.timestamp).getTime() >= monthAgoMs);
  const fbRecent = (fbPosts?.data || []).filter((p) => new Date(p.created_time).getTime() >= weekAgoMs);

  const instagramPosts = igRecent.map((m) => ({
    caption: (m.caption || "").slice(0, 140),
    mediaType: m.media_type || "UKJENT",
    likes: m.like_count || 0,
    comments: m.comments_count || 0,
  }));

  const instagram = igAccount
    ? {
        username: igAccount.username || null,
        followers: igAccount.followers_count ?? null,
        postsThisWeek: igRecent.length,
        postsThisMonth: igRecentMonth.length,
        week: igWeek,
        priorWeek: igPriorWeek,
        month: igMonth,
      }
    : null;

  const facebook = fbPage
    ? {
        followers: fbPage.fan_count ?? null,
        postsThisWeek: fbRecent.length,
        likesThisWeek: fbRecent.reduce((sum, p) => sum + (p.likes?.summary?.total_count || 0), 0),
        commentsThisWeek: fbRecent.reduce((sum, p) => sum + (p.comments?.summary?.total_count || 0), 0),
      }
    : null;

  return { instagram, facebook, instagramPosts };
}

// Short, grounded qualitative writeup (what worked / what didn't / one actionable
// tip) generated from THIS week's real per-post numbers - no web search, no
// invented figures. If Claude fails to produce a usable response, the section is
// simply omitted rather than blocking the digest.
async function getInstagramAnalysis(report) {
  if (!report?.instagram) return null;
  const ig = report.instagram;
  const posts = report.instagramPosts || [];

  const postsList = posts.length
    ? posts.map((p, i) => `${i + 1}. "${p.caption || "(ingen tekst)"}" (${p.mediaType}): ${p.likes} liker, ${p.comments} kommentarer`).join("\n")
    : "Ingen innlegg ble publisert denne uken.";

  const prompt = `Du er en sosiale medier-analytiker for Palm Tree Productions (PTP), et videoproduksjonsselskap i Ålesund som lager innhold for merkevarer, bedrifter og artister (bl.a. Kygo).

Instagram-tall for kontoen @${ig.username} denne uken (hele kontoens aktivitet, ikke bare nye innlegg):
- Følgere: ${ig.followers}
- Nye innlegg publisert: ${ig.postsThisWeek}
- Rekkevidde: ${ig.week.reach} (uken før: ${ig.priorWeek.reach})
- Liker: ${ig.week.likes} (uken før: ${ig.priorWeek.likes}), kommentarer: ${ig.week.comments} (uken før: ${ig.priorWeek.comments})
- Lagringer: ${ig.week.saved}, delinger: ${ig.week.shares}, profilbesøk: ${ig.week.profileViews}

Innlegg publisert denne uken (hvis noen):
${postsList}

Skriv en KORT rapport i tre deler, grounded utelukkende i tallene og innleggene over.

HARD RULE: Ikke gjett eller finn på tall, innleggstyper, eller trender som ikke er nevnt over. Merk at kontoen kan ha reell rekkevidde/engasjement selv i en uke uten nye innlegg (fra eldre innhold) - bruk de tallene ærlig i "Hva funket"/"Hva funket ikke" i stedet for å anta at ingen nye innlegg betyr ingen aktivitet i det hele tatt.

Svar med KUN ren tekst i nøyaktig dette formatet, én setning per linje, ingen markdown:
Hva funket: <1 setning>
Hva funket ikke: <1 setning>
Tips: <1 konkret, gjennomførbart tips til neste uke>`;

  try {
    const response = await lib.anthropic.messages.create({
      model: lib.MODEL,
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.content.find((b) => b.type === "text")?.text?.trim();
    if (!text) return null;

    const match = {
      worked: text.match(/Hva funket:\s*(.+)/)?.[1]?.trim(),
      didntWork: text.match(/Hva funket ikke:\s*(.+)/)?.[1]?.trim(),
      tip: text.match(/Tips:\s*(.+)/)?.[1]?.trim(),
    };
    if (!match.worked || !match.didntWork || !match.tip) return null;
    return match;
  } catch (e) {
    lib.log("digest", `Instagram analysis skipped (${e.message}).`);
    return null;
  }
}

// One access token per run - the refresh token itself doesn't expire on its own
// (unlike the short-lived access token it produces), so this is the only round-trip
// needed to get read access to jl@palmtreeprod.com's inbox each week.
async function getGmailAccessToken() {
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) return null;
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GMAIL_CLIENT_ID,
        client_secret: GMAIL_CLIENT_SECRET,
        refresh_token: GMAIL_REFRESH_TOKEN,
        grant_type: "refresh_token",
      }),
    });
    const body = await res.json();
    if (!res.ok) {
      lib.log("digest", `Gmail token refresh failed: ${JSON.stringify(body)}`);
      return null;
    }
    return body.access_token;
  } catch (e) {
    lib.log("digest", `Gmail token refresh failed: ${e.message}`);
    return null;
  }
}

// Automated/no-reply senders are excluded before anything reaches Claude - these are
// never "a thread jl needs to respond to," and cutting them here keeps the judging
// prompt small and focused on real correspondence.
const AUTOMATED_SENDER_PATTERN = /no-?reply|noreply|do-?not-?reply|notification|mailer-daemon|calendar-notification|@.*\.google\.com/i;

function gmailHeader(headers, name) {
  return (headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}

// Candidate threads: inbox activity in the last 7 days, most recent message per
// thread, excluding ones where jl himself sent the last message (he's not the one
// who owes a reply there) and obvious automated senders. Capped well before the
// Claude call to keep the judging prompt small and the run fast.
async function getGmailCandidateThreads(accessToken) {
  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(
    "in:inbox newer_than:7d -category:promotions -category:social"
  )}&maxResults=40`;
  const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  const listBody = await listRes.json();
  if (!listRes.ok) {
    lib.log("digest", `Gmail message list failed: ${JSON.stringify(listBody)}`);
    return [];
  }

  const messageIds = (listBody.messages || []).map((m) => m.id);
  const seenThreads = new Set();
  const candidates = [];

  for (const id of messageIds) {
    if (candidates.length >= 20) break;
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const msg = await res.json();
    if (!res.ok || !msg.threadId || seenThreads.has(msg.threadId)) continue;
    seenThreads.add(msg.threadId);

    const from = gmailHeader(msg.payload?.headers, "From");
    if (from.toLowerCase().includes(GMAIL_ACCOUNT) || AUTOMATED_SENDER_PATTERN.test(from)) continue;

    candidates.push({
      threadId: msg.threadId,
      subject: gmailHeader(msg.payload?.headers, "Subject") || "(uten emne)",
      from,
      date: gmailHeader(msg.payload?.headers, "Date"),
      snippet: msg.snippet || "",
      link: `https://mail.google.com/mail/u/0/#inbox/${msg.threadId}`,
    });
  }

  return candidates;
}

// Claude judges which of the candidate threads are actually worth flagging - most
// inbox activity in a week is routine (confirmations, FYIs, threads already
// resolved) and shouldn't show up as "needs follow-up" just because jl hasn't
// replied to it yet.
async function judgeImportantThreads(candidates) {
  if (!candidates.length) return [];

  const list = candidates
    .map((c, i) => `${i}. Fra: ${c.from}\n   Emne: ${c.subject}\n   Dato: ${c.date}\n   Utdrag: ${c.snippet}`)
    .join("\n\n");

  const prompt = `Du vurderer en liste e-posttråder i innboksen til jl@palmtreeprod.com (Johannes, Palm Tree Productions, videoproduksjonsselskap i Ålesund) fra siste 7 dager. For hver tråd er avsenderen den siste personen som skrev - jl har altså ikke svart ennå.

Trådene:
${list}

Identifiser hvilke av disse som er GENUINT viktige å svare på eller følge opp denne uken - reelle forespørsler, kunde-/samarbeidshenvendelser, tilbud, avtaler, noe som venter på et svar. Ekskluder nyhetsbrev, kvitteringer/fakturaer som ikke krever handling, automatiserte varsler, og tråder som tydelig er avsluttet eller ikke krever noe fra jl.

Svar med KUN gyldig JSON, en liste (maks 5 elementer, viktigst først):
[
  {"index": <tallet fra listen over>, "reason": "kort, konkret begrunnelse på norsk, maks 12 ord", "urgency": "høy" eller "middels"}
]
Ingen andre felt, ingen markdown, ingen forklaring utenfor JSON-en. Tom liste hvis ingen kvalifiserer.`;

  try {
    const response = await lib.anthropic.messages.create({
      model: lib.MODEL,
      max_tokens: 700,
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.content.find((b) => b.type === "text")?.text?.trim();
    if (!text) return [];
    const judged = lib.parseJson(text);
    if (!Array.isArray(judged)) return [];

    return judged
      .map((j) => {
        const candidate = candidates[j.index];
        if (!candidate) return null;
        return { ...candidate, reason: j.reason || "", urgency: j.urgency === "høy" ? "høy" : "middels" };
      })
      .filter(Boolean)
      .slice(0, EMAIL_THREAD_MAX_ITEMS);
  } catch (e) {
    lib.log("digest", `Email thread judging skipped (${e.message}).`);
    return [];
  }
}

// Returns [] (section simply omitted) whenever Gmail isn't configured or any step
// fails - this is enrichment, never something that should block the weekly send.
async function getImportantEmailThreads() {
  const accessToken = await getGmailAccessToken();
  if (!accessToken) return [];
  try {
    const candidates = await getGmailCandidateThreads(accessToken);
    return await judgeImportantThreads(candidates);
  } catch (e) {
    lib.log("digest", `Gmail check skipped (${e.message}).`);
    return [];
  }
}

// Finds the snapshot whose actual date is closest to targetDate, but only returns
// it if within toleranceDays - a snapshot from 2 months ago should never silently
// stand in for "1 month ago" just because it's the closest thing available.
function findClosestSnapshot(history, targetDate, toleranceDays) {
  let best = null;
  let bestDiffMs = Infinity;
  for (const s of history) {
    if (!s.ts) continue;
    const diffMs = Math.abs(new Date(s.ts).getTime() - targetDate.getTime());
    if (diffMs < bestDiffMs) {
      bestDiffMs = diffMs;
      best = s;
    }
  }
  return best && bestDiffMs <= toleranceDays * 86400000 ? best : null;
}

// Saves this week's snapshot (upsert-by-ISO-week, so a re-run this week overwrites
// rather than duplicates) and returns the prior week/month/year snapshots (whichever
// actually exist yet - the automation only started 2026-09-02, so month/year
// comparisons will be null until real history accumulates) plus recent history for
// the growth chart.
async function updateSnapshotsAndGetHistory(report) {
  const now = new Date();
  const week = isoWeek(now);
  const existing = (await fetchJson(`${SITE_URL}/api/some-snapshots`)) || [];
  const beforeThisWeek = existing.filter((s) => s.week !== week);

  const prior = beforeThisWeek.slice(-1)[0] || null;
  const priorMonth = findClosestSnapshot(beforeThisWeek, new Date(now.getTime() - 30 * 86400000), 5);
  const priorYear = findClosestSnapshot(beforeThisWeek, new Date(now.getTime() - 365 * 86400000), 10);

  try {
    const res = await fetch(`${SITE_URL}/api/some-snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ week, instagram: report.instagram, facebook: report.facebook }),
    });
    if (!res.ok) lib.log("digest", `Failed to save SoMe snapshot: ${res.status}`);
  } catch (e) {
    lib.log("digest", `Failed to save SoMe snapshot: ${e.message}`);
  }

  const history = [...beforeThisWeek, { week, ts: now.toISOString(), instagram: report.instagram, facebook: report.facebook }].sort((a, b) =>
    a.week.localeCompare(b.week)
  );
  return { prior, priorMonth, priorYear, history: history.slice(-60) };
}

// Renders a follower-growth line chart via QuickChart's hosted image API (no API key
// needed for this volume) and fetches it server-side so it can be embedded as base64 -
// email clients don't run JS, so a live chart isn't an option. Returns null (chart
// section omitted) with fewer than 2 data points, since a single point isn't a trend.
async function buildGrowthChartBase64(history) {
  if (history.length < 2) return null;

  const chartConfig = {
    type: "line",
    data: {
      labels: history.map((s) => s.week.replace(/^\d{4}-/, "")),
      datasets: [
        {
          label: "Instagram",
          data: history.map((s) => s.instagram?.followers ?? null),
          borderColor: "#E1306C",
          backgroundColor: "#E1306C",
          fill: false,
          tension: 0.3,
        },
        {
          label: "Facebook",
          data: history.map((s) => s.facebook?.followers ?? null),
          borderColor: "#1877F2",
          backgroundColor: "#1877F2",
          fill: false,
          tension: 0.3,
        },
      ],
    },
    options: { plugins: { legend: { position: "bottom" } }, scales: { y: { beginAtZero: false } } },
  };

  try {
    const url = `https://quickchart.io/chart?w=500&h=260&bkg=white&c=${encodeURIComponent(JSON.stringify(chartConfig))}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer()).toString("base64");
  } catch (e) {
    lib.log("digest", `Chart generation failed: ${e.message}`);
    return null;
  }
}

// Cross-references this week's new leads (and the live Pipeline/Archive state) against
// the leads data file so the digest can show a score/fylke instead of just a bare name,
// and can flag leads worth actual sales action - not just "here's what was discovered."
function buildFollowupSections(leadsData, pipeline, archive) {
  const archived = new Set(Object.keys(archive || {}).filter((orgnr) => archive[orgnr]?.archived));

  const uncontacted = leadsData
    .filter((l) => typeof l.score === "number" && l.score >= FOLLOWUP_SCORE_THRESHOLD)
    .filter((l) => !archived.has(l.orgnr))
    .filter((l) => !pipeline[l.orgnr])
    .sort((a, b) => b.score - a.score)
    .slice(0, FOLLOWUP_MAX_ITEMS);

  const stale = Object.entries(pipeline || {})
    .filter(([, entry]) => ACTIVE_PIPELINE_STAGES.has(entry.stage))
    .map(([orgnr, entry]) => ({ orgnr, entry, days: daysSince(entry.ts) }))
    .filter((x) => x.days !== null && x.days >= FOLLOWUP_STALE_DAYS)
    .sort((a, b) => b.days - a.days)
    .slice(0, FOLLOWUP_MAX_ITEMS)
    .map((x) => ({ ...x, navn: leadsData.find((l) => l.orgnr === x.orgnr)?.navn || x.orgnr }));

  return { uncontacted, stale };
}

const STAGE_LABELS = { kontaktet: "Kontaktet", mote: "Møte", tilbud: "Tilbud", vunnet: "Vunnet", tapt: "Tapt" };
// A function (not a const object) so it's safe to reference C.* regardless of
// declaration order in the file - C isn't defined until further down.
function stageColor(stage) {
  return { vunnet: C.greenLight, tapt: C.red, tilbud: "#D9B454" }[stage] || C.muted;
}

// Real stage-change activity this week (a lead got contacted, moved to a meeting,
// a bid was lost, etc.) - pipeline.js keeps a per-lead history of every stage
// transition with its own timestamp, so this isn't inferred from anything, it's
// reading the actual change log. Only shown when something genuinely happened.
function getPipelineMovements(pipeline, leadsData) {
  const weekAgo = Date.now() - 7 * 86400000;
  const movements = [];
  for (const [orgnr, entry] of Object.entries(pipeline || {})) {
    for (const h of entry.history || []) {
      if (new Date(h.ts).getTime() >= weekAgo) {
        movements.push({
          orgnr,
          navn: leadsData.find((l) => l.orgnr === orgnr)?.navn || orgnr,
          stage: h.stage,
          ts: h.ts,
          user: h.user,
        });
      }
    }
  }
  movements.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  return movements;
}

// Counts real transitions INTO "vunnet"/"tapt" within the window, from the same
// per-lead history log as getPipelineMovements - not just whatever the CURRENT
// stage happens to be, since a lead could have moved on since the win/loss.
function getWinLossTally(pipeline, days = 30) {
  const cutoff = Date.now() - days * 86400000;
  let won = 0;
  let lost = 0;
  for (const entry of Object.values(pipeline || {})) {
    for (const h of entry.history || []) {
      if (new Date(h.ts).getTime() >= cutoff) {
        if (h.stage === "vunnet") won++;
        else if (h.stage === "tapt") lost++;
      }
    }
  }
  return { won, lost, days };
}

// The highest-scoring lead currently sitting in "tilbud" (the stage right before
// a decision) - a quick pointer to the single opportunity most worth not dropping,
// rather than the full uncontacted/stale lists which are about coverage, not size.
function getTopOpportunity(pipeline, leadsData) {
  const inTilbud = Object.entries(pipeline || {})
    .filter(([, entry]) => entry.stage === "tilbud")
    .map(([orgnr]) => leadsData.find((l) => l.orgnr === orgnr))
    .filter((l) => l && typeof l.score === "number");
  if (!inTilbud.length) return null;
  return inTilbud.sort((a, b) => b.score - a.score)[0];
}

// Events happening in the next `daysAhead` days, regardless of when they were
// first discovered - a forward-looking reminder, distinct from "Nye event" (which
// is only ever about events added to tracking in the past 7 days).
function getUpcomingEventsReminder(eventsData, daysAhead = 14) {
  const todayStart = new Date(new Date().toDateString());
  const cutoff = new Date(todayStart.getTime() + daysAhead * 86400000);
  return eventsData
    .filter((e) => {
      const start = new Date(e.startDato);
      return !Number.isNaN(start.getTime()) && start >= todayStart && start <= cutoff;
    })
    .sort((a, b) => new Date(a.startDato) - new Date(b.startDato));
}

function daysUntil(dateStr) {
  const target = new Date(dateStr);
  const todayStart = new Date(new Date().toDateString());
  return Math.round((target.getTime() - todayStart.getTime()) / 86400000);
}

function getWeekCommits() {
  const log = execSync('git log --since="7 days ago" --pretty=format:"%s"', {
    cwd: lib.WORK_DIR,
    encoding: "utf8",
  });
  return log.split("\n").filter(Boolean);
}

function categorize(commits) {
  const leads = commits.filter((c) => c.startsWith("Add lead:"));
  const competitors = commits.filter((c) => c.startsWith("Add competitor:"));
  const events = commits.filter((c) => c.startsWith("Add event:"));
  return { leads, competitors, events };
}

function enrichLeadLine(commitMsg, leadsByOrgnr) {
  const name = commitMsg.replace(/^Add lead:\s*/, "");
  const orgnrMatch = commitMsg.match(/\((\d+)\)\s*$/);
  const lead = orgnrMatch ? leadsByOrgnr.get(orgnrMatch[1]) : null;
  if (!lead || typeof lead.score !== "number") return name;
  return `${name} — score ${lead.score}, ${lead.fylke || "ukjent fylke"}`;
}

function followerDelta(current, prior) {
  if (prior == null || prior.followers == null) return null;
  return current.followers - prior.followers;
}

function followerDeltaText(current, prior, priorMonth, priorYear) {
  const parts = [`${current.followers} følgere`];
  const week = followerDelta(current, prior);
  const month = followerDelta(current, priorMonth);
  const year = followerDelta(current, priorYear);
  const fmt = (n, label) => `${trendArrow(n).arrow} ${n > 0 ? "+" : ""}${n} ${label}`;
  if (week != null) parts.push(fmt(week, "denne uken"));
  if (month != null) parts.push(fmt(month, "siste måned"));
  if (year != null) parts.push(fmt(year, "siste år"));
  return parts.length > 1 ? `${parts[0]} (${parts.slice(1).join(", ")})` : parts[0];
}

function windowDeltaText(value, priorValue, label) {
  if (priorValue == null) return `${value} ${label}`;
  const delta = value - priorValue;
  const { arrow } = trendArrow(delta);
  const sign = delta > 0 ? "+" : "";
  return `${value} ${label} (${arrow} ${sign}${delta} fra uken før)`;
}

function fbGrowthLine(label, current, prior, priorMonth, priorYear) {
  if (current == null) return null;
  const parts = [
    followerDeltaText(current, prior, priorMonth, priorYear),
    `${current.postsThisWeek} nye innlegg`,
    `${current.likesThisWeek} liker`,
    `${current.commentsThisWeek} kommentarer`,
  ];
  return `  ${label}: ${parts.join(", ")}`;
}

// Instagram's shape differs from Facebook's - real account-level activity totals
// for this week (with a week-over-week comparison) and this month, rather than
// stats scoped only to newly-published posts. See getSocialMediaReport for why.
function igGrowthLine(current, prior, priorMonth, priorYear) {
  if (current == null) return null;
  const handle = current.username ? ` (@${current.username})` : "";
  const parts = [
    followerDeltaText(current, prior, priorMonth, priorYear),
    `${current.postsThisWeek} nye innlegg`,
    windowDeltaText(current.week.reach, current.priorWeek?.reach, "rekkevidde"),
    windowDeltaText(current.week.likes, current.priorWeek?.likes, "liker"),
    windowDeltaText(current.week.comments, current.priorWeek?.comments, "kommentarer"),
    `${current.week.saved} lagringer, ${current.week.shares} delinger, ${current.week.profileViews} profilbesøk`,
    `siste 30 dager: ${current.month.reach} rekkevidde, ${current.month.likes} liker, ${current.month.totalInteractions} interaksjoner totalt`,
  ];
  return `  Instagram${handle}: ${parts.join(", ")}`;
}

// Up to 4 short, skimmable highlights for the top of the email - the digest has
// grown into a genuinely long read, so this exists to answer "did anything urgent
// happen" in a few seconds without scrolling. Priority-ordered: real sales
// movement first, then new discoveries, then the nearest upcoming event, then
// social growth - each only included if there's real content behind it.
function buildTldrHighlights({ leadsCount, competitorsCount, upcomingEventsCount, movements, winLoss, topOpportunity, eventsReminder, someReport, emailThreads }) {
  const items = [];

  if (emailThreads && emailThreads.length) {
    items.push(`${emailThreads.length} e-post${emailThreads.length === 1 ? "" : "er"} trenger oppfølging`);
  }
  if (movements.length) {
    items.push(`${movements.length} pipeline-bevegelse${movements.length === 1 ? "" : "r"} denne uken`);
  }
  if (winLoss.won > 0 || winLoss.lost > 0) {
    items.push(`${winLoss.won} vunnet, ${winLoss.lost} tapt siste ${winLoss.days} dager`);
  }
  if (topOpportunity) {
    items.push(`Følg opp: ${topOpportunity.navn} (Tilbud-fasen)`);
  }
  const newCount = leadsCount + competitorsCount + upcomingEventsCount;
  if (newCount > 0) {
    items.push(`${newCount} nye funn: ${leadsCount} lead${leadsCount === 1 ? "" : "s"}, ${competitorsCount} konkurrent${competitorsCount === 1 ? "" : "er"}, ${upcomingEventsCount} event`);
  }
  // "Kultur & festival" events (local festivals with no stated business tie) are
  // tracked for the full events list, but not treated as urgent enough for the
  // TL;DR - the other categories (Sjømat & havbruk, Maritim industri, Lokalt
  // næringsliv, Film & kreativ bransje, Reiseliv & opplevelse) are PTP's actual
  // client/target industries, a real distinction already present in the data
  // rather than an invented relevance score.
  const relevantSoon = eventsReminder.find((e) => e.kategori && e.kategori !== "Kultur & festival");
  if (relevantSoon) {
    const days = daysUntil(relevantSoon.startDato);
    if (days <= 7) items.push(`${relevantSoon.navn} om ${days} dag${days === 1 ? "" : "er"}`);
  }
  const ig = someReport?.report?.instagram;
  if (ig?.week?.reach != null && ig?.priorWeek?.reach) {
    const pct = Math.round(((ig.week.reach - ig.priorWeek.reach) / ig.priorWeek.reach) * 100);
    const { arrow } = trendArrow(pct);
    items.push(`Instagram-rekkevidde ${arrow} ${pct > 0 ? "+" : ""}${pct}% fra uken før`);
  }

  return items.slice(0, 4);
}

function buildDigestText({ leads, competitors, events }, leadsByOrgnr, eventsByName, followup, trends, someReport, weekRange, movements, winLoss, topOpportunity, eventsReminder, tokenHealth, emailThreads = []) {
  const upcomingEvents = events.filter((c) => isEventUpcoming(c, eventsByName));
  const total = leads.length + competitors.length + upcomingEvents.length;
  const lines = [];
  lines.push(`PTP Internal - ukentlig oppsummering (${weekRange})`);
  lines.push(``);

  const highlights = buildTldrHighlights({
    leadsCount: leads.length,
    competitorsCount: competitors.length,
    upcomingEventsCount: upcomingEvents.length,
    movements,
    winLoss,
    topOpportunity,
    eventsReminder,
    someReport,
    emailThreads,
  });
  if (highlights.length) {
    lines.push(`Kort oppsummert:`);
    highlights.forEach((h) => lines.push(`  - ${h}`));
    lines.push(``);
  }

  if (tokenHealth && !tokenHealth.ok) {
    lines.push(`⚠ ${tokenHealth.reason}`);
    lines.push(``);
  }

  if (emailThreads.length) {
    lines.push(`E-post som trenger oppfølging (${emailThreads.length}):`);
    emailThreads.forEach((t) => lines.push(`  - [${t.urgency}] ${t.subject} — fra ${t.from} — ${t.reason} — ${t.link}`));
    lines.push(``);
  }

  if (movements.length) {
    lines.push(`Pipeline-bevegelse denne uken (${movements.length}) — ${PIPELINE_URL}:`);
    movements.forEach((m) => lines.push(`  - ${m.navn} → ${STAGE_LABELS[m.stage] || m.stage} (${formatDateNo(new Date(m.ts))}${m.user ? `, ${m.user}` : ""})`));
    lines.push(``);
  }

  if (winLoss.won > 0 || winLoss.lost > 0) {
    lines.push(`Vunnet/tapt siste ${winLoss.days} dager: ${winLoss.won} vunnet, ${winLoss.lost} tapt`);
    lines.push(``);
  }

  if (topOpportunity) {
    lines.push(`Størst mulighet akkurat nå: ${topOpportunity.navn} — score ${topOpportunity.score}, i "Tilbud"-fasen (${PIPELINE_URL})`);
    lines.push(``);
  }

  if (someReport) {
    lines.push(`Sosiale medier denne uken:`);
    const igLine = igGrowthLine(someReport.report.instagram, someReport.prior?.instagram, someReport.priorMonth?.instagram, someReport.priorYear?.instagram);
    const fbLine = fbGrowthLine("Facebook - PTP (7 dager)", someReport.report.facebook, someReport.prior?.facebook, someReport.priorMonth?.facebook, someReport.priorYear?.facebook);
    if (igLine) lines.push(igLine);
    if (fbLine) lines.push(fbLine);
    lines.push(``);

    if (someReport.analysis) {
      lines.push(`Instagram-rapport:`);
      lines.push(`  Hva funket: ${someReport.analysis.worked}`);
      lines.push(`  Hva funket ikke: ${someReport.analysis.didntWork}`);
      lines.push(`  Tips: ${someReport.analysis.tip}`);
      lines.push(``);
    }
  }

  if (trends.length) {
    lines.push(`Aktuelle SoMe-trender å vurdere (${trends.length}):`);
    trends.forEach((t) => lines.push(`  - ${t.trend}: ${t.idea}`));
    lines.push(``);
  }

  if (followup.uncontacted.length) {
    lines.push(`Leads å følge opp - høy score, ikke kontaktet ennå (${followup.uncontacted.length}) — ${LEAD_FINDER_URL}:`);
    followup.uncontacted.forEach((l) => lines.push(`  - ${l.navn} — score ${l.score}, ${l.fylke || "ukjent fylke"}`));
    lines.push(``);
  }

  if (followup.stale.length) {
    lines.push(`Leads som har stått stille i ${FOLLOWUP_STALE_DAYS}+ dager (${followup.stale.length}) — ${PIPELINE_URL}:`);
    followup.stale.forEach((l) => lines.push(`  - ${l.navn} — "${l.entry.stage}" i ${l.days} dager`));
    lines.push(``);
  }

  if (total === 0) {
    lines.push(`Ingen nye funn denne uken. Automasjonen fant ingenting som var verifiserbart og relevant nok til å legge til - det er en normal og forventet uke, ikke en feil.`);
  } else {
    if (leads.length) {
      lines.push(`Nye leads (${leads.length}) — ${LEAD_FINDER_URL}:`);
      leads.forEach((c) => {
        lines.push(`  - ${enrichLeadLine(c, leadsByOrgnr)}`);
        const synopsis = getLeadSynopsis(c, leadsByOrgnr);
        if (synopsis) lines.push(`    ${synopsis}`);
      });
      lines.push(``);
    }
    if (competitors.length) {
      lines.push(`Nye konkurrenter (${competitors.length}) — ${KONKURRANSE_URL}:`);
      competitors.forEach((c) => {
        const url = getCompetitorUrl(c);
        lines.push(`  - ${c.replace(/^Add competitor:\s*/, "")}${url ? ` — ${url}` : ""}`);
      });
      lines.push(``);
    }
    if (upcomingEvents.length) {
      lines.push(`Nye event (${upcomingEvents.length}) — ${EVENT_URL}:`);
      upcomingEvents.forEach((c) => {
        const url = getEventUrl(c, eventsByName);
        lines.push(`  - ${c.replace(/^Add event:\s*/, "")}${url ? ` — ${url}` : ""}`);
        const synopsis = getEventSynopsis(c, eventsByName);
        if (synopsis) lines.push(`    ${synopsis}`);
      });
      lines.push(``);
    }
  }

  if (eventsReminder.length) {
    lines.push(`Kommende event (neste 14 dager) — ${EVENT_URL}:`);
    eventsReminder.forEach((e) => {
      const days = daysUntil(e.startDato);
      lines.push(`  - ${e.navn} — ${formatDateNo(new Date(e.startDato))} (om ${days} dag${days === 1 ? "" : "er"})${e.url ? ` — ${e.url}` : ""}`);
      const synopsis = shortSynopsis(e.beskrivelse);
      if (synopsis) lines.push(`    ${synopsis}`);
    });
    lines.push(``);
  }

  lines.push(``);
  lines.push(SITE_URL);
  return lines.join("\n");
}

// Embedded as base64 rather than a hosted URL: the site sits behind Basic Auth, so
// email clients (which fetch remote images anonymously) couldn't load it from there
// without opening a new public exception for a page that's otherwise fully gated.
// The white/light variant of the logo, since the email is dark mode.
const LOGO_BASE64 = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, "assets", "ptp-logo-white.png")).toString("base64");
  } catch (e) {
    return null;
  }
})();

// Resized/compressed copy of assets/Header.jpg (originally 1640x614, ~240KB) down
// to 900px wide at quality 68 (~43KB) - keeps the combined email size reasonable
// once base64-encoded alongside the logo.
const HEADER_BG_BASE64 = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, "assets", "header-bg.jpg")).toString("base64");
  } catch (e) {
    return null;
  }
})();

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Dark-mode palette matching the site's own design system (see CLAUDE.md): body
// #14171A, card #1B1F23, borders #2A2F35, heading text #F2F3F1, body text #E7E9EA,
// muted #9AA0A6, accent green #3FA873/#4FBD84, negative red #E58C74.
const C = {
  bg: "#14171A",
  card: "#1B1F23",
  border: "#2A2F35",
  heading: "#F2F3F1",
  body: "#E7E9EA",
  muted: "#9AA0A6",
  dim: "#7C8388",
  green: "#3FA873",
  greenLight: "#4FBD84",
  red: "#E58C74",
};

// Table-based layout with inline styles throughout - required for consistent
// rendering across email clients (Gmail/Outlook strip <style> blocks and much of
// modern CSS).
function htmlSection(title, innerHtml, linkUrl) {
  const heading = linkUrl
    ? `<a href="${escapeHtml(linkUrl)}" style="color:${C.heading};text-decoration:none;">${escapeHtml(title)} <span style="color:${C.greenLight};font-weight:400;">↗</span></a>`
    : escapeHtml(title);
  return `
  <tr><td style="padding:28px 32px 8px;">
    <h2 style="margin:0 0 12px;font:600 15px -apple-system,'Segoe UI',sans-serif;color:${C.heading};">${heading}</h2>
    ${innerHtml}
  </td></tr>`;
}

function htmlLeadCard(name, badgeText, badgeColor, sub) {
  return `
    <div style="padding:10px 14px;border:1px solid ${C.border};border-radius:8px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;">
      <div>
        <div style="font:600 14px -apple-system,'Segoe UI',sans-serif;color:${C.heading};">${escapeHtml(name)}</div>
        ${sub ? `<div style="font:13px -apple-system,'Segoe UI',sans-serif;color:${C.muted};margin-top:2px;">${escapeHtml(sub)}</div>` : ""}
      </div>
      <span style="font:600 12px -apple-system,'Segoe UI',sans-serif;color:${badgeColor};background:${badgeColor}26;padding:4px 10px;border-radius:999px;white-space:nowrap;">${escapeHtml(badgeText)}</span>
    </div>`;
}

// Green up-arrow for growth, gray right-arrow for no change, red down-arrow for
// decline - matching the reference performance-report style the user shared.
function trendArrow(delta) {
  if (delta > 0) return { arrow: "↗", color: C.greenLight };
  if (delta < 0) return { arrow: "↘", color: C.red };
  return { arrow: "→", color: C.muted };
}

function deltaSpan(delta, periodLabel) {
  if (delta == null) return "";
  const sign = delta > 0 ? "+" : "";
  const { arrow, color } = trendArrow(delta);
  return `<div style="font:600 12px -apple-system,'Segoe UI',sans-serif;color:${color};">${arrow} ${sign}${delta} ${periodLabel}</div>`;
}

function followerDeltaHtml(current, prior, priorMonth, priorYear) {
  return [
    deltaSpan(followerDelta(current, prior), "denne uken"),
    deltaSpan(followerDelta(current, priorMonth), "siste måned"),
    deltaSpan(followerDelta(current, priorYear), "siste år"),
  ].join("");
}

// A metric-block grid mirroring the "Instagram/Facebook Performance Summary" style:
// platform name as a heading, then a 3-per-row table of label/big-number/delta
// blocks. Table-based (not CSS grid) since that's what email clients reliably render.
function htmlMetricGrid(platformLabel, items) {
  const cells = items
    .map(
      (item) => `
      <td width="33%" valign="top" style="padding:12px 10px;border:1px solid ${C.border};">
        <div style="font:12px -apple-system,'Segoe UI',sans-serif;color:${C.muted};text-transform:uppercase;letter-spacing:0.02em;margin-bottom:4px;">${escapeHtml(item.label)}</div>
        <div style="font:700 20px -apple-system,'Segoe UI',sans-serif;color:${C.heading};">${escapeHtml(item.value)}</div>
        ${item.deltaHtml ? `<div style="margin-top:2px;">${item.deltaHtml}</div>` : ""}
      </td>`
    );

  const rows = [];
  for (let i = 0; i < cells.length; i += 3) {
    const rowCells = cells.slice(i, i + 3);
    while (rowCells.length < 3) rowCells.push(`<td width="33%" style="border:1px solid ${C.border};"></td>`);
    rows.push(`<tr>${rowCells.join("")}</tr>`);
  }

  return `
    <div style="font:600 14px -apple-system,'Segoe UI',sans-serif;color:${C.heading};margin:16px 0 8px;">${escapeHtml(platformLabel)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      ${rows.join("")}
    </table>`;
}

function htmlStatCard(label, current, prior, priorMonth, priorYear) {
  if (current == null) return "";
  const items = [
    { label: "Følgere", value: String(current.followers), deltaHtml: followerDeltaHtml(current, prior, priorMonth, priorYear) },
    { label: "Publiserte innlegg", value: String(current.postsThisWeek) },
    { label: "Liker", value: String(current.likesThisWeek) },
    { label: "Kommentarer", value: String(current.commentsThisWeek) },
  ];
  return htmlMetricGrid(label, items);
}

function windowDeltaHtml(value, priorValue) {
  if (priorValue == null) return "";
  const delta = value - priorValue;
  const { arrow, color } = trendArrow(delta);
  const sign = delta > 0 ? "+" : "";
  return `<div style="font:600 12px -apple-system,'Segoe UI',sans-serif;color:${color};">${arrow} ${sign}${delta} fra uken før</div>`;
}

// The 30-day figure for each metric shown as a small reference line under the
// weekly number - a neutral arrow (this isn't a growth comparison, just a wider
// window for context) rather than the colored trend arrows used for real deltas.
function monthSubline(monthValue) {
  return `<div style="font:11px -apple-system,'Segoe UI',sans-serif;color:${C.muted};margin-top:2px;">→ ${monthValue} siste 30 dager</div>`;
}

// One merged grid per metric - the weekly number (with a week-over-week arrow where
// a prior-week figure exists) and the 30-day figure stacked underneath, rather than
// two separate grids repeating the same metric labels.
function htmlInstagramStatCard(current, prior, priorMonth, priorYear) {
  if (current == null) return "";
  const handle = current.username ? ` (@${escapeHtml(current.username)})` : "";

  const items = [
    { label: "Følgere", value: String(current.followers), deltaHtml: followerDeltaHtml(current, prior, priorMonth, priorYear) },
    {
      label: "Nye innlegg",
      value: String(current.postsThisWeek),
      deltaHtml: current.postsThisMonth != null ? monthSubline(current.postsThisMonth) : "",
    },
    {
      label: "Rekkevidde",
      value: String(current.week.reach),
      deltaHtml: windowDeltaHtml(current.week.reach, current.priorWeek?.reach) + monthSubline(current.month.reach),
    },
    {
      label: "Liker",
      value: String(current.week.likes),
      deltaHtml: windowDeltaHtml(current.week.likes, current.priorWeek?.likes) + monthSubline(current.month.likes),
    },
    {
      label: "Kommentarer",
      value: String(current.week.comments),
      deltaHtml: windowDeltaHtml(current.week.comments, current.priorWeek?.comments) + monthSubline(current.month.comments),
    },
    { label: "Total interaksjon", value: String(current.week.totalInteractions), deltaHtml: monthSubline(current.month.totalInteractions) },
    { label: "Lagringer", value: String(current.week.saved), deltaHtml: monthSubline(current.month.saved) },
    { label: "Delinger", value: String(current.week.shares), deltaHtml: monthSubline(current.month.shares) },
    { label: "Profilbesøk", value: String(current.week.profileViews) },
  ];

  return htmlMetricGrid(`Instagram${handle}`, items);
}

// A highlighted box, visually distinct from the regular sections, so it reads as
// "read this first" rather than just another item in the list.
function htmlTldrBox(highlights) {
  if (!highlights.length) return "";
  return `
  <tr><td style="padding:24px 32px 4px;">
    <div style="border:1px solid ${C.green};border-radius:8px;padding:16px 18px;background:rgba(63,168,115,0.08);">
      <div style="font:600 12px -apple-system,'Segoe UI',sans-serif;color:${C.greenLight};text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px;">Kort oppsummert</div>
      ${highlights.map((h) => `<div style="font:13px -apple-system,'Segoe UI',sans-serif;color:${C.body};padding:2px 0;">• ${escapeHtml(h)}</div>`).join("")}
    </div>
  </td></tr>`;
}

function htmlWarningBox(tokenHealth) {
  if (!tokenHealth || tokenHealth.ok) return "";
  return `
  <tr><td style="padding:16px 32px 4px;">
    <div style="border:1px solid ${C.red};border-radius:8px;padding:12px 16px;background:rgba(229,140,116,0.1);font:13px -apple-system,'Segoe UI',sans-serif;color:${C.red};">
      ⚠ ${escapeHtml(tokenHealth.reason)}
    </div>
  </td></tr>`;
}

function htmlEmailThreadCard(t) {
  const badgeColor = t.urgency === "høy" ? C.red : "#D9B454";
  return `
    <div style="padding:10px 14px;border:1px solid ${C.border};border-radius:8px;margin-bottom:8px;">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <a href="${escapeHtml(t.link)}" style="font:600 14px -apple-system,'Segoe UI',sans-serif;color:${C.heading};text-decoration:none;">${escapeHtml(t.subject)}</a>
        <span style="font:600 12px -apple-system,'Segoe UI',sans-serif;color:${badgeColor};background:${badgeColor}26;padding:4px 10px;border-radius:999px;white-space:nowrap;margin-left:10px;">${escapeHtml(t.urgency)}</span>
      </div>
      <div style="font:13px -apple-system,'Segoe UI',sans-serif;color:${C.muted};margin-top:4px;">${escapeHtml(t.from)}</div>
      <div style="font:13px -apple-system,'Segoe UI',sans-serif;color:${C.body};margin-top:4px;">${escapeHtml(t.reason)}</div>
    </div>`;
}

function buildDigestHtml({ leads, competitors, events }, leadsByOrgnr, eventsByName, followup, trends, someReport, weekRange, movements, winLoss, topOpportunity, eventsReminder, tokenHealth, emailThreads = []) {
  const upcomingEvents = events.filter((c) => isEventUpcoming(c, eventsByName));
  const total = leads.length + competitors.length + upcomingEvents.length;
  let body = "";

  const highlights = buildTldrHighlights({
    leadsCount: leads.length,
    competitorsCount: competitors.length,
    upcomingEventsCount: upcomingEvents.length,
    movements,
    winLoss,
    topOpportunity,
    eventsReminder,
    someReport,
    emailThreads,
  });
  body += htmlTldrBox(highlights);
  body += htmlWarningBox(tokenHealth);

  if (emailThreads.length) {
    body += htmlSection(`E-post som trenger oppfølging (${emailThreads.length})`, emailThreads.map(htmlEmailThreadCard).join(""));
  }

  if (movements.length) {
    body += htmlSection(
      `Pipeline-bevegelse denne uken (${movements.length})`,
      movements
        .map((m) => htmlLeadCard(m.navn, STAGE_LABELS[m.stage] || m.stage, stageColor(m.stage), `${formatDateNo(new Date(m.ts))}${m.user ? ` · ${m.user}` : ""}`))
        .join(""),
      PIPELINE_URL
    );
  }

  if (winLoss.won > 0 || winLoss.lost > 0) {
    body += htmlSection(
      `Vunnet/tapt siste ${winLoss.days} dager`,
      `<div style="font:14px -apple-system,'Segoe UI',sans-serif;color:${C.body};">
        <span style="color:${C.greenLight};font-weight:700;">${winLoss.won} vunnet</span>
        <span style="color:${C.muted};"> · </span>
        <span style="color:${C.red};font-weight:700;">${winLoss.lost} tapt</span>
      </div>`
    );
  }

  if (topOpportunity) {
    body += htmlSection(
      "Størst mulighet akkurat nå",
      htmlLeadCard(topOpportunity.navn, `score ${topOpportunity.score}`, "#D9B454", "I “Tilbud”-fasen"),
      PIPELINE_URL
    );
  }

  if (someReport) {
    const chartHtml = someReport.chartBase64
      ? `<img src="data:image/png;base64,${someReport.chartBase64}" width="500" alt="Følgervekst" style="display:block;width:100%;max-width:500px;height:auto;margin-top:12px;border-radius:8px;" />`
      : "";
    body += htmlSection(
      "Sosiale medier denne uken",
      htmlInstagramStatCard(someReport.report.instagram, someReport.prior?.instagram, someReport.priorMonth?.instagram, someReport.priorYear?.instagram) +
        htmlStatCard("Facebook - PTP (7 dager)", someReport.report.facebook, someReport.prior?.facebook, someReport.priorMonth?.facebook, someReport.priorYear?.facebook) +
        chartHtml
    );

    if (someReport.analysis) {
      body += htmlSection(
        "Instagram-rapport",
        `
        <div style="font:13px/1.6 -apple-system,'Segoe UI',sans-serif;color:${C.body};">
          <div style="margin-bottom:8px;"><strong style="color:${C.greenLight};">Hva funket:</strong> ${escapeHtml(someReport.analysis.worked)}</div>
          <div style="margin-bottom:8px;"><strong style="color:${C.red};">Hva funket ikke:</strong> ${escapeHtml(someReport.analysis.didntWork)}</div>
          <div><strong style="color:${C.heading};">Tips:</strong> ${escapeHtml(someReport.analysis.tip)}</div>
        </div>`
      );
    }

  }

  // Positioned right after the SoMe report (not nested inside it) so trends still
  // show even in the rare case the Meta report itself fails to load.
  if (trends.length) {
    body += htmlSection(
      "Aktuelle SoMe-trender å vurdere",
      trends
        .map(
          (t) => `
      <div style="padding:12px 14px;border:1px solid ${C.border};border-radius:8px;margin-bottom:8px;">
        <div style="font:600 14px -apple-system,'Segoe UI',sans-serif;color:${C.greenLight};margin-bottom:4px;">${escapeHtml(t.trend)}</div>
        <div style="font:13px/1.5 -apple-system,'Segoe UI',sans-serif;color:${C.body};">${escapeHtml(t.idea)}</div>
      </div>`
        )
        .join("")
    );
  }

  if (followup.uncontacted.length) {
    body += htmlSection(
      `Leads å følge opp - ikke kontaktet ennå (${followup.uncontacted.length})`,
      followup.uncontacted
        .map((l) => htmlLeadCard(l.navn, `score ${l.score}`, C.greenLight, l.fylke || "ukjent fylke"))
        .join(""),
      LEAD_FINDER_URL
    );
  }

  if (followup.stale.length) {
    body += htmlSection(
      `Leads som har stått stille (${followup.stale.length})`,
      followup.stale
        .map((l) => htmlLeadCard(l.navn, `${l.days} dager`, "#D9B454", `"${l.entry.stage}"`))
        .join(""),
      PIPELINE_URL
    );
  }

  if (total === 0) {
    body += htmlSection(
      "Nye funn denne uken",
      `<div style="font:13px/1.5 -apple-system,'Segoe UI',sans-serif;color:${C.muted};">Ingen nye funn denne uken. Automasjonen fant ingenting som var verifiserbart og relevant nok til å legge til - det er en normal og forventet uke, ikke en feil.</div>`
    );
  } else {
    if (leads.length) {
      body += htmlSection(
        `Nye leads (${leads.length})`,
        leads
          .map((c) => {
            const synopsis = getLeadSynopsis(c, leadsByOrgnr);
            return `<div style="padding:4px 0;">
              <div style="font:13px -apple-system,'Segoe UI',sans-serif;color:${C.body};">${escapeHtml(enrichLeadLine(c, leadsByOrgnr))}</div>
              ${synopsis ? `<div style="font:12px -apple-system,'Segoe UI',sans-serif;color:${C.muted};margin-top:2px;">${escapeHtml(synopsis)}</div>` : ""}
            </div>`;
          })
          .join(""),
        LEAD_FINDER_URL
      );
    }
    if (competitors.length) {
      body += htmlSection(
        `Nye konkurrenter (${competitors.length})`,
        competitors
          .map((c) => {
            const url = getCompetitorUrl(c);
            const name = c.replace(/^Add competitor:\s*/, "");
            const nameHtml = url
              ? `<a href="${escapeHtml(url)}" style="color:${C.body};text-decoration:underline;text-decoration-color:${C.border};">${escapeHtml(name)}</a>`
              : escapeHtml(name);
            return `<div style="font:13px -apple-system,'Segoe UI',sans-serif;color:${C.body};padding:4px 0;">${nameHtml}</div>`;
          })
          .join(""),
        KONKURRANSE_URL
      );
    }
    if (upcomingEvents.length) {
      body += htmlSection(
        `Nye event (${upcomingEvents.length})`,
        upcomingEvents
          .map((c) => {
            const synopsis = getEventSynopsis(c, eventsByName);
            const url = getEventUrl(c, eventsByName);
            const name = c.replace(/^Add event:\s*/, "");
            const nameHtml = url
              ? `<a href="${escapeHtml(url)}" style="color:${C.body};text-decoration:underline;text-decoration-color:${C.border};">${escapeHtml(name)}</a>`
              : escapeHtml(name);
            return `<div style="padding:4px 0;">
              <div style="font:13px -apple-system,'Segoe UI',sans-serif;color:${C.body};">${nameHtml}</div>
              ${synopsis ? `<div style="font:12px -apple-system,'Segoe UI',sans-serif;color:${C.muted};margin-top:2px;">${escapeHtml(synopsis)}</div>` : ""}
            </div>`;
          })
          .join(""),
        EVENT_URL
      );
    }
  }

  // Moved to the very bottom, after all other sections - this is a forward-looking
  // reminder rather than a "here's what's new" item, so it doesn't belong grouped
  // with the discovery sections above it.
  if (eventsReminder.length) {
    body += htmlSection(
      "Kommende event (neste 14 dager)",
      eventsReminder
        .map((e) => {
          const days = daysUntil(e.startDato);
          const synopsis = shortSynopsis(e.beskrivelse);
          const nameHtml = e.url
            ? `<a href="${escapeHtml(e.url)}" style="color:${C.heading};text-decoration:underline;text-decoration-color:${C.border};">${escapeHtml(e.navn)}</a>`
            : escapeHtml(e.navn);
          return `
    <div style="padding:10px 14px;border:1px solid ${C.border};border-radius:8px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;">
      <div>
        <div style="font:600 14px -apple-system,'Segoe UI',sans-serif;color:${C.heading};">${nameHtml}</div>
        <div style="font:13px -apple-system,'Segoe UI',sans-serif;color:${C.muted};margin-top:2px;">${escapeHtml(formatDateNo(new Date(e.startDato)))}${synopsis ? ` · ${escapeHtml(synopsis)}` : ""}</div>
      </div>
      <span style="font:600 12px -apple-system,'Segoe UI',sans-serif;color:${C.greenLight};background:${C.greenLight}26;padding:4px 10px;border-radius:999px;white-space:nowrap;">om ${days} dag${days === 1 ? "" : "er"}</span>
    </div>`;
        })
        .join(""),
      EVENT_URL
    );
  }

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="dark" />
    <meta name="supported-color-schemes" content="dark" />
  </head>
  <body style="margin:0;padding:0;background:${C.bg};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:${C.card};border-radius:12px;overflow:hidden;max-width:600px;width:100%;">
          <tr><td${HEADER_BG_BASE64 ? ` background="data:image/jpeg;base64,${HEADER_BG_BASE64}"` : ""} style="border-bottom:3px solid ${C.green};${
    HEADER_BG_BASE64 ? `background-image:url(data:image/jpeg;base64,${HEADER_BG_BASE64});background-size:cover;background-position:center;` : ""
  }">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:rgba(11,13,15,0.7);">
              <tr><td style="padding:58px 32px 50px;">
                ${LOGO_BASE64 ? `<img src="data:image/png;base64,${LOGO_BASE64}" width="120" alt="Palm Tree Productions" style="display:block;width:120px;height:auto;margin:0 auto 14px;" />` : `<div style="font:600 12px -apple-system,'Segoe UI',sans-serif;color:${C.greenLight};letter-spacing:0.04em;text-transform:uppercase;text-align:center;">PTP Internal</div>`}
                <h1 style="margin:0;font:700 22px -apple-system,'Segoe UI',sans-serif;color:#FFFFFF;text-align:center;text-shadow:0 1px 4px rgba(0,0,0,0.6);">Ukentlig oppsummering</h1>
                <div style="margin-top:4px;font:13px -apple-system,'Segoe UI',sans-serif;color:#D7D9DA;text-align:center;">${escapeHtml(weekRange)}</div>
              </td></tr>
            </table>
          </td></tr>
          ${body}
          <tr><td style="padding:24px 32px 32px;">
            <a href="${SITE_URL}" style="display:inline-block;font:600 13px -apple-system,'Segoe UI',sans-serif;color:#0B0D0F;background:${C.greenLight};padding:10px 18px;border-radius:8px;text-decoration:none;">Åpne ptp-internal</a>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

function formatDateNo(date) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${date.getFullYear()}`;
}

function weekRangeLabel(now) {
  const start = new Date(now.getTime() - 6 * 86400000);
  return `${formatDateNo(start)} - ${formatDateNo(now)}`;
}

async function sendDigest(text, html, weekRange) {
  if (!RESEND_API_KEY) {
    lib.log("digest", "RESEND_API_KEY not set - skipping send, printing digest instead:");
    console.log(text);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: DIGEST_FROM,
      to: DIGEST_TO,
      subject: `PTP Internal - Ukentlig Oppsummering (${weekRange})`,
      text,
      html,
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Resend send failed: ${JSON.stringify(body)}`);
  }
  lib.log("digest", `Sent to ${DIGEST_TO.join(", ")} (id: ${body.id})`);
}

async function main() {
  lib.setupGitSsh();
  lib.cloneOrPullSiteRepo();

  const commits = getWeekCommits();
  const grouped = categorize(commits);

  const leadsData = loadLeadsData();
  const leadsByOrgnr = new Map(leadsData.map((l) => [l.orgnr, l]));
  const eventsData = loadEventsData();
  const eventsByName = new Map(eventsData.map((e) => [e.navn, e]));
  const [pipeline, archive] = await Promise.all([
    fetchJson(`${SITE_URL}/api/pipeline`),
    fetchJson(`${SITE_URL}/api/lead-archive`),
  ]);
  const followup = buildFollowupSections(leadsData, pipeline || {}, archive || {});
  const movements = getPipelineMovements(pipeline || {}, leadsData);
  const winLoss = getWinLossTally(pipeline || {});
  const topOpportunity = getTopOpportunity(pipeline || {}, leadsData);
  const eventsReminder = getUpcomingEventsReminder(eventsData);
  const trends = await getTrendIdeas();

  const rawReport = await getSocialMediaReport();
  let someReport = null;
  if (rawReport) {
    const { prior, priorMonth, priorYear, history } = await updateSnapshotsAndGetHistory(rawReport);
    const [chartBase64, analysis] = await Promise.all([buildGrowthChartBase64(history), getInstagramAnalysis(rawReport)]);
    someReport = { report: rawReport, prior, priorMonth, priorYear, chartBase64, analysis };
  }
  const tokenHealth = await checkMetaTokenHealth();
  const emailThreads = await getImportantEmailThreads();

  const weekRange = weekRangeLabel(new Date());

  lib.log(
    "digest",
    `Past 7 days: ${grouped.leads.length} lead(s), ${grouped.competitors.length} competitor(s), ${grouped.events.length} event(s). ` +
      `Follow-up: ${followup.uncontacted.length} uncontacted high-score, ${followup.stale.length} stale in pipeline. ` +
      `Trends: ${trends.length}. SoMe report: ${someReport ? "yes" : "skipped"}. Token health: ${tokenHealth ? (tokenHealth.ok ? "ok" : tokenHealth.reason) : "n/a"}. ` +
      `Email threads flagged: ${emailThreads.length}.`
  );

  const text = buildDigestText(grouped, leadsByOrgnr, eventsByName, followup, trends, someReport, weekRange, movements, winLoss, topOpportunity, eventsReminder, tokenHealth, emailThreads);
  const html = buildDigestHtml(grouped, leadsByOrgnr, eventsByName, followup, trends, someReport, weekRange, movements, winLoss, topOpportunity, eventsReminder, tokenHealth, emailThreads);
  await sendDigest(text, html, weekRange);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[digest] Fatal error:", e);
    process.exit(1);
  });
}

module.exports = {
  buildFollowupSections,
  buildDigestText,
  buildDigestHtml,
  enrichLeadLine,
  categorize,
  fetchJson,
  getTrendIdeas,
  getSocialMediaReport,
  getInstagramAnalysis,
  updateSnapshotsAndGetHistory,
  buildGrowthChartBase64,
  isoWeek,
  weekRangeLabel,
  loadEventsData,
  getLeadSynopsis,
  getEventSynopsis,
  getEventUrl,
  isEventUpcoming,
  getCompetitorUrl,
  getPipelineMovements,
  getWinLossTally,
  getTopOpportunity,
  getUpcomingEventsReminder,
  checkMetaTokenHealth,
  buildTldrHighlights,
  getImportantEmailThreads,
};
