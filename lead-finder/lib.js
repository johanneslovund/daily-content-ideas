// Shared helpers for the weekly discovery scripts (Lead Finder, Konkurranse, Event).
// Kept separate from discover.js (Lead Finder) so that script - already tested and
// running daily - is never touched by changes made here for the newer scripts.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const Anthropic = require("@anthropic-ai/sdk");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
const SITE_REPO_SSH = "git@github.com:johanneslovund/ptp-internal-site.git";
const WORK_DIR = process.env.SITE_WORK_DIR || "/tmp/ptp-internal-site-work";

if (!ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is required.");
  process.exit(1);
}
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

function log(label, ...args) {
  console.log(`[${label}]`, ...args);
}

// ---- Git (private repo, SSH deploy key) - shared work dir across scripts ----

function setupGitSsh() {
  const keyPath = "/tmp/ptp_site_deploy_key";
  const key = process.env.PTP_SITE_DEPLOY_KEY;
  if (!key) throw new Error("PTP_SITE_DEPLOY_KEY is required.");
  if (!fs.existsSync(keyPath)) {
    fs.writeFileSync(keyPath, key.endsWith("\n") ? key : key + "\n", { mode: 0o600 });
  }
  process.env.GIT_SSH_COMMAND = `ssh -i ${keyPath} -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/tmp/known_hosts`;
}

function cloneOrPullSiteRepo() {
  if (fs.existsSync(path.join(WORK_DIR, ".git"))) {
    log("git", "Repo already checked out, pulling latest...");
    execSync("git fetch origin main && git reset --hard origin/main", { cwd: WORK_DIR, stdio: "inherit" });
  } else {
    log("git", "Cloning private site repo...");
    fs.mkdirSync(path.dirname(WORK_DIR), { recursive: true });
    execSync(`git clone ${SITE_REPO_SSH} "${WORK_DIR}"`, { stdio: "inherit" });
  }
  execSync('git config user.email "weekly-discovery-bot@ptp-internal"', { cwd: WORK_DIR });
  execSync('git config user.name "Weekly Discovery Automation"', { cwd: WORK_DIR });
}

function commitAndPushSiteRepo(message) {
  execSync("git add -A", { cwd: WORK_DIR, stdio: "inherit" });
  const status = execSync("git status --porcelain", { cwd: WORK_DIR }).toString().trim();
  if (!status) {
    log("git", "Nothing changed, skipping commit.");
    return false;
  }
  execSync(`git commit -q -m ${JSON.stringify(message)}`, { cwd: WORK_DIR, stdio: "inherit" });
  execSync("git push origin main", { cwd: WORK_DIR, stdio: "inherit" });
  return true;
}

function deployToCloudflarePages() {
  log("deploy", "Deploying to Cloudflare Pages...");
  execSync("npx -y wrangler@4.80.0 pages deploy public --project-name=ptp-internal --commit-dirty=true", {
    cwd: WORK_DIR,
    stdio: "inherit",
    env: process.env,
  });
}

// ---- Brønnøysundregisteret (authoritative - never guessed) ----

async function brregSearchByName(name) {
  const url = `https://data.brreg.no/enhetsregisteret/api/enheter?navn=${encodeURIComponent(name)}&size=5`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return [];
  const data = await res.json();
  return data._embedded?.enheter || [];
}

async function brregGetEnhet(orgnr) {
  const res = await fetch(`https://data.brreg.no/enhetsregisteret/api/enheter/${orgnr}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return null;
  return res.json();
}

async function brregGetRegnskap(orgnr) {
  const res = await fetch(`https://data.brreg.no/regnskapsregisteret/regnskap/${orgnr}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!Array.isArray(data) || !data.length) return null;
  data.sort((a, b) => (b.regnskapsperiode?.tilDato || "").localeCompare(a.regnskapsperiode?.tilDato || ""));
  return data[0];
}

function normalizeCompanyName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

// Verifies a candidate name resolves to exactly one real, active company. Brreg's
// ?navn= search is fuzzy/token-based, not exact match - confirmed by testing (a
// nonsense name still returns "matches"). Only trust an ACTUAL case-insensitive
// exact name match, never "something came back." Returns a verified fact bundle
// (financials/employees only - no roller lookup, callers that need daglig
// leder/styreleder should call brregGetRoller-equivalent themselves) or null.
async function verifyCompanyBasic(candidateName, existingOrgnrs) {
  const matches = await brregSearchByName(candidateName);
  const target = normalizeCompanyName(candidateName);
  const exact = matches.filter(
    (m) =>
      normalizeCompanyName(m.navn) === target &&
      !m.konkurs &&
      !m.underAvvikling &&
      !m.underTvangsavviklingEllerTvangsopplosning
  );
  if (exact.length !== 1) {
    log("brreg", `Verification failed for "${candidateName}": ${exact.length} exact active match(es) (of ${matches.length} fuzzy results).`);
    return null;
  }
  const hit = exact[0];
  if (existingOrgnrs.has(hit.organisasjonsnummer)) {
    log("brreg", `"${hit.navn}" (${hit.organisasjonsnummer}) is already in the list.`);
    return null;
  }

  const enhet = await brregGetEnhet(hit.organisasjonsnummer);
  if (!enhet) return null;
  const regnskap = await brregGetRegnskap(hit.organisasjonsnummer);

  return {
    orgnr: hit.organisasjonsnummer,
    navn: enhet.navn,
    bransje: enhet.naeringskode1?.beskrivelse || null,
    sted: enhet.forretningsadresse?.poststed
      ? `${enhet.forretningsadresse.poststed.charAt(0)}${enhet.forretningsadresse.poststed.slice(1).toLowerCase()}`
      : null,
    kommune: enhet.forretningsadresse?.kommune || null,
    kommunenummer: enhet.forretningsadresse?.kommunenummer || null,
    ansatte: typeof enhet.antallAnsatte === "number" ? enhet.antallAnsatte : null,
    driftsinntekter: regnskap?.resultatregnskapResultat?.driftsresultat?.driftsinntekter?.sumDriftsinntekter ?? null,
    aarsresultat: regnskap?.resultatregnskapResultat?.aarsresultat ?? null,
    aar: regnskap?.regnskapsperiode?.tilDato ? Number(regnskap.regnskapsperiode.tilDato.slice(0, 4)) : null,
    hjemmeside: enhet.hjemmeside || null,
  };
}

// Norwegian kommunenummer prefixes reliably encode fylke.
const FYLKE_BY_KOMMUNENUMMER_PREFIX = {
  3: "Oslo/Akershus",
  11: "Rogaland",
  15: "Møre og Romsdal",
  18: "Nordland",
  31: "Østfold",
  32: "Akershus",
  33: "Buskerud",
  34: "Innlandet",
  39: "Vestfold",
  40: "Telemark",
  42: "Agder",
  46: "Vestland",
  50: "Trøndelag",
  55: "Troms",
  56: "Finnmark",
};
function fylkeFromKommunenummer(kommunenummer) {
  if (!kommunenummer || kommunenummer.length < 2) return null;
  return FYLKE_BY_KOMMUNENUMMER_PREFIX[Number(kommunenummer.slice(0, 2))] || null;
}

// ---- Claude (web search, with pause_turn handling + a corrective nudge if the
// response comes back as narration with no JSON in it - see daily-content-ideas'
// server.js for the original diagnosis of this failure mode). ----

function looksLikeJson(text) {
  return findBalancedJsonCandidates(text.trim()).some((c) => {
    try {
      JSON.parse(c);
      return true;
    } catch (e) {
      return false;
    }
  });
}

async function askClaudeWithSearch(prompt, maxTokens = 2000, maxSearches = 5) {
  const messages = [{ role: "user", content: prompt }];
  const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: maxSearches }];

  async function runTurn() {
    let response = await anthropic.messages.create({ model: MODEL, max_tokens: maxTokens, messages, tools });
    let loops = 0;
    while (response.stop_reason === "pause_turn" && loops < 5) {
      messages.push({ role: "assistant", content: response.content });
      response = await anthropic.messages.create({ model: MODEL, max_tokens: maxTokens, messages, tools });
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

function findBalancedJsonCandidates(text) {
  const candidates = [];
  const openers = { "[": "]", "{": "}" };
  for (let i = 0; i < text.length; i++) {
    const opener = text[i];
    const closer = openers[opener];
    if (!closer) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === opener) depth++;
      else if (ch === closer) {
        depth--;
        if (depth === 0) {
          candidates.push(text.slice(i, j + 1));
          break;
        }
      }
    }
  }
  return candidates;
}

function parseJson(text) {
  const cleaned = text.trim().replace(/^```json\s*|^```\s*|```$/g, "");
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const candidates = findBalancedJsonCandidates(cleaned).sort((a, b) => b.length - a.length);
    for (const c of candidates) {
      try {
        return JSON.parse(c);
      } catch (e2) {
        /* try next */
      }
    }
    throw new Error(`Could not parse JSON: ${e.message}`);
  }
}

module.exports = {
  WORK_DIR,
  log,
  setupGitSsh,
  cloneOrPullSiteRepo,
  commitAndPushSiteRepo,
  deployToCloudflarePages,
  brregSearchByName,
  brregGetEnhet,
  brregGetRegnskap,
  verifyCompanyBasic,
  fylkeFromKommunenummer,
  askClaudeWithSearch,
  parseJson,
  anthropic,
  MODEL,
};
