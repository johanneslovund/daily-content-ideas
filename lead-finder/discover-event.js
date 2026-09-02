// Weekly Event discovery. Finds at most ONE new, real, genuinely upcoming industry
// event relevant to Palm Tree Productions, cited to a real source found via web
// search. If nothing qualifies this week, adds nothing - a quiet week is the
// expected, correct outcome, not a failure to work around.

const fs = require("fs");
const path = require("path");
const lib = require("./lib");

async function proposeEvent(existingNames, todayIso) {
  const prompt = `You are helping keep an events calendar current for Palm Tree Productions, a
high-end video/photo production company based in Ålesund, Norway (founded 2018, real clients
include Kygo, Frank Walker, Joe Jonas, Shawn Mendes, Rita Ora, Dean Lewis, Jamie Foxx, 50 Cent).
The calendar tracks conferences, festivals, and trade fairs relevant to networking with
prospective clients/agency partners or to the company's own industry (film/creative production,
seafood/aquaculture, maritime industry, travel/experience, local business, culture/festivals) -
mostly in Møre og Romsdal, Vestland, and Trøndelag, but nationally significant events count too.

Today's date is ${todayIso}. Search the web for ONE real, currently-announced event with a
confirmed date STRICTLY AFTER today - never something that has already happened.

Do NOT propose any of these (already on the calendar):
${existingNames.join(", ")}

If you cannot find a genuinely new, real, future-dated, well-sourced event, that is a completely
normal outcome - respond with {"found": false} rather than forcing a weak candidate.

If you do find one, respond with ONLY valid JSON:
{
  "found": true,
  "navn": "Real event name",
  "type": "Festival | Konferanse | Messe | Nettverksuke | Konferanse / prisutdeling",
  "kategori": "Film & kreativ bransje | Kultur & festival | Lokalt næringsliv | Maritim industri | Reiseliv & opplevelse | Sjømat & havbruk (or a new short category in this same style if none fit)",
  "sted": "City (venue)",
  "startDato": "YYYY-MM-DD",
  "sluttDato": "YYYY-MM-DD (same as startDato if one day)",
  "status": "bekreftet",
  "beskrivelse": "1-2 sentences: what it is and why it's relevant to Palm Tree Productions specifically",
  "url": "the real URL you found this via search"
}

Do not include anything other than the JSON object - no markdown fences, no explanation text.`;

  const text = await lib.askClaudeWithSearch(prompt, 1800, 5);
  return lib.parseJson(text);
}

function rebuildEventHtml(events) {
  const templatePath = path.join(lib.WORK_DIR, "source-data", "palmtree-event-template.html");
  const template = fs.readFileSync(templatePath, "utf8");
  const marker = "/*EVENTS_JSON_PLACEHOLDER*/";
  if (!template.includes(marker)) throw new Error("Template is missing the EVENTS_JSON_PLACEHOLDER marker.");
  const html = template.replace(marker, JSON.stringify(events, null, 2));
  const outPath = path.join(lib.WORK_DIR, "public", "Palm Tree Event.html");
  fs.writeFileSync(outPath, html, "utf8");
  lib.log("event", `Rebuilt ${outPath} (${events.length} events).`);
}

async function main() {
  lib.setupGitSsh();
  lib.cloneOrPullSiteRepo();

  const eventsPath = path.join(lib.WORK_DIR, "source-data", "events-data.json");
  const events = JSON.parse(fs.readFileSync(eventsPath, "utf8"));
  const existingNames = events.map((e) => e.navn);
  const todayIso = new Date().toISOString().slice(0, 10);

  lib.log("event", `Loaded ${events.length} existing events. Proposing a candidate...`);
  const candidate = await proposeEvent(existingNames, todayIso);

  if (!candidate?.found || !candidate.navn) {
    lib.log("event", "No qualifying new event found this week. Exiting without changes.");
    return;
  }

  const normalizedNew = candidate.navn.trim().toLowerCase();
  if (existingNames.some((n) => n.trim().toLowerCase() === normalizedNew)) {
    lib.log("event", `"${candidate.navn}" is already on the calendar. Exiting without changes.`);
    return;
  }
  if (!candidate.url || !/^https?:\/\//.test(candidate.url)) {
    lib.log("event", "Candidate has no real source URL. Exiting without changes.");
    return;
  }
  if (!candidate.startDato || candidate.startDato <= todayIso) {
    lib.log("event", `Candidate's date (${candidate.startDato}) is not genuinely in the future. Exiting without changes.`);
    return;
  }

  const entry = {
    navn: candidate.navn,
    type: candidate.type || "Konferanse",
    kategori: candidate.kategori || "Lokalt næringsliv",
    sted: candidate.sted || null,
    startDato: candidate.startDato,
    sluttDato: candidate.sluttDato || candidate.startDato,
    status: "bekreftet",
    beskrivelse: candidate.beskrivelse || "",
    url: candidate.url,
  };

  events.push(entry);
  fs.writeFileSync(eventsPath, JSON.stringify(events, null, 2), "utf8");
  rebuildEventHtml(events);

  const pushed = lib.commitAndPushSiteRepo(`Add event: ${entry.navn} (${entry.startDato})`);
  if (pushed) {
    lib.deployToCloudflarePages();
    lib.log("event", `Done. Added ${entry.navn}.`);
  }
}

main().catch((e) => {
  console.error("[event] Fatal error:", e);
  process.exit(1);
});
