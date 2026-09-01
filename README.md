# Daily Content Ideas – intern versjon

En enkel, permanent tjeneste som daglig genererer content-idéer for kortformat-video
(Reels/TikTok/Shorts), skreddersydd for Palm Tree Festival / Kygo-stilen. Kjører som en
egen Docker-stack på UGREEN NAS-en din, samme mønster som HolyClaude og Immich.

## Hva den gjør

- Hver dag kl. 07:00 (kan justeres) genererer den 8 nye content-idéer via Claude API,
  basert på en "merkevare-kontekst" du styrer selv.
- Web-UI på `http://<NAS-IP>:3060` viser idéene, du kan markere som brukt eller slette.
- Du kan også trykke "Generer nye idéer" manuelt når som helst.
- **Caption-generator:** Trykk "✍️ Lag captions" på en idé for å få 4 caption-forslag
  skreddersydd til nettopp det innlegget, eller bruk "✍️ Captions"-fanen til å skrive
  inn et fritt tema (f.eks. "backstage-klipp fra festivalen i går") og få forslag uten
  å måtte lage en idé først. Captionene er bevisst skrevet i jeg-form/personlig tone og
  bruker ulike engasjement-teknikker (spørsmål til følgere, cliffhanger, ærlig/sårbar
  detalj, dristig påstand) - hvert forslag merkes med hvilken teknikk det bruker, så du
  kan velge det som passer situasjonen.
- Alt lagres i en lokal SQLite-database på disk (ingen skytjeneste, ingen abonnement).

## 1. Skaff en Anthropic API-nøkkel

Gå til https://console.anthropic.com → Settings → API Keys → opprett en nøkkel.
Merk: dette er en annen type tilgang enn Claude Pro-abonnementet du bruker til HolyClaude
(API-nøkler faktureres per bruk, ikke fast pris — men kostnaden her er svært lav,
under $1/måned med 8 idéer/dag).

## 2. Last opp mappen til NAS-en

Kopier hele denne mappen (`daily-content-ideas/`) til NAS-en, f.eks. via File Station
til en mappe som `/volume1/docker/daily-content-ideas`.

## 3. Opprett stack i Portainer

1. Åpne Portainer (samme sted du satte opp HolyClaude/Immich).
2. Gå til **Stacks** → **Add stack**.
3. Navn: `daily-content-ideas`.
4. Velg **Upload** og pek på `docker-compose.yml` i mappen du lastet opp
   (eller lim inn innholdet direkte i "Web editor").
5. Under **Environment variables**, legg til:
   - `ANTHROPIC_API_KEY` = nøkkelen din fra steg 1
6. Trykk **Deploy the stack**.

Portainer bygger da Docker-image fra `Dockerfile` og starter containeren.

## 4. Bruk

Åpne `http://<NAS-lokale-IP>:3060` i nettleseren (samme IP som du bruker for
HolyClaude på port 3059 / Immich).

- Idéene genereres automatisk hver morgen.
- Trykk "🚀 Generer nye idéer" for å hente flere med det samme.
- Marker som "✅ brukt" når du har laget innhold basert på en idé — de havner da
  under "Brukt"-fanen i stedet for å rote til oversikten.

## 5. Tilpasning

Alt styres via miljøvariabler i `docker-compose.yml`:

| Variabel | Beskrivelse | Standard |
|---|---|---|
| `BRAND_CONTEXT` | Beskrivelse av merkevare/stil/målgruppe idéene skal treffe | Palm Tree Festival-tekst |
| `IDEAS_PER_BATCH` | Antall idéer som genereres per kjøring | 8 |
| `CRON_SCHEDULE` | Når daglig auto-generering kjører (cron-format) | `0 7 * * *` |
| `CLAUDE_MODEL` | Hvilken Claude-modell som brukes | `claude-sonnet-4-6` |

Endre `BRAND_CONTEXT` hvis du vil lage en egen versjon for JL Visuals-kunder også —
da kan du enten kjøre en egen stack med annen kontekst, eller legge inn logikk
for flere "profiler" senere hvis behovet melder seg.

## 6. Oppdatere koden senere

Hvis du (eller jeg i en senere samtale) endrer `server.js` eller `index.html`:
i Portainer, gå til stacken → **Update the stack** → kryss av **Re-pull image and
redeploy** / **Rebuild** avhengig av Portainer-versjon, så bygges den på nytt.

## Forskjell fra SocialSound.io

Dette er en forenklet, intern variant som kun dekker "Daily Content Ideas"-delen.
Den har ingen brukerkontoer, betaling, "Pro Content Review" (manuell feedback fra
et team), eller markedsføringsside — kun idégenerering tilpasset d## Integrasjon med ptp-internal (Cloudflare Pages)

ptp-internal.pages.dev viste seg å være et **direct-upload-prosjekt i Cloudflare
Pages uten Git-tilkobling** (bekreftet i Cloudflare-dashbordet: "No Git connection").
Det betyr at oppdateringer skjer ved å laste opp filene på nytt via Cloudflare-
dashbordet, ikke via en `git push`.

### Steg 1: Aktiver CORS på API-et

Samme som over - i `docker-compose.yml`:
```yaml
environment:
  - ALLOWED_ORIGIN=https://ptp-internal.pages.dev
```
NB: Siden ptp-internal er en **offentlig hostet side** (Cloudflare), mens Docker-
tjenesten kun kjører **lokalt på NAS-en din**, vil "Content Ideas"-siden bare
fungere når du åpner ptp-internal fra samme nettverk som NAS-en (hjemme-WiFi).
Åpner du siden når du er ute og reiser, vil ikke nettleseren nå NAS-ens lokale IP.
Si ifra hvis du vil at jeg skal sette opp ekstern tilgang (f.eks. en Cloudflare
Tunnel), så det fungerer overalt - det er en litt større jobb.

### Steg 2: Legg til den nye siden

1. Ta `ptp-internal-page/content-ideas.html` fra denne zip-en.
2. Sett riktig NAS-IP i `window.CONTENT_IDEAS_API` øverst i filen.
3. Legg den i samme mappe/prosjekt som resten av ptp-internal-filene dine lokalt
   (der du har kildefilene som opprinnelig ble lastet opp til Cloudflare).
4. Legg til et lenke-kort til den på forsiden - se
   `ptp-internal-page/card-snippet-instruksjoner.txt` for et utkast (kopier
   helst en av de eksisterende kortene i `index.html` og bytt innhold, så arves
   riktig styling automatisk).

### Steg 3: Last opp ny versjon til Cloudflare

1. Gå til https://dash.cloudflare.com → Workers & Pages → **ptp-internal**.
2. Trykk **Create deployment**.
3. Dra hele mappen med alle ptp-internal-filene (inkl. den nye `content-ideas.html`
   og oppdatert `index.html`) inn i opplastingsfeltet.
4. Trykk **Deploy** / **Save and Deploy**.

Dette steget må du gjøre selv - det krever at du drar filer fra din egen
datamaskin inn i nettleseren, noe jeg ikke har tilgang til å gjøre for deg.
