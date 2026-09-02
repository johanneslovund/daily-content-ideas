// Weekly email digest. Summarizes what the Lead Finder / Konkurranse / Event
// automations actually added over the past 7 days, using the private repo's own
// commit history as the source of truth (each automation commits with a
// recognizable "Add lead:" / "Add competitor:" / "Add event:" message) rather than
// requiring the data files themselves to track when something was added.

const { execSync } = require("child_process");
const lib = require("./lib");

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const DIGEST_FROM = process.env.DIGEST_FROM_EMAIL || "onboarding@resend.dev";
const DIGEST_TO = (process.env.DIGEST_TO_EMAILS || "jl@palmtreeprod.com,ms@palmtreeprod.com")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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

function buildDigestText({ leads, competitors, events }) {
  const total = leads.length + competitors.length + events.length;
  const lines = [];
  lines.push(`PTP Internal - ukentlig oppsummering`);
  lines.push(``);

  if (total === 0) {
    lines.push(`Ingen nye funn denne uken. Automasjonen fant ingenting som var verifiserbart og relevant nok til å legge til - det er en normal og forventet uke, ikke en feil.`);
  } else {
    if (leads.length) {
      lines.push(`Nye leads (${leads.length}):`);
      leads.forEach((c) => lines.push(`  - ${c.replace(/^Add lead:\s*/, "")}`));
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
  lines.push(`https://ptp-internal.pages.dev`);
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
  lib.log(
    "digest",
    `Past 7 days: ${grouped.leads.length} lead(s), ${grouped.competitors.length} competitor(s), ${grouped.events.length} event(s).`
  );

  const text = buildDigestText(grouped);
  await sendDigest(text);
}

main().catch((e) => {
  console.error("[digest] Fatal error:", e);
  process.exit(1);
});
