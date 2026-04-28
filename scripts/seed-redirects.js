#!/usr/bin/env node
/*
 * Seed / upsert entries in the `redirects` Azure Table.
 *
 * Usage:
 *   REDIRECTS_STORAGE_CONNECTION_STRING="DefaultEndpointsProtocol=https;..." \
 *   node scripts/seed-redirects.js
 *
 * Edit the ENTRIES array below, then run. Existing rows with the same id are overwritten.
 */
const { TableClient, odata } = require("@azure/data-tables");

const TABLE_NAME = "redirects";
const PARTITION_KEY = "qr";

const ENTRIES = [
  { id: "biz-jamie-01", target: "https://zuuka.com/?ref=biz-jamie-01", note: "Jamie business card v1" },
  { id: "biz-jake-01",  target: "https://zuuka.com/?ref=biz-jake-01",  note: "Jake business card v1" },
  { id: "biz-sam-01",   target: "https://zuuka.com/?ref=biz-sam-01",   note: "Sam business card v1" },
  { id: "biz-sally-01", target: "https://zuuka.com/?ref=biz-sally-01", note: "Sally business card v1" },
  { id: "web-li-01",    target: "https://zuuka.com/?ref=web-li-01",    note: "LinkedIn link #1" },
  { id: "fly-01",       target: "https://zuuka.com/?ref=fly-01",       note: "Flyer #1" },
];

async function main() {
  const conn = process.env.REDIRECTS_STORAGE_CONNECTION_STRING;
  if (!conn) {
    console.error("REDIRECTS_STORAGE_CONNECTION_STRING is not set");
    process.exit(1);
  }
  if (ENTRIES.length === 0) {
    console.error("ENTRIES is empty — edit scripts/seed-redirects.js first");
    process.exit(1);
  }

  const client = TableClient.fromConnectionString(conn, TABLE_NAME);
  await client.createTable().catch((e) => {
    if (e.statusCode !== 409) throw e;
  });

  for (const e of ENTRIES) {
    const id = e.id.toLowerCase();
    await client.upsertEntity(
      {
        partitionKey: PARTITION_KEY,
        rowKey: id,
        target: e.target,
        note: e.note || "",
        enabled: e.enabled !== false,
        updatedAt: new Date().toISOString(),
      },
      "Replace",
    );
    console.log(`upserted ${id} -> ${e.target}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
