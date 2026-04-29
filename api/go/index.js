const { TableClient, RestError } = require("@azure/data-tables");

const DEFAULT_TARGET = "https://zuuka.com/";
const TABLE_NAME = "redirects";
const PARTITION_KEY = "qr";

let tableClient;
function getTable() {
  if (!tableClient) {
    const conn = process.env.REDIRECTS_STORAGE_CONNECTION_STRING;
    if (!conn) throw new Error("REDIRECTS_STORAGE_CONNECTION_STRING is not set");
    tableClient = TableClient.fromConnectionString(conn, TABLE_NAME);
  }
  return tableClient;
}

let aiCfg;
function getAiCfg() {
  if (aiCfg !== undefined) return aiCfg;
  const conn = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING || "";
  const iKeyMatch = /InstrumentationKey=([^;]+)/.exec(conn);
  const endpointMatch = /IngestionEndpoint=([^;]+)/.exec(conn);
  if (!iKeyMatch || !endpointMatch) {
    aiCfg = null;
    return null;
  }
  aiCfg = {
    iKey: iKeyMatch[1],
    url: endpointMatch[1].replace(/\/$/, "") + "/v2.1/track",
  };
  return aiCfg;
}

async function trackEvent(name, properties) {
  const cfg = getAiCfg();
  if (!cfg) return;
  const body = [
    {
      name: "Microsoft.ApplicationInsights." + cfg.iKey.replace(/-/g, "") + ".Event",
      time: new Date().toISOString(),
      iKey: cfg.iKey,
      data: {
        baseType: "EventData",
        baseData: { ver: 2, name, properties },
      },
    },
  ];
  try {
    await fetch(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (_) {
    // fire-and-forget; never fail the redirect because of telemetry
  }
}

function parseId(req) {
  const original = req.headers["x-ms-original-url"] || req.url || "";
  const path = original.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  const m = path.match(/^\/go\/(.+?)\/?$/i);
  return m ? decodeURIComponent(m[1]).toLowerCase() : "";
}

function truncateIp(ip) {
  if (!ip) return "";
  const first = ip.split(",")[0].trim();
  if (first.includes(":")) return first.replace(/(:[0-9a-f]+){4}$/i, ":0:0:0:0");
  const parts = first.split(".");
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0` : first;
}

module.exports = async function (context, req) {
  const id = parseId(req);
  const ua = req.headers["user-agent"] || "";
  const referer = req.headers["referer"] || req.headers["referrer"] || "";
  const ip = truncateIp(req.headers["x-forwarded-for"] || req.headers["x-azure-clientip"] || "");
  const country = req.headers["x-azure-clientip-country"] || "";

  let target = DEFAULT_TARGET;
  let found = false;

  if (id) {
    try {
      const entity = await getTable().getEntity(PARTITION_KEY, id);
      if (entity && entity.target && (entity.enabled === undefined || entity.enabled)) {
        target = entity.target;
        found = true;
      }
    } catch (err) {
      if (!(err instanceof RestError && err.statusCode === 404)) {
        context.log.error("redirects lookup failed", err);
      }
    }
  }

  await trackEvent("qr_redirect", {
    id,
    target,
    found: String(found),
    userAgent: ua,
    referer,
    ip,
    country,
  });

  context.res = {
    status: 302,
    headers: {
      Location: target,
      "Cache-Control": "no-store, max-age=0",
    },
  };
};
