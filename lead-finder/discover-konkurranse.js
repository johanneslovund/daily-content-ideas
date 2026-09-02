// Weekly Konkurranse (competitor) discovery. Finds at most ONE new, real, verified
// competitor per week and inserts it into the correct region's table on the static
// Konkurranse page. Unlike Lead Finder, this page has no separate JSON+template
// pipeline - rows are baked directly into the HTML - so this script does careful,
// scoped string insertion rather than a full rebuild. If nothing qualifies this
// week, adds nothing.

const fs = require("fs");
const path = require("path");
const lib = require("./lib");

const REGIONS = {
  mr: { label: "Møre og Romsdal" },
  vestland: { label: "Vestland" },
  trondelag: { label: "Trøndelag" },
  ostlandet: { label: "Østlandet" },
};

// Maps a real kommunenummer prefix to one of Konkurranse's 4 region buckets
// (ostlandet is a catch-all for the wider east-Norway area, matching how the
// page already categorizes e.g. Nittedal-based FEELM under Østlandet).
const KONKURRANSE_REGION_BY_PREFIX = {
  15: "mr",
  46: "vestland",
  50: "trondelag",
  3: "ostlandet",
  31: "ostlandet",
  32: "ostlandet",
  33: "ostlandet",
  34: "ostlandet",
  39: "ostlandet",
  40: "ostlandet",
};
function konkurranseRegionFromKommunenummer(kommunenummer) {
  if (!kommunenummer || kommunenummer.length < 2) return null;
  return KONKURRANSE_REGION_BY_PREFIX[Number(kommunenummer.slice(0, 2))] || null;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function extractExistingNames(html) {
  // Strip <script> content first - the page's own JS has a template literal
  // (`<span class="company-name">${escapeHtml(a.navn)}</span>`) for rendering
  // manually-added rows client-side, which the naive regex below would otherwise
  // match as if it were a real company name.
  const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/g, "");
  const names = [];
  const re = /<span class="company-name">([^<]*)<\/span>/g;
  let m;
  while ((m = re.exec(withoutScripts))) names.push(m[1].trim());
  return names;
}

function extractRegionInfo(html, regionId) {
  const sectionRe = new RegExp(`<section id="${regionId}">([\\s\\S]*?)</section>`);
  const sectionMatch = html.match(sectionRe);
  if (!sectionMatch) throw new Error(`Could not find <section id="${regionId}"> in Konkurranse.html`);
  const section = sectionMatch[0];
  const ranks = [...section.matchAll(/<td class="rank-cell">(\d+)<\/td>/g)].map((m) => Number(m[1]));
  const maxRank = ranks.length ? Math.max(...ranks) : 0;
  return { section, maxRank };
}

function buildRowHtml(rank, entry) {
  const resultClass = (entry.aarsresultat ?? 0) >= 0 ? "pos" : "neg";
  const figures =
    entry.driftsinntekter != null
      ? `<div>${new Intl.NumberFormat("nb-NO").format(Math.round(entry.driftsinntekter))} kr (${entry.aar})</div><div class="${resultClass}">${
          entry.aarsresultat >= 0 ? "+" : ""
        }${new Intl.NumberFormat("nb-NO").format(Math.round(entry.aarsresultat))} kr</div>`
      : `<div>—</div><div class="">—</div>`;
  const posClass = { premium: "pos-premium", generalist: "pos-generalist", budget: "pos-budget" }[entry.posisjonering] || "pos-generalist";
  const posLabel = { premium: "Premium/high-end", generalist: "Etablert generalist", budget: "Budsjett/frilans" }[entry.posisjonering] || "Etablert generalist";
  return `    <tr>
      <td class="rank-cell">${rank}</td>
      <td><span class="company-name">${escapeHtml(entry.navn)}</span><div class="meta">${escapeHtml(entry.sted)}</div></td>
      <td class="angle">${escapeHtml(entry.spesialisering)}</td>
      <td><span class="pos-badge ${posClass}">${posLabel}</span></td>
      <td class="figures">${figures}</td>
      <td class="meta" style="text-align:center">${entry.ansatte ?? "—"}</td>
      <td class="angle">${escapeHtml(entry.hvorfor)}</td>
      <td><a class="link-chip" href="${escapeHtml(entry.url)}" target="_blank" rel="noopener">Nettside ↗</a></td>
    </tr>\n`;
}

function insertRowIntoRegion(html, regionId, rowHtml, newRank) {
  const sectionRe = new RegExp(`(<section id="${regionId}">[\\s\\S]*?)(\\n\\s*</tbody>)`);
  if (!sectionRe.test(html)) throw new Error(`Could not find </tbody> inside <section id="${regionId}">`);
  html = html.replace(sectionRe, (full, before, closing) => `${before}${rowHtml}${closing}`);

  // Update this region's two count badges.
  const label = REGIONS[regionId].label;
  html = html.replace(
    new RegExp(`(data-region="${regionId}">${label} \\()(\\d+)(\\)</button>)`),
    (full, pre, n, post) => `${pre}${Number(n) + 1}${post}`
  );
  html = html.replace(
    new RegExp(`(<section id="${regionId}">\\s*<h2>${label} <span class="region-count">\\()(\\d+)(\\)</span></h2>)`),
    (full, pre, n, post) => `${pre}${Number(n) + 1}${post}`
  );

  // Update the overall total count pill.
  html = html.replace(/(<div class="count-pill" id="countPill">)(\d+)( selskaper totalt<\/div>)/, (full, pre, n, post) => `${pre}${Number(n) + 1}${post}`);

  return html;
}

async function proposeCompetitor(existingNames) {
  const prompt = `You are helping find NEW real competitors to track for Palm Tree Productions, a
high-end video/photo production company based in Ålesund, Norway (founded 2018, real clients
include Kygo, Frank Walker, Joe Jonas, Shawn Mendes, Rita Ora, Dean Lewis, Jamie Foxx, 50 Cent).
A "competitor" here means a real, currently-operating video/photo production company OR an
advertising/branding agency with its own in-house production team, based in Norway (Møre og
Romsdal, Vestland, Trøndelag, or the wider Østlandet/east-Norway area).

Search the web for ONE real competitor NOT already in this list:
${existingNames.join(", ")}

If you cannot find a genuinely new, real, currently-operating competitor with a real website, that
is a completely normal outcome - respond with {"found": false} rather than forcing a weak
candidate.

If you do find one, respond with ONLY valid JSON:
{
  "found": true,
  "name": "Exact real company name as registered",
  "reason": "1-2 sentences on what they do and why they're a real competitor"
}

Do not include anything other than the JSON object - no markdown fences, no explanation text.`;

  const text = await lib.askClaudeWithSearch(prompt, 1500, 5);
  return lib.parseJson(text);
}

async function writeCompetitorEntry(verified, reason) {
  const prompt = `You are writing one entry for Palm Tree Productions' internal competitor-tracking
tool. Palm Tree Productions is a high-end video/photo production company based in Ålesund, Norway.

VERIFIED, REAL facts about this competitor (from Brønnøysundregisteret - use these exactly):
${JSON.stringify(verified, null, 2)}

Why they're a real competitor: ${reason}

Search the web for their real website URL if not already given, and any detail about their client
work or positioning.

Write these fields, grounded ONLY in the facts given or found via search - never invent client
names or figures:
- spesialisering: 1 sentence on their production specialty
- posisjonering: one of "premium", "generalist", or "budget" - your honest judgment based on their
  revenue scale and market positioning
- hvorfor: 1-2 sentences on why they're a real competitive threat/relevant to track
- url: their real website URL (with https://)

Respond with ONLY valid JSON with exactly these fields: spesialisering, posisjonering, hvorfor, url.
Do not include anything other than the JSON object - no markdown fences, no explanation text.`;

  const text = await lib.askClaudeWithSearch(prompt, 1800, 3);
  return lib.parseJson(text);
}

async function main() {
  lib.setupGitSsh();
  lib.cloneOrPullSiteRepo();

  const pagePath = path.join(lib.WORK_DIR, "public", "Palm Tree Konkurranse.html");
  let html = fs.readFileSync(pagePath, "utf8");
  const existingNames = extractExistingNames(html);

  lib.log("konkurranse", `Loaded ${existingNames.length} existing competitors. Proposing a candidate...`);
  const candidate = await proposeCompetitor(existingNames);
  if (!candidate?.found || !candidate.name) {
    lib.log("konkurranse", "No qualifying new competitor found this week. Exiting without changes.");
    return;
  }
  lib.log("konkurranse", `Candidate: ${candidate.name} — ${candidate.reason}`);

  const existingOrgnrs = new Set(); // Konkurranse.html doesn't expose orgnr per row; name-based dedup already happened above.
  const verified = await lib.verifyCompanyBasic(candidate.name, existingOrgnrs);
  if (!verified) {
    lib.log("konkurranse", "Could not verify the candidate against Brønnøysundregisteret. Exiting without changes.");
    return;
  }
  lib.log("konkurranse", `Verified: ${verified.navn} (${verified.orgnr}), ${verified.sted}`);

  const regionId = konkurranseRegionFromKommunenummer(verified.kommunenummer);
  if (!regionId) {
    lib.log("konkurranse", `${verified.navn} is outside the tracked regions (kommune: ${verified.kommune}). Exiting without changes.`);
    return;
  }

  const written = await writeCompetitorEntry(verified, candidate.reason);
  if (!written.url) {
    lib.log("konkurranse", "No real URL found for this competitor. Exiting without changes.");
    return;
  }

  const { maxRank } = extractRegionInfo(html, regionId);
  const entry = {
    navn: verified.navn,
    sted: verified.sted,
    spesialisering: written.spesialisering,
    posisjonering: ["premium", "generalist", "budget"].includes(written.posisjonering) ? written.posisjonering : "generalist",
    driftsinntekter: verified.driftsinntekter,
    aarsresultat: verified.aarsresultat,
    aar: verified.aar,
    ansatte: verified.ansatte,
    hvorfor: written.hvorfor,
    url: written.url,
  };

  const rowHtml = buildRowHtml(maxRank + 1, entry);
  html = insertRowIntoRegion(html, regionId, rowHtml, maxRank + 1);
  fs.writeFileSync(pagePath, html, "utf8");
  lib.log("konkurranse", `Inserted ${entry.navn} into ${REGIONS[regionId].label} as rank ${maxRank + 1}.`);

  const pushed = lib.commitAndPushSiteRepo(`Add competitor: ${entry.navn} (${REGIONS[regionId].label})`);
  if (pushed) {
    lib.deployToCloudflarePages();
    lib.log("konkurranse", `Done. Added ${entry.navn}.`);
  }
}

main().catch((e) => {
  console.error("[konkurranse] Fatal error:", e);
  process.exit(1);
});
