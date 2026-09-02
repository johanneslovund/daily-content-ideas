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

function buildDigestText({ leads, competitors, events }, leadsByOrgnr, followup, trends) {
  const total = leads.length + competitors.length + events.length;
  const lines = [];
  lines.push(`PTP Internal - ukentlig oppsummering`);
  lines.push(``);

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
const LOGO_BASE64 = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, "assets", "ptp-logo.png")).toString("base64");
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

// Table-based layout with inline styles throughout - required for consistent
// rendering across email clients (Gmail/Outlook strip <style> blocks and much of
// modern CSS). Mirrors the site's brand green (#3FA873/#4FBD84) but on a light
// background, since dark email bodies render inconsistently and read poorly in
// most inboxes.
function htmlSection(title, innerHtml) {
  return `
  <tr><td style="padding:28px 32px 8px;">
    <h2 style="margin:0 0 12px;font:600 15px -apple-system,'Segoe UI',sans-serif;color:#14171A;">${escapeHtml(title)}</h2>
    ${innerHtml}
  </td></tr>`;
}

function htmlLeadCard(name, badgeText, badgeColor, sub) {
  return `
    <div style="padding:10px 14px;border:1px solid #E4E7E5;border-radius:8px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;">
      <div>
        <div style="font:600 14px -apple-system,'Segoe UI',sans-serif;color:#14171A;">${escapeHtml(name)}</div>
        ${sub ? `<div style="font:13px -apple-system,'Segoe UI',sans-serif;color:#6B7280;margin-top:2px;">${escapeHtml(sub)}</div>` : ""}
      </div>
      <span style="font:600 12px -apple-system,'Segoe UI',sans-serif;color:${badgeColor};background:${badgeColor}1A;padding:4px 10px;border-radius:999px;white-space:nowrap;">${escapeHtml(badgeText)}</span>
    </div>`;
}

function buildDigestHtml({ leads, competitors, events }, leadsByOrgnr, followup, trends) {
  const total = leads.length + competitors.length + events.length;
  let body = "";

  if (followup.uncontacted.length) {
    body += htmlSection(
      `Leads å følge opp - ikke kontaktet ennå (${followup.uncontacted.length})`,
      followup.uncontacted
        .map((l) => htmlLeadCard(l.navn, `score ${l.score}`, "#3FA873", l.fylke || "ukjent fylke"))
        .join("")
    );
  }

  if (followup.stale.length) {
    body += htmlSection(
      `Leads som har stått stille (${followup.stale.length})`,
      followup.stale
        .map((l) => htmlLeadCard(l.navn, `${l.days} dager`, "#D97706", `"${l.entry.stage}"`))
        .join("")
    );
  }

  if (trends.length) {
    body += htmlSection(
      "Aktuelle SoMe-trender å vurdere",
      trends
        .map(
          (t) => `
      <div style="padding:12px 14px;border:1px solid #E4E7E5;border-radius:8px;margin-bottom:8px;">
        <div style="font:600 14px -apple-system,'Segoe UI',sans-serif;color:#3FA873;margin-bottom:4px;">${escapeHtml(t.trend)}</div>
        <div style="font:13px/1.5 -apple-system,'Segoe UI',sans-serif;color:#374151;">${escapeHtml(t.idea)}</div>
      </div>`
        )
        .join("")
    );
  }

  if (total === 0) {
    body += htmlSection(
      "Nye funn denne uken",
      `<div style="font:13px/1.5 -apple-system,'Segoe UI',sans-serif;color:#6B7280;">Ingen nye funn denne uken. Automasjonen fant ingenting som var verifiserbart og relevant nok til å legge til - det er en normal og forventet uke, ikke en feil.</div>`
    );
  } else {
    if (leads.length) {
      body += htmlSection(
        `Nye leads (${leads.length})`,
        leads.map((c) => `<div style="font:13px -apple-system,'Segoe UI',sans-serif;color:#374151;padding:4px 0;">${escapeHtml(enrichLeadLine(c, leadsByOrgnr))}</div>`).join("")
      );
    }
    if (competitors.length) {
      body += htmlSection(
        `Nye konkurrenter (${competitors.length})`,
        competitors
          .map((c) => `<div style="font:13px -apple-system,'Segoe UI',sans-serif;color:#374151;padding:4px 0;">${escapeHtml(c.replace(/^Add competitor:\s*/, ""))}</div>`)
          .join("")
      );
    }
    if (events.length) {
      body += htmlSection(
        `Nye event (${events.length})`,
        events
          .map((c) => `<div style="font:13px -apple-system,'Segoe UI',sans-serif;color:#374151;padding:4px 0;">${escapeHtml(c.replace(/^Add event:\s*/, ""))}</div>`)
          .join("")
      );
    }
  }

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  </head>
  <body style="margin:0;padding:0;background:#F5F6F5;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F6F5;padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border-radius:12px;overflow:hidden;max-width:600px;width:100%;">
          <tr><td style="padding:28px 32px 20px;border-bottom:3px solid #3FA873;">
            ${LOGO_BASE64 ? `<img src="data:image/png;base64,${LOGO_BASE64}" width="120" alt="Palm Tree Productions" style="display:block;width:120px;height:auto;margin-bottom:14px;" />` : `<div style="font:600 12px -apple-system,'Segoe UI',sans-serif;color:#3FA873;letter-spacing:0.04em;text-transform:uppercase;">PTP Internal</div>`}
            <h1 style="margin:0;font:700 22px -apple-system,'Segoe UI',sans-serif;color:#14171A;">Ukentlig oppsummering</h1>
          </td></tr>
          ${body}
          <tr><td style="padding:24px 32px 32px;">
            <a href="${SITE_URL}" style="display:inline-block;font:600 13px -apple-system,'Segoe UI',sans-serif;color:#FFFFFF;background:#3FA873;padding:10px 18px;border-radius:8px;text-decoration:none;">Åpne ptp-internal</a>
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

  lib.log(
    "digest",
    `Past 7 days: ${grouped.leads.length} lead(s), ${grouped.competitors.length} competitor(s), ${grouped.events.length} event(s). ` +
      `Follow-up: ${followup.uncontacted.length} uncontacted high-score, ${followup.stale.length} stale in pipeline. ` +
      `Trends: ${trends.length}.`
  );

  const text = buildDigestText(grouped, leadsByOrgnr, followup, trends);
  const html = buildDigestHtml(grouped, leadsByOrgnr, followup, trends);
  await sendDigest(text, html);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[digest] Fatal error:", e);
    process.exit(1);
  });
}

module.exports = { buildFollowupSections, buildDigestText, buildDigestHtml, enrichLeadLine, categorize, fetchJson, getTrendIdeas };
