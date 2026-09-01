// Daily Lead Finder automation.
//
// Finds ONE new, real, verified prospective client for Palm Tree Productions per run,
// appends it to the private ptp-internal-site repo's lead data, rebuilds the static
// Lead Finder page, and deploys the whole site to Cloudflare Pages.
//
// Data-integrity discipline (same rules as the rest of this project, enforced in code
// here rather than just by convention): every company that gets added must resolve to
// a single real entity in Brønnøysundregisteret. Financial figures, employee counts,
// and daglig leder/styreleder names come ONLY from that registry, never from the
// model. If verification fails at any step, the run aborts and adds nothing rather
// than guessing.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const Anthropic = require("@anthropic-ai/sdk");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
const SITE_REPO_SSH = "git@github.com:johanneslovund/ptp-internal-site.git";
const WORK_DIR = process.env.LEAD_FINDER_WORK_DIR || "/tmp/ptp-internal-site-work";
const TARGET_FYLKER = ["Møre og Romsdal", "Vestland", "Trøndelag"];
// Norwegian kommunenummer prefixes reliably encode fylke - far more trustworthy than
// trying to infer region from free text. (15=Møre og Romsdal, 46=Vestland, 50=Trøndelag.)
const FYLKE_BY_KOMMUNENUMMER_PREFIX = { 15: "Møre og Romsdal", 46: "Vestland", 50: "Trøndelag" };
function fylkeFromKommunenummer(kommunenummer) {
  if (!kommunenummer || kommunenummer.length < 2) return null;
  return FYLKE_BY_KOMMUNENUMMER_PREFIX[Number(kommunenummer.slice(0, 2))] || null;
}

if (!ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is required.");
  process.exit(1);
}
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

function log(...args) {
  console.log(`[lead-finder]`, ...args);
}

// ---- Git (private repo, SSH deploy key) ----

function setupGitSsh() {
  const keyPath = "/tmp/ptp_site_deploy_key";
  const key = process.env.PTP_SITE_DEPLOY_KEY;
  if (!key) throw new Error("PTP_SITE_DEPLOY_KEY is required.");
  fs.writeFileSync(keyPath, key.endsWith("\n") ? key : key + "\n", { mode: 0o600 });
  process.env.GIT_SSH_COMMAND = `ssh -i ${keyPath} -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/tmp/known_hosts`;
}

function cloneOrPullSiteRepo() {
  if (fs.existsSync(path.join(WORK_DIR, ".git"))) {
    log("Repo already checked out, pulling latest...");
    execSync("git fetch origin main && git reset --hard origin/main", { cwd: WORK_DIR, stdio: "inherit" });
  } else {
    log("Cloning private site repo...");
    fs.mkdirSync(path.dirname(WORK_DIR), { recursive: true });
    execSync(`git clone ${SITE_REPO_SSH} "${WORK_DIR}"`, { stdio: "inherit" });
  }
  execSync('git config user.email "lead-finder-bot@ptp-internal"', { cwd: WORK_DIR });
  execSync('git config user.name "Lead Finder Automation"', { cwd: WORK_DIR });
}

function commitAndPushSiteRepo(message) {
  execSync("git add -A", { cwd: WORK_DIR, stdio: "inherit" });
  const status = execSync("git status --porcelain", { cwd: WORK_DIR }).toString().trim();
  if (!status) {
    log("Nothing changed, skipping commit.");
    return false;
  }
  execSync(`git commit -q -m ${JSON.stringify(message)}`, { cwd: WORK_DIR, stdio: "inherit" });
  execSync("git push origin main", { cwd: WORK_DIR, stdio: "inherit" });
  return true;
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
  // Most recent period first.
  data.sort((a, b) => (b.regnskapsperiode?.tilDato || "").localeCompare(a.regnskapsperiode?.tilDato || ""));
  return data[0];
}

async function brregGetRoller(orgnr) {
  const res = await fetch(`https://data.brreg.no/enhetsregisteret/api/enheter/${orgnr}/roller`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return { dagligLeder: null, styreleder: null };
  const data = await res.json();
  let dagligLeder = null;
  let styreleder = null;
  for (const gruppe of data.rollegrupper || []) {
    for (const rolle of gruppe.roller || []) {
      if (rolle.avregistrert || rolle.person?.erDoed) continue;
      const navn = rolle.person?.navn;
      if (!navn) continue;
      const fullName = [navn.fornavn, navn.mellomnavn, navn.etternavn].filter(Boolean).join(" ");
      if (rolle.type?.kode === "DAGL" && !dagligLeder) dagligLeder = fullName;
      if (rolle.type?.kode === "LEDE" && !styreleder) styreleder = fullName;
    }
  }
  return { dagligLeder, styreleder };
}

// Verifies a candidate name resolves to exactly one real, active company. Returns a
// verified fact bundle or null if it can't be confidently resolved - callers must
// treat null as "abort, don't add anything."
function normalizeCompanyName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

async function verifyCompany(candidateName, existingOrgnrs) {
  // Brreg's ?navn= search is fuzzy/token-based, not exact match - it will happily
  // return up to `size` loosely-related results for almost any query (confirmed by
  // testing: a nonsense name still returned 5 "matches"). Only trust an ACTUAL
  // case-insensitive exact name match, never "something came back."
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
    log(`Verification failed for "${candidateName}": ${exact.length} exact active match(es) (of ${matches.length} fuzzy results).`);
    return null;
  }
  const hit = exact[0];
  if (existingOrgnrs.has(hit.organisasjonsnummer)) {
    log(`"${hit.navn}" (${hit.organisasjonsnummer}) is already in the leads list.`);
    return null;
  }

  const enhet = await brregGetEnhet(hit.organisasjonsnummer);
  if (!enhet) return null;

  const regnskap = await brregGetRegnskap(hit.organisasjonsnummer);
  const { dagligLeder, styreleder } = await brregGetRoller(hit.organisasjonsnummer);

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
    dagligLeder,
    styreleder,
    kontaktTelefon: enhet.telefon || enhet.mobil || null,
    kontaktEpost: enhet.epostadresse || null,
    hjemmeside: enhet.hjemmeside || null,
    stiftelsesdato: enhet.stiftelsesdato || null,
  };
}

// ---- Claude ----

async function askClaudeWithSearchOnce(prompt, maxTokens, maxSearches) {
  const messages = [{ role: "user", content: prompt }];
  const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: maxSearches }];
  let response = await anthropic.messages.create({ model: MODEL, max_tokens: maxTokens, messages, tools });
  let loops = 0;
  while (response.stop_reason === "pause_turn" && loops < 5) {
    messages.push({ role: "assistant", content: response.content });
    response = await anthropic.messages.create({ model: MODEL, max_tokens: maxTokens, messages, tools });
    loops++;
  }
  const textBlocks = response.content.filter((b) => b.type === "text");
  return textBlocks.map((b) => b.text).join("\n\n");
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

async function proposeCandidateName(existingNames) {
  const prompt = `You are helping find NEW prospective clients for Palm Tree Productions, a high-end
video/photo production company based in Ålesund, Norway (founded 2018, real clients include Kygo,
Frank Walker, Joe Jonas, Shawn Mendes, Rita Ora, Dean Lewis, Jamie Foxx, 50 Cent). We are looking for
companies that would plausibly HIRE a production company for brand films, commercials, or content -
not competitors, not tiny local shops with no marketing budget.

Search the web for ONE real, currently-operating Norwegian company based in ${TARGET_FYLKER.join(", ")}
that would be a strong prospective client - an ambitious, growing, or story-rich business (any
industry) that could benefit from high-quality video/photo content, and does not already have an
obvious in-house production capability.

Do NOT propose any of these companies (already in our list):
${existingNames.slice(0, 400).join(", ")}${existingNames.length > 400 ? ", ..." : ""}

Respond with ONLY valid JSON:
{ "name": "Exact real company name as registered", "reason": "1-2 sentences on why they're a good prospect" }

Do not include anything other than the JSON object - no markdown fences, no explanation text.`;

  const text = await askClaudeWithSearchOnce(prompt, 1500, 5);
  return parseJson(text);
}

async function writeLeadEntry(verified, reason, existingCategories) {
  const prompt = `You are writing one entry for Palm Tree Productions' internal Lead Finder tool - a
ranked list of prospective clients. Palm Tree Productions is a high-end video/photo production
company based in Ålesund, Norway (founded 2018, real clients include Kygo, Frank Walker, Joe Jonas,
Shawn Mendes, Rita Ora, Dean Lewis, Jamie Foxx, 50 Cent).

VERIFIED, REAL facts about this company (from Brønnøysundregisteret - use these exactly, do not
contradict or invent alternate figures):
${JSON.stringify(verified, null, 2)}

Why this company was proposed as a prospect: ${reason}

Search the web for supplementary details: their real website, real Instagram/LinkedIn URLs (only
include if you actually find them), and anything notable about their story, growth, or brand that
would make a good creative "angle" for outreach.

Existing bransjeKategori labels already in use (reuse one if it fits, or write a new short one in
the same style if nothing fits):
${existingCategories.slice(0, 60).join(", ")}

Write the following fields. CRITICAL: only state facts you were given above or that you found via
search and can point to - never invent revenue, employee counts, social media follower numbers, or
people's names beyond what was verified above.
- bransjeKategori: short category label, matching the style of the examples above
- score: 1-100, your honest judgment of how strong a prospect this is (revenue scale, growth story,
  visual/content potential) - do not inflate
- begrunnelse: 1-2 sentences on why they scored this way, grounded in the real facts given
- vinkel: 1 sentence - a concrete creative "angle" for a pitch video/content idea for this company
- sosialeMedier: 1-2 sentences on their current social media presence, based ONLY on what you find
  via search - if you can't verify anything, say so honestly rather than guessing
- instagramUrl: a real URL you found via search, or null
- linkedinUrl: a real URL you found via search, or null
- forventetBudsjett: a short budget estimate range in NOK, reasoned from the real revenue figure
- email: a personal, first-person cold outreach email draft in Norwegian (Bokmål), in this exact
  voice and structure (adapt the specifics, keep the tone and structure):
"""
Hei [fornavn på daglig leder],

Håper du har hatt en fin [sommer/periode].

Jeg har de siste 10 årene jobbet globalt, og siden 2018 drevet foto- og filmproduksjonsselskapet
Palm Tree Productions. Nylig flyttet jeg hjem og har nå base her i Ålesund. Vi har jobbet mye med
globale artister, men også i økende grad for selskaper som trenger sterkt visuelt innhold til
internasjonale markeder. Denne bakgrunnen gjør at vi kommer fra en litt annen angrepsvinkel enn
andre selskaper.

[2-3 setninger spesifikt om SELSKAPET og hvorfor de er relevante - bruk vinkelen over]

Hadde det vært aktuelt med en uformell prat? Har ingen agenda utover å ta en kaffe, høre litt om
hvilke jern dere har i ilden, og vise noe av det vi har laget.

Hører fra deg,
Johannes Lovund
Palm Tree Productions
"""
  If no daglig leder name was given above, address it generically ("Hei,") instead of inventing a name.

Respond with ONLY valid JSON with exactly these fields: bransjeKategori, score, begrunnelse, vinkel,
sosialeMedier, instagramUrl, linkedinUrl, forventetBudsjett, email.
Do not include anything other than the JSON object - no markdown fences, no explanation text.`;

  const text = await askClaudeWithSearchOnce(prompt, 3000, 4);
  return parseJson(text);
}

// ---- Rebuild the static page ----

function rebuildLeadFinderHtml(leads) {
  const templatePath = path.join(WORK_DIR, "source-data", "palmtree-leads-template.html");
  const template = fs.readFileSync(templatePath, "utf8");
  const marker = "/*LEADS_JSON_PLACEHOLDER*/";
  if (!template.includes(marker)) throw new Error("Template is missing the LEADS_JSON_PLACEHOLDER marker.");
  const html = template.replace(marker, JSON.stringify(leads, null, 2));
  const outPath = path.join(WORK_DIR, "public", "Palm Tree Lead Finder.html");
  fs.writeFileSync(outPath, html, "utf8");
  log(`Rebuilt ${outPath} (${leads.length} leads).`);
}

// ---- Deploy ----

function deployToCloudflarePages() {
  log("Deploying to Cloudflare Pages...");
  execSync("npx -y wrangler@4.80.0 pages deploy public --project-name=ptp-internal --commit-dirty=true", {
    cwd: WORK_DIR,
    stdio: "inherit",
    env: process.env,
  });
}

// ---- Main ----

async function main() {
  setupGitSsh();
  cloneOrPullSiteRepo();

  const leadsPath = path.join(WORK_DIR, "source-data", "palmtree-leads-data.json");
  const leads = JSON.parse(fs.readFileSync(leadsPath, "utf8"));
  const existingOrgnrs = new Set(leads.map((l) => l.orgnr));
  const existingNames = leads.map((l) => l.navn);
  const existingCategories = [...new Set(leads.map((l) => l.bransjeKategori).filter(Boolean))];

  log(`Loaded ${leads.length} existing leads. Proposing a candidate...`);
  const candidate = await proposeCandidateName(existingNames);
  if (!candidate?.name) {
    log("Claude did not propose a usable candidate. Exiting without changes.");
    return;
  }
  log(`Candidate: ${candidate.name} — ${candidate.reason}`);

  const verified = await verifyCompany(candidate.name, existingOrgnrs);
  if (!verified) {
    log("Could not verify the candidate against Brønnøysundregisteret. Exiting without changes.");
    return;
  }
  log(`Verified: ${verified.navn} (${verified.orgnr}), ${verified.sted}`);

  const fylke = fylkeFromKommunenummer(verified.kommunenummer);
  if (!fylke) {
    log(`${verified.navn} is outside the target regions (kommune: ${verified.kommune}). Exiting without changes.`);
    return;
  }

  const written = await writeLeadEntry(verified, candidate.reason, existingCategories);

  const maxRank = leads.reduce((m, l) => Math.max(m, l.rank || 0), 0);
  const sameCategory = leads.filter((l) => l.bransjeKategori === written.bransjeKategori);
  const maxBransjeRank = sameCategory.reduce((m, l) => Math.max(m, l.bransjeRank || 0), 0);

  const entry = {
    orgnr: verified.orgnr,
    navn: verified.navn,
    bransje: verified.bransje,
    sted: verified.sted,
    fylke,
    ansatte: verified.ansatte,
    driftsinntekter: verified.driftsinntekter,
    aarsresultat: verified.aarsresultat,
    aar: verified.aar,
    score: typeof written.score === "number" ? Math.max(1, Math.min(100, Math.round(written.score))) : 50,
    begrunnelse: written.begrunnelse || null,
    vinkel: written.vinkel || null,
    sosialeMedier: written.sosialeMedier || null,
    instagramUrl: written.instagramUrl || null,
    linkedinUrl: written.linkedinUrl || null,
    forventetBudsjett: written.forventetBudsjett || null,
    dagligLeder: verified.dagligLeder,
    styreleder: verified.styreleder,
    kontaktTelefon: verified.kontaktTelefon,
    kontaktEpost: verified.kontaktEpost,
    hjemmeside: verified.hjemmeside,
    nettsideUrl: verified.hjemmeside ? (verified.hjemmeside.startsWith("http") ? verified.hjemmeside : `https://${verified.hjemmeside}`) : null,
    email: written.email || null,
    rank: maxRank + 1,
    bransjeKategori: written.bransjeKategori || "Annet",
    bransjeRank: maxBransjeRank + 1,
  };

  leads.push(entry);
  fs.writeFileSync(leadsPath, JSON.stringify(leads, null, 2), "utf8");
  rebuildLeadFinderHtml(leads);

  const pushed = commitAndPushSiteRepo(`Add lead: ${entry.navn} (${entry.orgnr})`);
  if (pushed) {
    deployToCloudflarePages();
    log(`Done. Added ${entry.navn} as lead #${entry.rank}.`);
  }
}

main().catch((e) => {
  console.error("[lead-finder] Fatal error:", e);
  process.exit(1);
});
