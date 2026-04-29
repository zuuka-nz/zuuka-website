# Zuuka site — operations

The site is a single static `index.html` deployed to **Azure Static Web Apps** via the GitHub Actions workflow in `.github/workflows/azure-static-web-apps.yml`. Pushing to `main` deploys; PRs get a preview environment automatically.

This document covers the QR redirector + analytics additions.

---

## Components

- `index.html` — the site. Loads the App Insights browser SDK from CDN and tracks pageviews.
- `staticwebapp.config.json` — rewrites `/go/*` to the redirector function.
- `api/go/` — Azure Function: looks up the id in Table Storage, logs a custom event to App Insights, returns a 302.
- `scripts/seed-redirects.js` — local script for upserting redirect rows.

## Azure resources required

You need three Azure resources, all in the same region as the SWA:

1. **Static Web App** (already exists).
2. **Application Insights** — workspace-based, free tier. Captures site pageviews and redirector events.
3. **Storage Account** with a Table named `redirects` — holds the `id → target` lookup. Cheapest tier (Standard LRS) is fine.

### Create them (Azure CLI)

```bash
RG=zuuka-rg                    # your resource group
LOC=australiaeast              # or whichever region the SWA is in
SWA=zuuka-website              # name of the existing Static Web App
STORAGE=zuukaredirects         # must be globally unique, lowercase, 3-24 chars
AI=zuuka-appinsights

# 1. App Insights (workspace-based — needs a Log Analytics workspace)
az monitor log-analytics workspace create -g $RG -n zuuka-logs -l $LOC
WORKSPACE_ID=$(az monitor log-analytics workspace show -g $RG -n zuuka-logs --query id -o tsv)
az monitor app-insights component create -g $RG -a $AI -l $LOC --workspace $WORKSPACE_ID
AI_CONN=$(az monitor app-insights component show -g $RG -a $AI --query connectionString -o tsv)

# 2. Storage account + redirects table
az storage account create -g $RG -n $STORAGE -l $LOC --sku Standard_LRS --kind StorageV2
STORAGE_CONN=$(az storage account show-connection-string -g $RG -n $STORAGE --query connectionString -o tsv)
az storage table create -n redirects --connection-string "$STORAGE_CONN"

# 3. Wire connection strings into SWA app settings (read by the Function at runtime)
az staticwebapp appsettings set -n $SWA -g $RG --setting-names \
  APPLICATIONINSIGHTS_CONNECTION_STRING="$AI_CONN" \
  REDIRECTS_STORAGE_CONNECTION_STRING="$STORAGE_CONN"
```

### Wire the browser App Insights snippet

In `index.html`, replace the literal string `PLACEHOLDER_APP_INSIGHTS_CONNECTION_STRING` with the value of `$AI_CONN` above (the same connection string the Function uses). It is a public client telemetry identifier — safe to commit.

## Adding / updating redirects

Edit the `ENTRIES` array in `scripts/seed-redirects.js`, then:

```bash
cd scripts && npm install && cd ..
REDIRECTS_STORAGE_CONNECTION_STRING="$STORAGE_CONN" node scripts/seed-redirects.js
```

Each entry has:
- `id` — the path segment after `/go/` (lowercase, hyphens). Used as the table `RowKey`.
- `target` — full destination URL.
- `note` — optional, free text for your reference.
- `enabled` — optional, set to `false` to soft-disable a code without deleting it.

For one-off edits you can also use **Azure Storage Explorer** or the Azure Portal Table editor — same table, same schema. No deploy needed; the Function reads the table on every hit.

### Recommended id scheme

| Pattern | Use |
|---|---|
| `biz-<initials>-<seq>` | Business cards (`biz-jc-01`, `biz-jake-01`) |
| `fly-<event>-<yy>` | Flyers / event handouts (`fly-medtech-26`) |
| `pkg-<context>` | Packaging / pitch decks |
| `web-<channel>` | Online uses (LinkedIn, etc) — gives attribution parity |

Targets typically point at `https://zuuka.com/?ref=<id>` so the same id appears in App Insights pageview data, letting you follow a session from QR scan into the site.

## Querying analytics

Open the App Insights resource in the Azure portal → **Logs** (Kusto).

**QR hits per id, last 30 days:**
```kusto
customEvents
| where name == "qr_redirect" and timestamp > ago(30d)
| extend id = tostring(customDimensions.id), found = tostring(customDimensions.found)
| summarize hits = count() by id, found
| order by hits desc
```

**Daily trend for a specific id:**
```kusto
customEvents
| where name == "qr_redirect"
| where tostring(customDimensions.id) == "biz-jc-01"
| summarize hits = count() by bin(timestamp, 1d)
| render timechart
```

**Pageviews on the main site, by referrer:**
```kusto
pageViews
| where timestamp > ago(30d)
| summarize views = count() by tostring(customDimensions.referrer)
| order by views desc
```

**Funnel: QR hit → site visit (matching the `?ref=` parameter):**
```kusto
let qr = customEvents
  | where name == "qr_redirect"
  | extend id = tostring(customDimensions.id);
let visits = pageViews
  | extend ref = extract(@"[?&]ref=([^&]+)", 1, url);
qr
| summarize qrHits = count() by id
| join kind=leftouter (visits | summarize visits = count() by id = ref) on id
| project id, qrHits, visits
```

Pin any of these as a dashboard for at-a-glance use.

## Local development

```bash
npm install -g @azure/static-web-apps-cli
cd api && npm install && cd ..
swa start . --api-location api
```

The redirector hits real Table Storage and real App Insights — set both connection strings in your shell first, or use a `.env` file (gitignored) loaded by the SWA CLI.

## Privacy

- Client IPs are truncated to /24 (IPv4) or /64 (IPv6) before logging.
- No cookies are set by the redirector.
- App Insights browser SDK does set a session cookie by default; if you later need a cookie-free posture, set `isCookieUseDisabled: true` in the JS config.
