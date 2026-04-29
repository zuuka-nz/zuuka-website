const { TableClient, RestError } = require("@azure/data-tables");
const appInsights = require("applicationinsights");

const DEFAULT_TARGET = "https://zuuka.com/";
const TABLE_NAME = "redirects";
const PARTITION_KEY = "qr";

if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING && !appInsights.defaultClient) {
  appInsights
    .setup(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING)
    .setAutoCollectRequests(false)
    .setAutoCollectPerformance(false)
    .start();
}
const aiClient = appInsights.defaultClient;

let tableClient;
function getTable() {
  if (!tableClient) {
    const conn = process.env.REDIRECTS_STORAGE_CONNECTION_STRING;
    if (!conn) throw new Error("REDIRECTS_STORAGE_CONNECTION_STRING is not set");
    tableClient = TableClient.fromConnectionString(conn, TABLE_NAME, {
      allowInsecureConnection: conn.includes("UseDevelopmentStorage"),
    });
  }
  return tableClient;
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
  const country = req.headers["x-azure-clientip-country"] || req.headers["cf-ipcountry"] || "";

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

  if (aiClient) {
    aiClient.trackEvent({
      name: "qr_redirect",
      properties: { id, target, found: String(found), userAgent: ua, referer, ip, country },
    });
  }

  context.res = {
    status: 302,
    headers: {
      Location: target,
      "Cache-Control": "no-store, max-age=0",
    },
  };
};
