// One-time migration: copy every video/thumbnail from Supabase Storage to
// Cloudflare R2 and rewrite the videos table URLs to the R2 custom domain.
//
// Usage:  node scripts/migrate-to-r2.js          (dry run — prints the plan)
//         node scripts/migrate-to-r2.js --run    (actually migrate)
//
// Needs in env (.env): SUPABASE_URL, SUPABASE_SECRET_KEY,
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
//   R2_BUCKET, R2_PUBLIC_BASE
//
// Resumable: rows whose URLs already point at R2_PUBLIC_BASE are skipped, so
// it can be re-run safely after an interruption.

require("dotenv").config({ path: __dirname + "/../.env" });
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SECRET_KEY;
const PUBLIC_BASE = (process.env.R2_PUBLIC_BASE || "").replace(/\/+$/, "");
const BUCKET = process.env.R2_BUCKET;
const RUN = process.argv.includes("--run");
const SB_MARKER = "/storage/v1/object/public/videos/";

for (const v of ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "R2_ACCOUNT_ID",
                 "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE"]) {
  if (!process.env[v]) { console.error(`Missing env: ${v}`); process.exit(1); }
}

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

function keyFromSupabaseUrl(url) {
  return decodeURIComponent(url.split(SB_MARKER)[1]);
}

function r2Url(key) {
  return `${PUBLIC_BASE}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function contentTypeFor(key) {
  if (/\.(jpg|jpeg)$/i.test(key)) return "image/jpeg";
  if (/\.png$/i.test(key)) return "image/png";
  if (/\.webm$/i.test(key)) return "video/webm";
  return "video/mp4";
}

async function fetchAllRows() {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/videos?select=id,video_url,thumbnail_url&limit=1000&offset=${offset}`,
      { headers: sbHeaders });
    const batch = await r.json();
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  return rows;
}

async function copyToR2(supabaseUrl) {
  const key = keyFromSupabaseUrl(supabaseUrl);
  const resp = await fetch(supabaseUrl);
  if (!resp.ok) throw new Error(`download ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  await r2.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: buf, ContentType: contentTypeFor(key),
  }));
  // Verify it's actually reachable through the public CDN before we commit
  const check = await fetch(r2Url(key), { method: "HEAD" });
  if (!check.ok) throw new Error(`CDN verify ${check.status}`);
  if (Number(check.headers.get("content-length")) !== buf.length)
    throw new Error(`CDN size mismatch (${check.headers.get("content-length")} != ${buf.length})`);
  return { url: r2Url(key), bytes: buf.length };
}

async function main() {
  const rows = await fetchAllRows();
  const todo = rows.filter((r) =>
    (r.video_url && r.video_url.includes(SB_MARKER)) ||
    (r.thumbnail_url && r.thumbnail_url.includes(SB_MARKER)));
  console.log(`rows: ${rows.length} | needing migration: ${todo.length} | mode: ${RUN ? "RUN" : "dry run"}`);
  if (!RUN) {
    for (const r of todo.slice(0, 3)) console.log("  e.g.", r.id, r.video_url?.slice(0, 90));
    return;
  }

  let done = 0, failed = 0, bytes = 0;
  for (const row of todo) {
    const patch = {};
    try {
      if (row.video_url && row.video_url.includes(SB_MARKER)) {
        const res = await copyToR2(row.video_url);
        patch.video_url = res.url; bytes += res.bytes;
      }
      if (row.thumbnail_url && row.thumbnail_url.includes(SB_MARKER)) {
        const res = await copyToR2(row.thumbnail_url);
        patch.thumbnail_url = res.url; bytes += res.bytes;
      }
      const upd = await fetch(`${SB_URL}/rest/v1/videos?id=eq.${row.id}`, {
        method: "PATCH",
        headers: { ...sbHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify(patch),
      });
      if (!upd.ok) throw new Error(`DB update ${upd.status}`);
      done++;
      if (done % 25 === 0) console.log(`  ${done}/${todo.length} rows, ${(bytes / 1e9).toFixed(2)} GB copied`);
    } catch (e) {
      failed++;
      console.error(`  ❌ row ${row.id}: ${e.message}`);
    }
  }
  console.log(`\nmigrated: ${done} rows (${(bytes / 1e9).toFixed(2)} GB) | failed: ${failed}`);
  console.log("Supabase files were NOT deleted — clean them up after a day of verified playback.");
}

main().catch((e) => { console.error(e); process.exit(1); });
