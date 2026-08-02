// One-shot: re-download videos that have null / non-permanent video_url and
// re-host them on R2/Supabase using the bot token that owns each community's
// file_ids. Safe to re-run.
//
// Usage (from Bot backend/): node scripts/heal-null-urls.js
require("dotenv").config();
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const supabase = require("../supabase");
const { uploadFile, isPermanentUrl } = require("../storage");

const BOT_TOKEN = process.env.BOT_TOKEN;
const FOXY_BOT_TOKEN = process.env.FOXY_BOT_TOKEN || "";
const WETLOOKS_BOT_TOKEN = process.env.WETLOOKS_BOT_TOKEN || "";

const FOXY_COMMUNITIES = new Set(["haul", "haul2", "trans"]);
const WETLOOKS_COMMUNITIES = new Set(["wetlooks"]);

function tokenForCommunity(community) {
  if (FOXY_COMMUNITIES.has(community)) return FOXY_BOT_TOKEN || BOT_TOKEN;
  if (WETLOOKS_COMMUNITIES.has(community)) return WETLOOKS_BOT_TOKEN || BOT_TOKEN;
  return BOT_TOKEN;
}

function curlJson(url) {
  const out = execFileSync("curl", ["-sS", "--max-time", "45", url], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(out);
}

function curlBinary(url, dest) {
  // Resume-capable, long timeout — Telegram CDN can be slow from this host.
  execFileSync(
    "curl",
    ["-sS", "--max-time", "300", "--retry", "3", "--retry-delay", "2", "-C", "-", "-o", dest, url],
    { maxBuffer: 10 * 1024 * 1024 }
  );
}

async function fetchAllLegacy() {
  const pageSize = 200;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("videos")
      .select("id, community, video_url, file_id")
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    rows.push(...data);
    if (data.length < pageSize) break;
  }
  return rows.filter((v) => !isPermanentUrl(v.video_url));
}

async function healOne(row) {
  const botToken = tokenForCommunity(row.community);
  if (!botToken) return { ok: false, reason: "missing bot token for " + row.community };
  if (!row.file_id) return { ok: false, reason: "no file_id" };

  let info;
  try {
    info = curlJson(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(row.file_id)}`
    );
  } catch (e) {
    return { ok: false, reason: "getFile network: " + e.message };
  }
  if (!info.ok) return { ok: false, reason: info.description || "getFile failed" };

  const filePath = info.result.file_path;
  const tmp = path.join(os.tmpdir(), `heal_${row.id}.mp4`);
  try {
    curlBinary(`https://api.telegram.org/file/bot${botToken}/${filePath}`, tmp);
    const buf = fs.readFileSync(tmp);
    if (!buf.length) return { ok: false, reason: "empty download" };
    const url = await uploadFile(`${row.community}/${row.file_id}.mp4`, buf, "video/mp4");
    const { error } = await supabase.from("videos").update({ video_url: url }).eq("id", row.id);
    if (error) return { ok: false, reason: "db: " + error.message };
    return { ok: true, url, bytes: buf.length };
  } catch (e) {
    return { ok: false, reason: e.message };
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
}

(async () => {
  console.log("Bots: main=%s foxy=%s wetlooks=%s",
    BOT_TOKEN ? "set" : "MISSING",
    FOXY_BOT_TOKEN ? "set" : "MISSING",
    WETLOOKS_BOT_TOKEN ? "set" : "MISSING"
  );
  const legacy = await fetchAllLegacy();
  console.log("Legacy / null-url rows:", legacy.length);
  let ok = 0, fail = 0;
  for (const row of legacy) {
    const r = await healOne(row);
    if (r.ok) {
      ok++;
      console.log("✅", row.community, row.id.slice(0, 8), r.bytes, "→", r.url.slice(0, 70));
    } else {
      fail++;
      console.log("⏭️", row.community, row.id.slice(0, 8), r.reason);
    }
  }
  console.log("Done. healed=%d failed=%d", ok, fail);
  process.exit(fail && !ok ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
