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

function loadLeadsData() {
  const p = path.join(lib.WORK_DIR, "source-data", "palmtree-leads-data.json");
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf8"));
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

// Per-post Instagram insights (reach/views/saves/shares/total_interactions) - real
// metrics confirmed working against the account, unlike the classic Facebook Page
// Insights metrics (impressions, engaged_users, etc.), which are deprecated on this
// API version and return errors regardless of permissions. Instagram's numbers are
// therefore richer than Facebook's below - that's a real platform limitation, not
// something skipped for convenience.
async function getIgMediaInsights(mediaId) {
  const base = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
  const body = await fetchMetaJson(
    `${base}/${mediaId}/insights?metric=reach,views,saved,shares,total_interactions&access_token=${META_PAGE_ACCESS_TOKEN}`
  );
  const byName = Object.fromEntries((body?.data || []).map((m) => [m.name, m.values?.[0]?.value ?? 0]));
  return {
    reach: byName.reach || 0,
    views: byName.views || 0,
    saved: byName.saved || 0,
    shares: byName.shares || 0,
    totalInteractions: byName.total_interactions || 0,
  };
}

// Pulls this week's actual post counts, engagement, reach, and current follower
// counts from Instagram + Facebook via the Meta Graph API. Returns null (section
// skipped entirely, digest still sends) if the token is missing or both platforms
// fail - this is enrichment, not something that should ever block the weekly send.
async function getSocialMediaReport() {
  if (!META_PAGE_ACCESS_TOKEN) {
    lib.log("digest", "META_PAGE_ACCESS_TOKEN not set - skipping SoMe report.");
    return null;
  }

  const base = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
  const weekAgo = Date.now() - 7 * 86400000;

  const [igAccount, igMedia, fbPage, fbPosts] = await Promise.all([
    fetchMetaJson(`${base}/${META_IG_ID}?fields=followers_count,media_count&access_token=${META_PAGE_ACCESS_TOKEN}`),
    fetchMetaJson(
      `${base}/${META_IG_ID}/media?fields=id,timestamp,caption,media_type,like_count,comments_count&limit=25&access_token=${META_PAGE_ACCESS_TOKEN}`
    ),
    fetchMetaJson(`${base}/${META_PAGE_ID}?fields=fan_count&access_token=${META_PAGE_ACCESS_TOKEN}`),
    fetchMetaJson(
      `${base}/${META_PAGE_ID}/posts?fields=id,created_time,likes.summary(true).limit(0),comments.summary(true).limit(0)&limit=25&access_token=${META_PAGE_ACCESS_TOKEN}`
    ),
  ]);

  if (!igAccount && !fbPage) return null;

  const igRecent = (igMedia?.data || []).filter((m) => new Date(m.timestamp).getTime() >= weekAgo);
  const fbRecent = (fbPosts?.data || []).filter((p) => new Date(p.created_time).getTime() >= weekAgo);

  const igInsights = await Promise.all(igRecent.map((m) => getIgMediaInsights(m.id)));
  const instagramPosts = igRecent.map((m, i) => ({
    caption: (m.caption || "").slice(0, 140),
    mediaType: m.media_type || "UKJENT",
    likes: m.like_count || 0,
    comments: m.comments_count || 0,
    ...igInsights[i],
  }));

  const instagram = igAccount
    ? {
        followers: igAccount.followers_count ?? null,
        postsThisWeek: igRecent.length,
        likesThisWeek: igRecent.reduce((sum, m) => sum + (m.like_count || 0), 0),
        commentsThisWeek: igRecent.reduce((sum, m) => sum + (m.comments_count || 0), 0),
        reachThisWeek: igInsights.reduce((sum, i) => sum + i.reach, 0),
        viewsThisWeek: igInsights.reduce((sum, i) => sum + i.views, 0),
        interactionsThisWeek: igInsights.reduce((sum, i) => sum + i.totalInteractions, 0),
        savedThisWeek: igInsights.reduce((sum, i) => sum + i.saved, 0),
        sharesThisWeek: igInsights.reduce((sum, i) => sum + i.shares, 0),
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
    ? posts
        .map(
          (p, i) =>
            `${i + 1}. "${p.caption || "(ingen tekst)"}" (${p.mediaType}): ${p.reach} rekkevidde, ${p.views} visninger, ${p.likes} liker, ${p.comments} kommentarer, ${p.saved} lagringer, ${p.shares} delinger`
        )
        .join("\n")
    : "Ingen innlegg ble publisert denne uken.";

  const prompt = `Du er en sosiale medier-analytiker for Palm Tree Productions (PTP), et videoproduksjonsselskap i Ålesund som lager innhold for merkevarer, bedrifter og artister (bl.a. Kygo).

Instagram-tall for uken:
- Følgere: ${ig.followers}
- Nye innlegg: ${ig.postsThisWeek}
- Total rekkevidde: ${ig.reachThisWeek}, visninger: ${ig.viewsThisWeek}
- Liker: ${ig.likesThisWeek}, kommentarer: ${ig.commentsThisWeek}, lagringer: ${ig.savedThisWeek}, delinger: ${ig.sharesThisWeek}

Innlegg denne uken:
${postsList}

Skriv en KORT rapport i tre deler, grounded utelukkende i tallene og innleggene over.

HARD RULE: Ikke gjett eller finn på tall, innleggstyper, eller trender som ikke er nevnt over. Hvis det ikke var noen innlegg denne uken, skal "Hva funket" ærlig reflektere det (f.eks. at ingenting ble publisert) i stedet for å finne på noe positivt.

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

function growthLine(label, current, prior, priorMonth, priorYear) {
  if (current == null) return null;
  const parts = [
    followerDeltaText(current, prior, priorMonth, priorYear),
    `${current.postsThisWeek} nye innlegg`,
    `${current.likesThisWeek} liker`,
    `${current.commentsThisWeek} kommentarer`,
  ];
  if (current.reachThisWeek != null) {
    parts.push(`${current.reachThisWeek} rekkevidde`, `${current.viewsThisWeek} visninger`, `${current.savedThisWeek} lagringer`, `${current.sharesThisWeek} delinger`);
  }
  return `  ${label}: ${parts.join(", ")}`;
}

function buildDigestText({ leads, competitors, events }, leadsByOrgnr, followup, trends, someReport) {
  const total = leads.length + competitors.length + events.length;
  const lines = [];
  lines.push(`PTP Internal - ukentlig oppsummering`);
  lines.push(``);

  if (someReport) {
    lines.push(`Sosiale medier denne uken:`);
    const igLine = growthLine("Instagram", someReport.report.instagram, someReport.prior?.instagram, someReport.priorMonth?.instagram, someReport.priorYear?.instagram);
    const fbLine = growthLine("Facebook", someReport.report.facebook, someReport.prior?.facebook, someReport.priorMonth?.facebook, someReport.priorYear?.facebook);
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
    lines.push(`Leads å følge opp - høy score, ikke kontaktet ennå (${followup.uncontacted.length}):`);
    followup.uncontacted.forEach((l) => lines.push(`  - ${l.navn} — score ${l.score}, ${l.fylke || "ukjent fylke"}`));
    lines.push(``);
  }

  if (followup.stale.length) {
    lines.push(`Leads som har stått stille i ${FOLLOWUP_STALE_DAYS}+ dager (${followup.stale.length}):`);
    followup.stale.forEach((l) => lines.push(`  - ${l.navn} — "${l.entry.stage}" i ${l.days} dager`));
    lines.push(``);
  }

  if (total === 0) {
    lines.push(`Ingen nye funn denne uken. Automasjonen fant ingenting som var verifiserbart og relevant nok til å legge til - det er en normal og forventet uke, ikke en feil.`);
  } else {
    if (leads.length) {
      lines.push(`Nye leads (${leads.length}):`);
      leads.forEach((c) => lines.push(`  - ${enrichLeadLine(c, leadsByOrgnr)}`));
      lines.push(``);
    }
    if (competitors.length) {
      lines.push(`Nye konkurrenter (${competitors.length}):`);
      competitors.forEach((c) => lines.push(`  - ${c.replace(/^Add competitor:\s*/, "")}`));
      lines.push(``);
    }
    if (events.length) {
      lines.push(`Nye event (${events.length}):`);
      events.forEach((c) => lines.push(`  - ${c.replace(/^Add event:\s*/, "")}`));
      lines.push(``);
    }
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
function htmlSection(title, innerHtml) {
  return `
  <tr><td style="padding:28px 32px 8px;">
    <h2 style="margin:0 0 12px;font:600 15px -apple-system,'Segoe UI',sans-serif;color:${C.heading};">${escapeHtml(title)}</h2>
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

  if (current.reachThisWeek != null) {
    items.push(
      { label: "Rekkevidde", value: String(current.reachThisWeek) },
      { label: "Visninger", value: String(current.viewsThisWeek) },
      { label: "Total interaksjon", value: String(current.interactionsThisWeek) },
      { label: "Lagringer", value: String(current.savedThisWeek) },
      { label: "Delinger", value: String(current.sharesThisWeek) }
    );
  }

  return htmlMetricGrid(label, items);
}

function buildDigestHtml({ leads, competitors, events }, leadsByOrgnr, followup, trends, someReport) {
  const total = leads.length + competitors.length + events.length;
  let body = "";

  if (someReport) {
    const chartHtml = someReport.chartBase64
      ? `<img src="data:image/png;base64,${someReport.chartBase64}" width="500" alt="Følgervekst" style="display:block;width:100%;max-width:500px;height:auto;margin-top:12px;border-radius:8px;" />`
      : "";
    body += htmlSection(
      "Sosiale medier denne uken",
      htmlStatCard("Instagram", someReport.report.instagram, someReport.prior?.instagram, someReport.priorMonth?.instagram, someReport.priorYear?.instagram) +
        htmlStatCard("Facebook", someReport.report.facebook, someReport.prior?.facebook, someReport.priorMonth?.facebook, someReport.priorYear?.facebook) +
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
        .join("")
    );
  }

  if (followup.stale.length) {
    body += htmlSection(
      `Leads som har stått stille (${followup.stale.length})`,
      followup.stale
        .map((l) => htmlLeadCard(l.navn, `${l.days} dager`, "#D9B454", `"${l.entry.stage}"`))
        .join("")
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
        leads.map((c) => `<div style="font:13px -apple-system,'Segoe UI',sans-serif;color:${C.body};padding:4px 0;">${escapeHtml(enrichLeadLine(c, leadsByOrgnr))}</div>`).join("")
      );
    }
    if (competitors.length) {
      body += htmlSection(
        `Nye konkurrenter (${competitors.length})`,
        competitors
          .map((c) => `<div style="font:13px -apple-system,'Segoe UI',sans-serif;color:${C.body};padding:4px 0;">${escapeHtml(c.replace(/^Add competitor:\s*/, ""))}</div>`)
          .join("")
      );
    }
    if (events.length) {
      body += htmlSection(
        `Nye event (${events.length})`,
        events
          .map((c) => `<div style="font:13px -apple-system,'Segoe UI',sans-serif;color:${C.body};padding:4px 0;">${escapeHtml(c.replace(/^Add event:\s*/, ""))}</div>`)
          .join("")
      );
    }
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
          <tr><td style="padding:28px 32px 20px;border-bottom:3px solid ${C.green};">
            ${LOGO_BASE64 ? `<img src="data:image/png;base64,${LOGO_BASE64}" width="120" alt="Palm Tree Productions" style="display:block;width:120px;height:auto;margin:0 auto 14px;" />` : `<div style="font:600 12px -apple-system,'Segoe UI',sans-serif;color:${C.greenLight};letter-spacing:0.04em;text-transform:uppercase;text-align:center;">PTP Internal</div>`}
            <h1 style="margin:0;font:700 22px -apple-system,'Segoe UI',sans-serif;color:${C.heading};text-align:center;">Ukentlig oppsummering</h1>
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

async function sendDigest(text, html) {
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
      subject: "PTP Internal - ukentlig oppsummering",
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
  const [pipeline, archive] = await Promise.all([
    fetchJson(`${SITE_URL}/api/pipeline`),
    fetchJson(`${SITE_URL}/api/lead-archive`),
  ]);
  const followup = buildFollowupSections(leadsData, pipeline || {}, archive || {});
  const trends = await getTrendIdeas();

  const rawReport = await getSocialMediaReport();
  let someReport = null;
  if (rawReport) {
    const { prior, priorMonth, priorYear, history } = await updateSnapshotsAndGetHistory(rawReport);
    const [chartBase64, analysis] = await Promise.all([buildGrowthChartBase64(history), getInstagramAnalysis(rawReport)]);
    someReport = { report: rawReport, prior, priorMonth, priorYear, chartBase64, analysis };
  }

  lib.log(
    "digest",
    `Past 7 days: ${grouped.leads.length} lead(s), ${grouped.competitors.length} competitor(s), ${grouped.events.length} event(s). ` +
      `Follow-up: ${followup.uncontacted.length} uncontacted high-score, ${followup.stale.length} stale in pipeline. ` +
      `Trends: ${trends.length}. SoMe report: ${someReport ? "yes" : "skipped"}.`
  );

  const text = buildDigestText(grouped, leadsByOrgnr, followup, trends, someReport);
  const html = buildDigestHtml(grouped, leadsByOrgnr, followup, trends, someReport);
  await sendDigest(text, html);
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
};
