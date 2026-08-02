// One-shot: re-download videos that have null / non-permanent video_url and
// re-host them on R2/Supabase using the bot token that owns each community's
// file_ids. Safe to re-run.
//
// Usage (from Bot backend/): node scripts/heal-null-urls.js
// Env: HEAL_CONCURRENCY (default 2)
require("dotenv").config();
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const supabase = require("../supabase");
const { uploadFile, isPermanentUrl } = require("../storage");

const BOT_TOKEN = process.env.BOT_TOKEN;
const FOXY_BOT_TOKEN = process.env.FOXY_BOT_TOKEN || "";
const WETLOOKS_BOT_TOKEN = process.env.WETLOOKS_BOT_TOKEN || "";
const CONCURRENCY = Math.max(1, parseInt(process.env.HEAL_CONCURRENCY || "2", 10));

const FOXY_COMMUNITIES = new Set(["haul", "haul2", "trans"]);
const WETLOOKS_COMMUNITIES = new Set(["wetlooks"]);

function tokenForCommunity(community) {
  if (FOXY_COMMUNITIES.has(community)) return FOXY_BOT_TOKEN || BOT_TOKEN;
  if (WETLOOKS_COMMUNITIES.has(community)) return WETLOOKS_BOT_TOKEN || BOT_TOKEN;
  return BOT_TOKEN;
}

function runCurl(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0);
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("curl timeout " + timeoutMs + "ms"));
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout = Buffer.concat([stdout, d]); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || "curl exit " + code).trim().slice(0, 140)));
    });
  });
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
    const r = await runCurl(
      ["-sS", "--max-time", "45", `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(row.file_id)}`],
      50000
    );
    info = JSON.parse(r.stdout.toString("utf8"));
  } catch (e) {
    return { ok: false, reason: "getFile: " + e.message };
  }
  if (!info.ok) return { ok: false, reason: info.description || "getFile failed" };
  if (info.result.file_size && info.result.file_size > 19 * 1024 * 1024) {
    return { ok: false, reason: "file too big for Bot API (" + info.result.file_size + " bytes)" };
  }

  const filePath = info.result.file_path;
  const tmp = path.join(os.tmpdir(), `heal_${row.id}.mp4`);
  try {
    await runCurl(
      ["-sS", "--max-time", "180", "--retry", "2", "--retry-delay", "1", "-o", tmp,
        `https://api.telegram.org/file/bot${botToken}/${filePath}`],
      200000
    );
    const buf = fs.readFileSync(tmp);
    if (!buf.length) return { ok: false, reason: "empty download" };
    let url;
    try {
      url = await uploadFile(`${row.community}/${row.file_id}.mp4`, buf, "video/mp4");
    } catch (e) {
      return { ok: false, reason: "upload: " + (e.message || e.name || String(e)).slice(0, 120) };
    }
    const { error } = await supabase.from("videos").update({ video_url: url }).eq("id", row.id);
    if (error) return { ok: false, reason: "db: " + error.message };
    return { ok: true, url, bytes: buf.length };
  } catch (e) {
    return { ok: false, reason: "download: " + e.message };
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
}

async function mapPool(items, concurrency, worker) {
  let i = 0;
  let ok = 0;
  let fail = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      const row = items[idx];
      const r = await worker(row);
      if (r.ok) {
        ok++;
        console.log(`✅ [${ok + fail}/${items.length}] ${row.community} ${row.id.slice(0, 8)} ${r.bytes} → ${r.url.slice(0, 70)}`);
      } else {
        fail++;
        console.log(`⏭️ [${ok + fail}/${items.length}] ${row.community} ${row.id.slice(0, 8)} ${r.reason}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => run()));
  return { ok, fail };
}

(async () => {
  console.log(
    "Bots: main=%s foxy=%s wetlooks=%s concurrency=%d",
    BOT_TOKEN ? "set" : "MISSING",
    FOXY_BOT_TOKEN ? "set" : "MISSING",
    WETLOOKS_BOT_TOKEN ? "set" : "MISSING",
    CONCURRENCY
  );
  const legacy = await fetchAllLegacy();
  // Prefer smaller community batches first so wetlooks/haul2 get attention
  // before a long haul run; within that, stable order by id.
  legacy.sort((a, b) => {
    const rank = (c) => (c === "wetlooks" ? 0 : c === "haul2" ? 1 : c === "trans" ? 2 : 3);
    return rank(a.community) - rank(b.community) || a.id.localeCompare(b.id);
  });
  console.log("Legacy / null-url rows:", legacy.length);
  if (!legacy.length) {
    console.log("Done. healed=0 failed=0");
    return;
  }
  const { ok, fail } = await mapPool(legacy, CONCURRENCY, healOne);
  console.log("Done. healed=%d failed=%d", ok, fail);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
