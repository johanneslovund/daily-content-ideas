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

function buildDigestText({ leads, competitors, events }, leadsByOrgnr, followup) {
  const total = leads.length + competitors.length + events.length;
  const lines = [];
  lines.push(`PTP Internal - ukentlig oppsummering`);
  lines.push(``);

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

async function sendDigest(text) {
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

  lib.log(
    "digest",
    `Past 7 days: ${grouped.leads.length} lead(s), ${grouped.competitors.length} competitor(s), ${grouped.events.length} event(s). ` +
      `Follow-up: ${followup.uncontacted.length} uncontacted high-score, ${followup.stale.length} stale in pipeline.`
  );

  const text = buildDigestText(grouped, leadsByOrgnr, followup);
  await sendDigest(text);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[digest] Fatal error:", e);
    process.exit(1);
  });
}

module.exports = { buildFollowupSections, buildDigestText, enrichLeadLine, categorize, fetchJson };
