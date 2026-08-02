require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const supabase = require("./supabase");
const communities = require("./communities");
const geoip = require("geoip-lite");
const { uploadFile, isPermanentUrl, deleteFiles } = require("./storage");

// ─── Web Push (PWA new-video notifications) ──────────────────────────────────
const webpush = require("web-push");
const VAPID_PUBLIC = process.env.VAPID_PUBLIC;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails("mailto:admin@foxyalexx.xyz", VAPID_PUBLIC, VAPID_PRIVATE);
}
// Send a web push to every subscribed browser for a site. Dead subscriptions
// (410/404) are pruned so the list stays clean.
async function sendWebPushToAll(site, title, body, url) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
  try {
    const { data: subs } = await supabase
      .from("web_push_subs")
      .select("endpoint, subscription")
      .eq("site", site);
    if (!subs || !subs.length) return;
    const payload = JSON.stringify({ title, body, url, tag: site + "-new" });
    await Promise.all(
      subs.map((s) =>
        webpush.sendNotification(s.subscription, payload).catch((err) => {
          if (err.statusCode === 410 || err.statusCode === 404) {
            supabase.from("web_push_subs").delete().eq("endpoint", s.endpoint).then(() => {});
          }
        })
      )
    );
  } catch (e) {}
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Gumroad's Ping webhook posts form-encoded, not JSON
app.use(cors({
  origin: ["https://foxyalexx.xyz", "https://www.foxyalexx.xyz", "https://maitwerking.xyz", "https://www.maitwerking.xyz", "https://video-app-web-one.vercel.app", "http://localhost:3000"],
  methods: ["GET", "POST", "DELETE"],
}));

const BOT_TOKEN = process.env.BOT_TOKEN;
const FOXY_BOT_TOKEN = process.env.FOXY_BOT_TOKEN || "";
const WETLOOKS_BOT_TOKEN = process.env.WETLOOKS_BOT_TOKEN || "";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "Mbuki@2030.";
const APP_SECRET = process.env.APP_SECRET || "";

// file_id values are bot-scoped: only the bot that received a message can
// call getFile on it. Foxy / Wetlooks channel posts arrive on separate bots,
// so download + re-host must use that bot's token — not the main BOT_TOKEN.
const FOXY_COMMUNITIES = new Set(["haul", "haul2", "trans"]);
const WETLOOKS_COMMUNITIES = new Set(["wetlooks"]);

function tokenForCommunity(community) {
  if (FOXY_COMMUNITIES.has(community)) return FOXY_BOT_TOKEN || BOT_TOKEN;
  if (WETLOOKS_COMMUNITIES.has(community)) return WETLOOKS_BOT_TOKEN || BOT_TOKEN;
  return BOT_TOKEN;
}

function adminAuth(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (token !== ADMIN_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// First-party outbound-click log (2026-07-26). The site had NO first-party
// measurement of any kind — no analytics script, no click logging — while every
// money link carried rel="noreferrer", so neither we nor the destination could
// attribute a single one of ~2,000 outbound anchors.
//
// Registered BEFORE the x-app-secret gate on purpose: the client sends this with
// navigator.sendBeacon, which cannot set custom headers. It is write-only, takes
// no user data, and lands in the same analytics table as everything else.
// Body arrives as text/plain (a simple request, so no CORS preflight — a beacon
// can't wait for one), hence the explicit text parser.
app.post("/api/click", express.text({ type: "*/*", limit: "4kb" }), async (req, res) => {
  let p = {};
  try { p = JSON.parse(req.body || "{}"); } catch (e) {}
  const placement = String(p.placement || "unknown").slice(0, 60);
  const destination = String(p.destination || "unknown").slice(0, 40);
  const community = String(p.community || "unknown").slice(0, 40);
  const idx = Number.isFinite(p.index) ? p.index : null;
  // analytics is (event, platform, community, country) — encode the extra
  // dimensions into event/community rather than migrating the table.
  await trackEvent(
    "click_" + placement + "__" + destination,
    "web",
    community + (idx === null ? "" : "|i" + idx),
    getCountry(req)
  );
  // 204: nothing to read, and a beacon ignores the body anyway.
  res.status(204).end();
});

// Public read for the sites. Registered BEFORE the /api x-app-secret gate
// below — the front end fetches this with a plain GET and sends no headers, so
// behind the gate it answered 401 and every site silently fell back to
// "all networks on". Deliberately a SEPARATE endpoint from
// /api/settings, which dumps every settings row: the ad switches are the only
// part the front end needs, and a narrow endpoint cannot leak a future secret
// that someone stores in that table.
// ─── In-app ad platform switches (2026-07-28) ─────────────────────────────
// SEPARATE from the ads_<network> switches, which govern the WEBSITES. These
// control ad surfaces that appear inside the Android apps, per app, so a new
// in-app format can be cut without touching the sites — and vice versa.
//
// Keys are app_ads_<app>_<platform>:
//   app_ads_foxy_overlay  — boostapp.me interstitial in the Foxy Alexx app
//   app_ads_mai_overlay   — same format in the Twerking Mai app (different tid)
// Absent means ON, so a platform that has never been toggled behaves as enabled.
//
// The apps read /api/app-ads at launch and honour it before showing anything, so
// flipping a switch here reaches installed apps without a new APK.
const APP_AD_PLATFORMS = ["foxy_overlay", "mai_overlay"];

function appAdKey(p) { return "app_ads_" + p; }

async function readAppAds() {
  const { data } = await supabase.from("settings").select("key, value").in("key", APP_AD_PLATFORMS.map(appAdKey));
  const map = {};
  (data || []).forEach((r) => { map[r.key] = r.value; });
  const out = {};
  APP_AD_PLATFORMS.forEach((p) => { out[p] = map[appAdKey(p)] !== "false"; });
  return out;
}

// Public read for the apps. Registered before the /api x-app-secret gate for the
// same reason /api/click and /api/ad-networks are: the client sends no headers.
app.get("/api/app-ads", async (req, res) => {
  try {
    const out = await readAppAds();
    res.set("Cache-Control", "public, max-age=60");
    res.json(out);
  } catch (e) {
    // Fail OPEN on a read error, matching the sites' behaviour: a database blip
    // must not silently disable every in-app ad.
    const out = {};
    APP_AD_PLATFORMS.forEach((p) => { out[p] = true; });
    res.json(out);
  }
});

app.get("/api/ad-networks", async (req, res) => {
  const { data } = await supabase.from("settings").select("key, value").in("key", AD_NETWORKS.map((n) => "ads_" + n));
  const map = {};
  (data || []).forEach((r) => { map[r.key] = r.value; });
  const out = {};
  AD_NETWORKS.forEach((n) => { out[n] = map["ads_" + n] !== "false"; });
  res.set("Cache-Control", "public, max-age=60");
  res.json(out);
});

app.use("/api", (req, res, next) => {
  const secret = req.headers["x-app-secret"];
  if (APP_SECRET && secret !== APP_SECRET) return res.status(403).json({ error: "Unauthorized" });
  next();
});

async function trackEvent(event, platform, community, country) {
  try {
    await supabase.from("analytics").insert({ event, platform, community, country });
  } catch (e) {}
}

// Resolve the client's country. CDN headers only exist behind Cloudflare —
// traffic reaches Railway directly, so fall back to a geoip-lite lookup on
// the client IP (first hop of x-forwarded-for, set by Railway's proxy).
function getCountry(req) {
  const hdr = req.headers["cf-ipcountry"] || req.headers["x-vercel-ip-country"] || req.headers["x-country"];
  if (hdr && hdr !== "XX" && hdr !== "unknown") return hdr;
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "";
  const geo = ip ? geoip.lookup(ip) : null;
  return geo?.country || "unknown";
}

// Supabase caps each select at 1000 rows, which silently truncated /admin/stats
// (views, countries and the whole ad funnel read as 0 once the table grew).
// Page through the table instead.
async function fetchAllRows(table, columns) {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + pageSize - 1);
    if (error || !data || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
  }
  return rows;
}

async function registerWebhook() {
  const BASE_URL = process.env.WEBHOOK_URL;
  if (!BASE_URL) {
    console.error("❌ WEBHOOK_URL is not set — cannot register Telegram webhooks");
    return;
  }

  // Main bot (Twerking Mai)
  const r1 = await fetch(`${TELEGRAM_API}/setWebhook?url=${BASE_URL}/webhook`);
  const d1 = await r1.json();
  console.log(d1.ok ? `✅ Main webhook registered` : `❌ Main webhook failed: ${d1.description}`);

  // Foxy Alexx bot
  if (FOXY_BOT_TOKEN) {
    const FOXY_API = `https://api.telegram.org/bot${FOXY_BOT_TOKEN}`;
    const r2 = await fetch(`${FOXY_API}/setWebhook?url=${BASE_URL}/webhook/foxy`);
    const d2 = await r2.json();
    console.log(d2.ok ? `✅ Foxy webhook registered` : `❌ Foxy webhook failed: ${d2.description}`);
  } else {
    console.warn("⚠️ Skipping Foxy webhook registration — FOXY_BOT_TOKEN not set");
  }

  // Wetlooks bot
  if (WETLOOKS_BOT_TOKEN) {
    const WETLOOKS_API = `https://api.telegram.org/bot${WETLOOKS_BOT_TOKEN}`;
    const r3 = await fetch(`${WETLOOKS_API}/setWebhook?url=${BASE_URL}/webhook/wetlooks`);
    const d3 = await r3.json();
    console.log(d3.ok ? `✅ Wetlooks webhook registered` : `❌ Wetlooks webhook failed: ${d3.description}`);
  } else {
    console.warn("⚠️ Skipping Wetlooks webhook registration — WETLOOKS_BOT_TOKEN not set");
  }
}

async function tgGetFile(file_id, botToken = BOT_TOKEN) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${file_id}`);
    return await res.json();
  } catch (e) {
    return { ok: false, description: e.message };
  }
}

async function getFreshVideoUrl(file_id, botToken = BOT_TOKEN) {
  const data = await tgGetFile(file_id, botToken);
  if (!data.ok) return null;
  return `https://api.telegram.org/file/bot${botToken}/${data.result.file_path}`;
}

// Telegram's Bot API caps file downloads at 20MB and returns a hard error for
// anything bigger ("file is too big") — that is NOT the same as the file being
// gone, and must never be treated as such by callers deciding whether to delete
// a row. gone=true only for errors that mean Telegram no longer has this file.
function isFileGoneFromTelegram(getFileResponse) {
  const desc = (getFileResponse.description || "").toLowerCase();
  return desc.includes("file not found") || desc.includes("wrong file_id") || desc.includes("file_id is invalid");
}

async function downloadTelegramFile(file_id, botToken = BOT_TOKEN) {
  if (!botToken) {
    return { buffer: null, gone: false, reason: "missing bot token" };
  }
  const fileInfo = await tgGetFile(file_id, botToken);
  if (!fileInfo.ok) return { buffer: null, gone: isFileGoneFromTelegram(fileInfo), reason: fileInfo.description };
  try {
    const res = await fetch(`https://api.telegram.org/file/bot${botToken}/${fileInfo.result.file_path}`);
    if (!res.ok) return { buffer: null, gone: res.status === 404, reason: `HTTP ${res.status}` };
    return { buffer: Buffer.from(await res.arrayBuffer()), gone: false, reason: null };
  } catch (e) {
    return { buffer: null, gone: false, reason: e.message };
  }
}

function extensionFromMime(mime, fallback) {
  if (!mime) return fallback;
  const part = mime.split("/")[1];
  return part ? part.split(";")[0] : fallback;
}

// Downloads the video (and thumbnail) from Telegram once and re-hosts them in
// permanent storage (R2 / Supabase), so playback no longer depends on expiring
// Telegram file links — and so the browser can play them at all (Telegram CDN
// URLs are not a usable public video source for the web reels).
// botToken is required when the file arrived on a non-main bot (Foxy / Wetlooks).
async function persistVideoAssets(community, file_id, thumbnail_file_id, mimeType, botToken = BOT_TOKEN) {
  const result = { video_url: null, thumbnail_url: null };

  const video = await downloadTelegramFile(file_id, botToken);
  if (video.buffer) {
    try {
      const ext = extensionFromMime(mimeType, "mp4");
      result.video_url = await uploadFile(`${community}/${file_id}.${ext}`, video.buffer, mimeType || "video/mp4");
    } catch (e) {
      console.error("❌ Video upload to storage failed:", e.message);
    }
  } else if (video.reason) {
    console.log(`⚠️ Could not fetch video ${file_id}: ${video.reason}`);
  }

  if (thumbnail_file_id) {
    const thumb = await downloadTelegramFile(thumbnail_file_id, botToken);
    if (thumb.buffer) {
      try {
        result.thumbnail_url = await uploadFile(`${community}/${file_id}_thumb.jpg`, thumb.buffer, "image/jpeg");
      } catch (e) {
        console.error("❌ Thumbnail upload to storage failed:", e.message);
      }
    }
  }

  return result;
}

// One-off (self-repeating) migration for videos saved before permanent storage
// existed — including Foxy/Wetlooks rows that were inserted with null
// video_url (temporary Telegram URL path, or getFile failures that still
// wrote a row). Uses the bot token that owns each community's file_ids.
// A row is only ever removed via the admin route — never auto-deleted here.
async function migrateLegacyVideos() {
  const { data: videos } = await supabase.from("videos").select("id, community, video_url, file_id");
  if (!videos) return;
  const legacy = videos.filter((v) => !isPermanentUrl(v.video_url));
  if (legacy.length === 0) return;

  console.log(`🔄 Migrating ${legacy.length} legacy video(s) to permanent storage...`);
  let migrated = 0, skipped = 0;
  for (const video of legacy) {
    const botToken = tokenForCommunity(video.community);
    const file = await downloadTelegramFile(video.file_id, botToken);
    if (!file.buffer) {
      // 2026-07-16: NEVER auto-delete rows. Previously a Telegram-confirmed
      // "file gone" pruned the row — but source channels deleting old posts
      // (and past outages) wiped real content. The user prefers keeping a
      // stale row (worst case a non-playing legacy video) over ever losing
      // one. Just skip and retry next cycle; remove only via the admin route.
      skipped++;
      console.log(`⏭️ Skipping ${video.id} [${video.community}] — not deleting (${file.reason})`);
      continue;
    }
    try {
      const url = await uploadFile(`${video.community}/${video.file_id}.mp4`, file.buffer, "video/mp4");
      await supabase.from("videos").update({ video_url: url }).eq("id", video.id);
      migrated++;
      console.log(`✅ Migrated ${video.id} [${video.community}] → ${url.slice(0, 80)}`);
    } catch (e) {
      console.error(`❌ Migration upload failed for ${video.id}:`, e.message);
    }
  }
  console.log(`✅ Migration done — migrated ${migrated}, skipped ${skipped} (auto-delete disabled)`);
}

async function sendPushToAll(title, body, data = {}) {
  const { data: tokens } = await supabase.from("push_tokens").select("push_token");
  if (!tokens || tokens.length === 0) {
    console.log("📵 No push tokens registered");
    return;
  }
  const messages = tokens.map(t => ({ to: t.push_token, sound: "default", title, body, data }));
  const chunks = [];
  for (let i = 0; i < messages.length; i += 100) chunks.push(messages.slice(i, i + 100));
  for (const chunk of chunks) {
    try {
      await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json", "Accept-Encoding": "gzip, deflate" },
        body: JSON.stringify(chunk),
      });
    } catch (e) { console.error("Push send error:", e.message); }
  }
  console.log(`📲 Sent push to ${messages.length} devices`);
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  const message = update.channel_post;
  if (!message || !message.video) return;
  const chatId = String(message.chat.id);
  const community = communities[chatId];
  if (!community) { console.log(`⚠️ Unknown channel: ${chatId}`); return; }
  const video = message.video;
  const file_id = video.file_id;
  const caption = message.caption || "";
  const thumbnail_file_id = video.thumbnail?.file_id || null;

  const { data: existing } = await supabase
    .from("videos")
    .select("id")
    .eq("file_id", file_id)
    .eq("community", community)
    .maybeSingle();

  if (existing) {
    console.log(`⚠️ Duplicate video skipped: ${file_id}`);
    return;
  }

  console.log(`🎬 New video in [${community}]`);
  const { video_url, thumbnail_url } = await persistVideoAssets(community, file_id, thumbnail_file_id, video.mime_type);
  if (!video_url) {
    console.error(`❌ Could not persist video ${file_id} to storage — skipping save`);
    return;
  }
  const { error } = await supabase.from("videos").insert({ community, file_id, video_url, thumbnail_url, caption });
  if (error) {
    console.error("❌ Supabase error:", error.message);
  } else {
    console.log(`✅ Saved → community: ${community}`);
    // Route the "new video" push to the right SITE (a community may now belong
    // to twerking-mai after the 2026-07-16 rewire — don't blast a Foxy-branded
    // app push for maitwerking/maitrending content).
    const communityLabels = {
      haul: "Femboys", haul2: "Trending", trans: "Trans",
      maitwerking: "Mai Twerking", maitrending: "Trending", wetlooks: "WET💦LOOKS",
    };
    const label = communityLabels[community] || community;
    if (siteOf(community) === "maitwerking") {
      sendWebPushToAll(
        "maitwerking",
        "New video on Twerking Mai 🍑",
        `Fresh content in ${label} — tap to watch`,
        `/community/${community}`
      );
    } else {
      sendPushToAll(
        "🦊 New video on Foxy Alexx!",
        `Fresh content just dropped in ${label}`,
        { community, label, emoji: community === "haul" ? "🌸" : "🔥" }
      );
    }
  }
});
// Foxy Alexx bot webhook
// 2026-08-02 fix: previously stored temporary Telegram file URLs (or null when
// getFile failed) and still inserted the row. The web feed then listed videos
// with no playable src. Mirror the main webhook: download via FOXY_BOT_TOKEN,
// re-host to permanent storage, skip insert if that fails.
app.post("/webhook/foxy", async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  const message = update.channel_post;
  if (!message || !message.video) return;
  const chatId = String(message.chat.id);
  const community = communities[chatId];
  if (!community) { console.log(`⚠️ Foxy webhook — Unknown channel: ${chatId}`); return; }
  if (!FOXY_BOT_TOKEN) {
    console.error("❌ Foxy webhook — FOXY_BOT_TOKEN is not set; cannot download file_ids");
    return;
  }
  const video = message.video;
  const file_id = video.file_id;
  const caption = message.caption || "";
  const thumbnail_file_id = video.thumbnail?.file_id || null;

  const { data: existing } = await supabase
    .from("videos").select("id").eq("file_id", file_id).eq("community", community).maybeSingle();
  if (existing) { console.log(`⚠️ Foxy duplicate skipped: ${file_id}`); return; }

  console.log(`🎬 Foxy webhook — New video in [${community}]`);
  const { video_url, thumbnail_url } = await persistVideoAssets(
    community, file_id, thumbnail_file_id, video.mime_type, FOXY_BOT_TOKEN
  );
  if (!video_url) {
    console.error(`❌ Foxy — could not persist video ${file_id} to storage — skipping save`);
    return;
  }
  const { error } = await supabase.from("videos").insert({ community, file_id, video_url, thumbnail_url, caption });
  if (error) console.error("❌ Supabase error:", error.message);
  else {
    console.log(`✅ Foxy saved → community: ${community}`);
    const communityLabels = { haul: "Femboys", haul2: "Trending", trans: "Trans" };
    sendPushToAll(`🦊 New video on Foxy Alexx!`, `Fresh content in ${communityLabels[community] || community}`, { community });
  }
});

// Wetlooks bot webhook — same permanent-storage path as main/Foxy.
app.post("/webhook/wetlooks", async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  const message = update.channel_post;
  if (!message || !message.video) return;
  const chatId = String(message.chat.id);
  const community = communities[chatId];
  if (!community) { console.log(`⚠️ Wetlooks webhook — Unknown channel: ${chatId}`); return; }
  if (!WETLOOKS_BOT_TOKEN) {
    console.error("❌ Wetlooks webhook — WETLOOKS_BOT_TOKEN is not set; cannot download file_ids");
    return;
  }
  const video = message.video;
  const file_id = video.file_id;
  const caption = message.caption || "";
  const thumbnail_file_id = video.thumbnail?.file_id || null;

  const { data: existing } = await supabase
    .from("videos").select("id").eq("file_id", file_id).eq("community", community).maybeSingle();
  if (existing) { console.log(`⚠️ Wetlooks duplicate skipped: ${file_id}`); return; }

  console.log(`🎬 Wetlooks webhook — New video in [${community}]`);
  const { video_url, thumbnail_url } = await persistVideoAssets(
    community, file_id, thumbnail_file_id, video.mime_type, WETLOOKS_BOT_TOKEN
  );
  if (!video_url) {
    console.error(`❌ Wetlooks — could not persist video ${file_id} to storage — skipping save`);
    return;
  }
  const { error } = await supabase.from("videos").insert({ community, file_id, video_url, thumbnail_url, caption });
  if (error) console.error("❌ Supabase error:", error.message);
  else {
    console.log(`✅ Wetlooks saved → community: ${community}`);
    sendWebPushToAll(
      "maitwerking",
      "New video on Twerking Mai 🍑",
      "Fresh content in WET💦LOOKS — tap to watch",
      `/community/${community}`
    );
  }
});

// Gumroad's "Ping" notification — form-encoded POST, no signature to verify (Gumroad's
// basic Ping feature doesn't support HMAC signing like Stripe does). Handles both new
// sales and refund/dispute notifications for the same sale_id.
app.post("/webhook/gumroad", async (req, res) => {
  res.sendStatus(200); // ack immediately, same pattern as the Telegram webhook
  const body = req.body || {};
  const sale_id = body.sale_id;
  const email = body.email;
  if (!sale_id || !email) {
    console.log("⚠️ Gumroad ping missing sale_id/email:", JSON.stringify(body).slice(0, 200));
    return;
  }

  const isRefundEvent = body.refunded === "true" || body.refunded === true || body.resource_name === "refund";

  if (isRefundEvent) {
    await supabase.from("gumroad_purchases").update({ refunded: true }).eq("sale_id", sale_id);
    console.log(`↩️ Gumroad refund recorded for sale ${sale_id}`);
    return;
  }

  const { error } = await supabase.from("gumroad_purchases").upsert({
    sale_id,
    email: String(email).toLowerCase(),
    product_permalink: body.product_permalink || null,
    refunded: false,
  }, { onConflict: "sale_id" });

  if (error) console.error("❌ Gumroad purchase save error:", error.message);
  else console.log(`💰 Gumroad purchase recorded: ${email}`);
});

app.post("/api/verify-purchase", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Missing email" });

  const { data, error } = await supabase
    .from("gumroad_purchases")
    .select("id")
    .eq("email", String(email).toLowerCase())
    .eq("refunded", false)
    .limit(1);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ verified: (data?.length || 0) > 0 });
});

app.get("/", (req, res) => res.json({ status: "ok", message: "Foxy Alexx bot running 🚀" }));

// 2026-07-26: optional pagination. The web feed was shipping ~1089 rows in one
// ~1.7s response and rendering all of them. limit/offset/order are ADDITIVE —
// with no params the response is byte-for-byte what it always was, so the
// Android app and any older web deploy keep working unchanged.
//   ?limit=30&offset=0&order=asc
// order=asc is what the web feed uses: oldest-first means new videos land at
// the tail, so an index never shifts under a viewer mid-session.
app.get("/api/videos/:community", async (req, res) => {
  const country = getCountry(req);
  trackEvent("page_view", "web", req.params.community, country);

  const rawLimit = parseInt(req.query.limit, 10);
  const rawOffset = parseInt(req.query.offset, 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : null;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  const ascending = req.query.order === "asc";

  let q = supabase
    .from("videos")
    .select("*")
    .eq("community", req.params.community)
    // Hide rows that never got a permanent URL (Foxy/Wetlooks bug before 2026-08-02).
    // Those rows still exist for migrateLegacyVideos to heal; the feed just shouldn't
    // render empty players for them.
    .not("video_url", "is", null)
    .order("created_at", { ascending });
  if (limit !== null) q = q.range(offset, offset + limit - 1);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  // Defence in depth: also drop empty-string / non-http URLs if any slipped in.
  const videos = (data || []).filter((v) => v.video_url && /^https?:\/\//i.test(v.video_url));
  res.json({ videos });
});

function rotateVideos(videos) {
  const day = new Date().getDay(); // 0=Sun,1=Mon,2=Tue,3=Wed,4=Thu,5=Fri,6=Sat
  const len = videos.length;
  if (len === 0) return videos;

  if (day === 1 || day === 2) {
    // Mon/Tue — reverse (oldest first)
    return [...videos].reverse();
  }
  if (day === 3 || day === 4) {
    // Wed/Thu — middle to back
    const mid = Math.floor(len / 2);
    return [...videos.slice(mid), ...videos.slice(0, mid)];
  }
  if (day === 5 || day === 6) {
    // Fri/Sat — middle to front then back
    const mid = Math.floor(len / 2);
    return [...videos.slice(mid), ...videos.slice(0, mid)].reverse();
  }
  // Sun — normal
  return videos;
}

app.get("/api/videos", async (req, res) => {
  const country = getCountry(req);
  // Only real app launches count as app_open — the sites' home pages fetch
  // this same endpoint for their preview cards, and those browser fetches
  // always carry an Origin/Referer (cross-origin), while the app's native
  // fetch carries neither. The app (v1.1.1+) also sends x-device-id
  // (androidId); it's stored in the community column — the analytics table
  // has no device column and app_open rows never used community anyway —
  // so /admin/stats can count distinct real devices.
  const fromBrowser = !!(req.headers.origin || req.headers.referer);
  if (fromBrowser) {
    trackEvent("home_view", "web", "all", country);
  } else {
    trackEvent("app_open", "mobile", req.headers["x-device-id"] || "all", country);
  }
  const { data, error } = await supabase
    .from("videos")
    .select("*")
    .not("video_url", "is", null)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  const videos = (data || []).filter((v) => v.video_url && /^https?:\/\//i.test(v.video_url));
  res.json({ videos: rotateVideos(videos) });
});

app.get("/api/settings", async (req, res) => {
  const { data, error } = await supabase.from("settings").select("*");
  if (error) return res.status(500).json({ error: error.message });
  const settings = {};
  data.forEach((row) => { settings[row.key] = row.value; });
  res.json(settings);
});

app.post("/api/push-token", async (req, res) => {
  const { push_token, platform } = req.body;
  if (!push_token) return res.status(400).json({ error: "Missing push_token" });
  try {
    await supabase.from("push_tokens").upsert({ push_token, platform }, { onConflict: "push_token" });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Store a browser's web-push subscription (PWA). Keyed on endpoint so the same
// browser re-subscribing just updates its row.
app.post("/api/push/subscribe", async (req, res) => {
  const { subscription, site } = req.body || {};
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: "Missing subscription" });
  try {
    await supabase.from("web_push_subs").upsert(
      { endpoint: subscription.endpoint, subscription, site: site || "foxyalexx" },
      { onConflict: "endpoint" }
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/track", async (req, res) => {
  const { event, platform, community, country } = req.body;
  // The web app hardcodes country:"unknown" — resolve it server-side instead.
  const resolved = country && country !== "unknown" ? country : getCountry(req);
  await trackEvent(event || "unknown", platform || "unknown", community || "unknown", resolved);
  res.json({ success: true });
});

app.post("/api/videos/:id/like", async (req, res) => {
  const { id } = req.params;
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ error: "Missing session_id" });

  const { data: existing } = await supabase
    .from("likes")
    .select("id")
    .eq("video_id", id)
    .eq("session_id", session_id)
    .single();

  if (existing) {
    await supabase.from("likes").delete().eq("video_id", id).eq("session_id", session_id);
    await supabase.rpc("decrement_likes", { video_id: id });
    return res.json({ liked: false });
  }

  await supabase.from("likes").insert({ video_id: id, session_id });
  const { data: vid } = await supabase.from("videos").select("likes_count").eq("id", id).single();
  await supabase.from("videos").update({ likes_count: (vid?.likes_count || 0) + 1 }).eq("id", id);
  res.json({ liked: true });
});

app.get("/api/videos/:id/likes", async (req, res) => {
  const { data } = await supabase.from("likes").select("id").eq("video_id", req.params.id);
  res.json({ count: data?.length || 0 });
});

function dayKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function last7DayKeys() {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    days.push(dayKey(new Date(Date.now() - i * 86400000)));
  }
  return days;
}

// ─── TEMPORARY: server-side R2 migration (remove after the cutover) ──────────
// Copies every Supabase-hosted video/thumbnail to R2 and rewrites the row,
// using Railway's datacenter bandwidth instead of a home connection.
// POST starts it (idempotent — skips rows already on R2); GET reports progress.
const SB_STORAGE_MARKER = "/storage/v1/object/public/videos/";
let r2Migration = { running: false, total: 0, done: 0, failed: 0, errors: [] };

async function migrateRowToR2(row) {
  const { uploadFile } = require("./storage");
  const patch = {};
  for (const col of ["video_url", "thumbnail_url"]) {
    const u = row[col];
    if (!u || !u.includes(SB_STORAGE_MARKER)) continue;
    const key = decodeURIComponent(u.split(SB_STORAGE_MARKER)[1]);
    const resp = await fetch(u);
    if (!resp.ok) throw new Error(`download ${resp.status}`);
    const buf = await resp.buffer();
    const ct = /\.(jpe?g)$/i.test(key) ? "image/jpeg" : /\.webm$/i.test(key) ? "video/webm" : "video/mp4";
    const newUrl = await uploadFile(key, buf, ct);
    const check = await fetch(newUrl, { method: "HEAD" });
    if (!check.ok || Number(check.headers.get("content-length")) !== buf.length)
      throw new Error(`CDN verify failed for ${key}`);
    patch[col] = newUrl;
  }
  if (Object.keys(patch).length) {
    const { error } = await supabase.from("videos").update(patch).eq("id", row.id);
    if (error) throw new Error(`DB update: ${error.message}`);
  }
}

// Force a pass of the legacy → permanent-storage migrator (null / Telegram URLs).
// Safe to call repeatedly; only heals rows that still lack a permanent URL.
app.post("/admin/migrate-legacy", adminAuth, async (req, res) => {
  res.json({ started: true, message: "Legacy migration started in background" });
  try {
    await migrateLegacyVideos();
  } catch (e) {
    console.error("❌ migrate-legacy failed:", e.message);
  }
});

app.post("/admin/migrate-r2", adminAuth, async (req, res) => {
  if (!process.env.R2_BUCKET) return res.status(400).json({ error: "R2 env vars not set" });
  if (r2Migration.running) return res.json({ already_running: true, ...r2Migration });

  const { data: rows, error } = await supabase
    .from("videos").select("id, video_url, thumbnail_url")
    .or(`video_url.like.%${SB_STORAGE_MARKER}%,thumbnail_url.like.%${SB_STORAGE_MARKER}%`)
    .limit(2000);
  if (error) return res.status(500).json({ error: error.message });

  r2Migration = { running: true, total: rows.length, done: 0, failed: 0, errors: [] };
  res.json({ started: true, total: rows.length });

  const CONCURRENCY = 4;
  let idx = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (idx < rows.length) {
      const row = rows[idx++];
      try {
        await migrateRowToR2(row);
        r2Migration.done++;
      } catch (e) {
        r2Migration.failed++;
        if (r2Migration.errors.length < 20) r2Migration.errors.push(`${row.id}: ${e.message}`);
      }
    }
  }));
  r2Migration.running = false;
  console.log(`🚚 R2 migration finished: ${r2Migration.done} ok, ${r2Migration.failed} failed`);
});

app.get("/admin/migrate-r2", adminAuth, (req, res) => res.json(r2Migration));

// ─── Video transcode to 480p ────────────────────────────────────────────────
// Source clips are 1080p ~3.3 Mbps masters (7+ MB for 18s) being served to a
// phone-sized reel feed — the cause of the FluidPlayer playback timeouts.
// Re-encodes to 480p (~1/7th the bytes) on Railway's bandwidth and CPU.
//
// Originals are preserved: the compressed file goes to a separate "c480/" key
// and only the DB row is repointed, so a bad batch is undone by restoring
// video_url. POST starts, GET reports progress. Idempotent — rows already
// pointing at c480/ are skipped, so it is safe to re-run after a crash.
//
// Thumbnails are untouched (they are already small).
let transcodeJob = { running: false, total: 0, done: 0, skipped: 0, failed: 0, savedBytes: 0, errors: [] };

async function transcodeRow(row) {
  const { uploadFile } = require("./storage");
  const tc = require("./transcode");
  const url = row.video_url;
  if (!url || tc.isTranscoded(url)) { transcodeJob.skipped++; return; }

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`download ${resp.status}`);
  const buf = await resp.buffer();

  if (buf.length < tc.MIN_BYTES) { transcodeJob.skipped++; return; }

  const out = await tc.encodeBuffer(buf);
  // null = the encode came out no smaller than the source. Leave the row alone.
  if (!out) { transcodeJob.skipped++; return; }

  const key = tc.compressedKeyFor(url);
  const newUrl = await uploadFile(key, out, "video/mp4");

  // Verify the CDN really has it at the expected length before repointing the
  // row — the same guard the R2 migration uses.
  const check = await fetch(newUrl, { method: "HEAD" });
  if (!check.ok || Number(check.headers.get("content-length")) !== out.length)
    throw new Error(`CDN verify failed for ${key}`);

  const { error } = await supabase.from("videos").update({ video_url: newUrl }).eq("id", row.id);
  if (error) throw new Error(`DB update: ${error.message}`);

  transcodeJob.savedBytes += buf.length - out.length;
  transcodeJob.done++;
}

// PAUSED BY DEFAULT (2026-07-28). Transcoding is lossy and one-way, and the
// masters it relied on being able to fall back to are gone: every one of the 44
// rows already repointed to c480/ has NO surviving original — the Supabase→R2
// migration's orphan cleanup removed them. So a re-run cannot be undone, at all.
//
// The job now refuses to start unless settings.transcode_enabled is explicitly
// "true". Absent or anything else = paused, which is the safe default for a
// destructive one-way operation that nothing schedules automatically.
app.post("/admin/transcode", adminAuth, async (req, res) => {
  const { data: flag } = await supabase.from("settings").select("value").eq("key", "transcode_enabled").maybeSingle();
  if (flag?.value !== "true") {
    return res.status(423).json({
      error: "Transcoding is paused",
      hint: "Set settings.transcode_enabled to \"true\" to allow it. It is off by default because the re-encode is one-way and the original masters no longer exist.",
    });
  }
  if (transcodeJob.running) return res.json({ already_running: true, ...transcodeJob });

  const limit = Math.min(Number(req.query.limit) || 500, 2000);
  const { data: rows, error } = await supabase
    .from("videos").select("id, video_url")
    .not("video_url", "is", null)
    .not("video_url", "like", `%/${require("./transcode").PREFIX}%`)
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });

  transcodeJob = { running: true, total: rows.length, done: 0, skipped: 0, failed: 0, savedBytes: 0, errors: [] };
  res.json({ started: true, total: rows.length });

  // ffmpeg is CPU-bound and Railway containers are small — 2 at a time. Higher
  // concurrency just thrashes and risks the container's memory limit.
  const CONCURRENCY = 2;
  let idx = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (idx < rows.length) {
      const row = rows[idx++];
      try {
        await transcodeRow(row);
      } catch (e) {
        transcodeJob.failed++;
        if (transcodeJob.errors.length < 20) transcodeJob.errors.push(`${row.id}: ${e.message}`);
      }
    }
  }));
  transcodeJob.running = false;
  console.log(`🎬 transcode finished: ${transcodeJob.done} ok, ${transcodeJob.skipped} skipped, ${transcodeJob.failed} failed, ${(transcodeJob.savedBytes / 1e9).toFixed(2)} GB saved`);
});

app.get("/admin/transcode", adminAuth, (req, res) => res.json({
  ...transcodeJob,
  savedGB: +(transcodeJob.savedBytes / 1e9).toFixed(2),
}));

// Which site a community (or analytics row) belongs to. Foxy Alexx and Mai
// Twerking share this backend/DB but must never be mixed in reporting.
// Legacy/site-wide rows ("site", "all", device ids from app_open) belong to
// foxyalexx — the app and its tracking are Foxy Alexx's.
const MAI_COMMUNITIES = new Set(["maitwerking", "maitrending", "wetlooks"]);
function siteOf(community) {
  return MAI_COMMUNITIES.has(community) ? "maitwerking" : "foxyalexx";
}

// Full stats block for one site's videos + analytics rows.
function summarizeSite(videos, analytics) {
  const communityCount = {};
  videos.forEach((v) => { communityCount[v.community] = (communityCount[v.community] || 0) + 1; });
  const mostActive = Object.entries(communityCount).sort((a, b) => b[1] - a[1])[0];
  const countries = {};
  analytics.forEach(a => { if (a.country && a.country !== "unknown") countries[a.country] = (countries[a.country] || 0) + 1; });

  const days = last7DayKeys();
  const viewsByDay = Object.fromEntries(days.map(d => [d, 0]));
  analytics.forEach(a => { const k = dayKey(a.created_at); if (k in viewsByDay) viewsByDay[k]++; });
  const videosByDay = Object.fromEntries(days.map(d => [d, 0]));
  videos.forEach(v => { const k = dayKey(v.created_at); if (k in videosByDay) videosByDay[k]++; });

  const adAttempts = analytics.filter(a => a.event === "vast_attempt").length;
  const adFilled = analytics.filter(a => a.event === "vast_filled").length;

  return {
    total_videos: videos.length,
    videos_by_community: communityCount,
    most_active_community: mostActive ? mostActive[0] : "none",
    total_views: analytics.length,
    // APK link clicks for this site (2026-07-28). The real "downloads" figure we
    // can actually measure: /api/click logs every APK anchor with
    // destination=apk, so the event name ends in "__apk". This is the honest
    // metric for maitwerking, whose app carries NO open/version tracking at all —
    // its mobile_views is structurally near-zero, not genuinely low.
    app_downloads: analytics.filter(a => typeof a.event === "string" && a.event.startsWith("click_") && a.event.endsWith("__apk")).length,
    views_today: analytics.filter(a => new Date(a.created_at) > new Date(Date.now() - 86400000)).length,
    web_views: analytics.filter(a => a.platform === "web").length,
    mobile_views: analytics.filter(a => a.platform === "mobile").length,
    top_countries: Object.entries(countries).sort((a, b) => b[1] - a[1]).slice(0, 5),
    top_videos: [...videos]
      .sort((a, b) => (b.likes_count || 0) - (a.likes_count || 0))
      .slice(0, 5)
      .map(v => ({ id: v.id, community: v.community, caption: v.caption, likes_count: v.likes_count || 0 })),
    views_last_7_days: viewsByDay,
    videos_last_7_days: videosByDay,
    ad_funnel: {
      attempts: adAttempts,
      filled: adFilled,
      errors: analytics.filter(a => a.event === "vast_error").length,
      empty: analytics.filter(a => a.event === "vast_empty").length,
      fill_rate: adAttempts > 0 ? Math.round((adFilled / adAttempts) * 100) : 0,
      // The web app sent "lock_popunder" for a while; count both names.
      popunder_fires: analytics.filter(a => a.event === "popunder_fired" || a.event === "lock_popunder").length,
    },
  };
}

app.get("/admin/stats", adminAuth, async (req, res) => {
  const videos = await fetchAllRows("videos", "id, community, caption, likes_count, created_at");
  const users = await fetchAllRows("users", "id");
  const analytics = await fetchAllRows("analytics", "*");
  const appOpens = analytics.filter(a => a.event === "app_open");
  // Real unique devices: app_open rows carry the device's androidId in the
  // community column (v1.1.1+). Legacy rows ("all") predate device ids and
  // web-home pollution, so they can't be de-duplicated — reported separately
  // as app_opens_total.
  const uniqueUsers = new Set(
    appOpens.map(a => a.community).filter(c => c && c !== "all")
  ).size;

  // Per-site split — Foxy Alexx and Mai Twerking are reported separately so
  // each site's performance is followable on its own.
  const sites = {};
  for (const site of ["foxyalexx", "maitwerking"]) {
    // baseCommunity() strips the "|i<feedIndex>" suffix that /api/click writes
    // into the community column. Without it every indexed click row fell through
    // to the foxyalexx default, so maitwerking's clicks were reported under
    // foxyalexx from 2026-07-26 (when click logging landed) until 07-27.
    sites[site] = summarizeSite(
      (videos || []).filter(v => siteOf(v.community) === site),
      (analytics || []).filter(a => siteOf(baseCommunity(a.community)) === site)
    );
  }
  // The app (and its device-id app_open rows) is Foxy Alexx's.
  sites.foxyalexx.app_users = uniqueUsers;
  sites.foxyalexx.app_opens_total = appOpens.length;

  // Network-wide legacy fields kept so older admin clients don't break.
  const combined = summarizeSite(videos || [], analytics || []);
  res.json({
    sites,
    app_users: uniqueUsers,
    app_opens_total: appOpens.length,
    total_users: users?.length || 0,
    ...combined,
  });
});

// ─── Outbound-click report (2026-07-27) ───────────────────────────────────
// Reads back what POST /api/click has been writing since 07-26. Those rows land
// in `analytics` encoded as:
//     event     = "click_<placement>__<destination>"
//     community = "<community>"  or  "<community>|i<feedIndex>"
// so the report has to decode both. NOTE the community suffix: siteOf() must be
// given the BASE community or every indexed row would be misfiled to foxyalexx.
//
// Same token auth as the rest of /admin/* — no login, no session.
function splitClickEvent(event) {
  const rest = event.slice("click_".length);
  const at = rest.lastIndexOf("__");
  if (at === -1) return { placement: rest, destination: "unknown" };
  return { placement: rest.slice(0, at), destination: rest.slice(at + 2) };
}

function baseCommunity(community) {
  const c = String(community || "unknown");
  const bar = c.indexOf("|");
  return bar === -1 ? c : c.slice(0, bar);
}

// Sorted [key, count] pairs, biggest first.
function topPairs(counts, limit) {
  const pairs = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return (limit ? pairs.slice(0, limit) : pairs).map(([key, count]) => ({ key, count }));
}

function summarizeClicks(rows) {
  const byDestination = {};
  const byPlacement = {};
  const byCommunity = {};
  const byCountry = {};
  const days = last7DayKeys();
  const byDay = Object.fromEntries(days.map((d) => [d, 0]));
  const today = dayKey(new Date());
  let todayCount = 0;

  rows.forEach((r) => {
    const { placement, destination } = splitClickEvent(r.event);
    byDestination[destination] = (byDestination[destination] || 0) + 1;
    byPlacement[placement] = (byPlacement[placement] || 0) + 1;
    const community = baseCommunity(r.community);
    byCommunity[community] = (byCommunity[community] || 0) + 1;
    if (r.country && r.country !== "unknown") {
      byCountry[r.country] = (byCountry[r.country] || 0) + 1;
    }
    const k = dayKey(r.created_at);
    if (k in byDay) byDay[k]++;
    if (k === today) todayCount++;
  });

  return {
    total: rows.length,
    today: todayCount,
    last7: days.reduce((n, d) => n + byDay[d], 0),
    by_day: days.map((d) => ({ day: d, count: byDay[d] })),
    destinations: topPairs(byDestination),
    placements: topPairs(byPlacement, 25),
    communities: topPairs(byCommunity),
    countries: topPairs(byCountry, 15),
  };
}

app.get("/admin/clicks", adminAuth, async (req, res) => {
  const analytics = await fetchAllRows("analytics", "event, community, country, created_at");
  const clicks = analytics.filter((a) => a.event && a.event.startsWith("click_"));

  const sites = {};
  for (const site of ["foxyalexx", "maitwerking"]) {
    sites[site] = summarizeClicks(clicks.filter((c) => siteOf(baseCommunity(c.community)) === site));
  }

  res.json({ sites, ...summarizeClicks(clicks) });
});


// ─── Adsterra publisher stats (2026-07-28) ────────────────────────────────
// Server-side proxy, same rule as the ExoClick one above: the API token lives in
// the backend env and never ships in the admin APK. Verified endpoint:
//   GET https://api3.adsterratools.com/publisher/stats.json
//       ?start_date=YYYY-MM-DD&finish_date=YYYY-MM-DD&group_by[]=<dimension>
//   header: X-API-Key
// Response: { items: [ { date|placement|country, impression, clicks, ctr, cpm,
// revenue } ] }. Note the field is "impression", singular — normalised to
// "impressions" here so every network's rows have the same shape.
const ADSTERRA_API = "https://api3.adsterratools.com/publisher/stats.json";

async function adsterraStats(groupBy, from, to) {
  const token = process.env.ADSTERRA_API_TOKEN;
  if (!token) throw new Error("ADSTERRA_API_TOKEN is not set on the server");
  const url = `${ADSTERRA_API}?start_date=${from}&finish_date=${to}&group_by[]=${groupBy}`;
  const r = await fetch(url, { headers: { "X-API-Key": token, Accept: "application/json" } });
  if (!r.ok) throw new Error(`Adsterra API ${r.status}`);
  const j = await r.json();
  return Array.isArray(j.items) ? j.items : [];
}

function netSum(rows) {
  const round = (n) => Math.round(n * 1e4) / 1e4;
  const impressions = rows.reduce((n, r) => n + (r.impression || r.impressions || 0), 0);
  const clicks = rows.reduce((n, r) => n + (r.clicks || 0), 0);
  const revenue = rows.reduce((n, r) => n + (r.revenue || 0), 0);
  return {
    impressions,
    clicks,
    revenue: round(revenue),
    cpm: round(impressions ? (revenue / impressions) * 1000 : 0),
    ctr: round(impressions ? (clicks / impressions) * 100 : 0),
  };
}

function netShape(rows, key, srcKey) {
  const round = (n) => Math.round(n * 1e4) / 1e4;
  return rows.map((r) => ({
    [key]: r[srcKey || key],
    impressions: r.impression || r.impressions || 0,
    clicks: r.clicks || 0,
    revenue: round(r.revenue || 0),
    cpm: round(r.cpm || 0),
  }));
}

app.get("/admin/adsterra-stats", adminAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = today.slice(0, 8) + "01";
    const from = req.query.from || monthStart;
    const to = req.query.to || today;
    // Adsterra rate-limits, so these run in sequence rather than in parallel.
    const daily = await adsterraStats("date", from, to);
    const places = await adsterraStats("placement", from, to);
    const countries = await adsterraStats("country", from, to);
    const todayRows = daily.filter((r) => r.date === today);
    res.json({
      range: { from, to },
      today: netSum(todayRows),
      month: netSum(daily),
      by_date: netShape(daily, "date").sort((a, b) => (a.date < b.date ? -1 : 1)),
      by_placement: netShape(places, "placement").sort((a, b) => b.revenue - a.revenue).slice(0, 25),
      by_country: netShape(countries, "country").sort((a, b) => b.revenue - a.revenue).slice(0, 25),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ─── HilltopAds publisher stats ───────────────────────────────────────────
// NOT wired to a verified endpoint yet. HilltopAds documents its publisher API
// only behind a login (their /publishers/api page defers to in-account docs), and
// probing the obvious paths returned their marketing HTML, never JSON. Rather
// than ship a guessed URL that would fail silently, the request URL is read from
// config: set HILLTOP_STATS_URL to the ready-made example from
// My Account → API in the HilltopAds panel, using {from}, {to} and {token} as
// placeholders, e.g.
//   https://hilltopads.com/<their path>?key={token}&date_from={from}&date_to={to}
// The response is passed through untouched, plus a `raw` flag, because the shape
// is unknown until we see a real one.
app.get("/admin/hilltop-stats", adminAuth, async (req, res) => {
  const token = process.env.HILLTOP_API_TOKEN;
  const tmpl = process.env.HILLTOP_STATS_URL;
  if (!token) return res.status(501).json({ error: "HILLTOP_API_TOKEN is not set on the server" });
  if (!tmpl) {
    return res.status(501).json({
      error: "HILLTOP_STATS_URL is not configured",
      hint: "Copy the example request URL from HilltopAds → My Account → API and set it as HILLTOP_STATS_URL, using {token}, {from} and {to} placeholders.",
    });
  }
  try {
    const today = new Date().toISOString().slice(0, 10);
    const from = req.query.from || today.slice(0, 8) + "01";
    const to = req.query.to || today;
    const url = tmpl.replace("{token}", encodeURIComponent(token))
                    .replace("{from}", from).replace("{to}", to);
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch (e) {
      // Their marketing site answers 200 with HTML when the path is wrong, which
      // would otherwise look like a successful empty response.
      return res.status(502).json({ error: "HilltopAds returned non-JSON — check HILLTOP_STATS_URL", preview: text.slice(0, 120) });
    }
    res.json({ range: { from, to }, raw: true, data: body });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ─── Per-network ad kill switches (2026-07-28) ────────────────────────────
// One switch per network so a misbehaving one can be cut without darkening every
// slot on the site. Stored in `settings` as ads_<network>; absent means ON, so
// nothing changes for a network that has never been toggled.
const AD_NETWORKS = ["adsterra", "exoclick", "hilltop"];

app.get("/admin/app-ads", adminAuth, async (req, res) => {
  try { res.json(await readAppAds()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/app-ads/:platform", adminAuth, async (req, res) => {
  const platform = String(req.params.platform || "").toLowerCase();
  if (!APP_AD_PLATFORMS.includes(platform)) return res.status(400).json({ error: "Unknown in-app platform" });
  let next;
  if (typeof req.body?.enabled === "boolean") next = req.body.enabled;
  else {
    const { data } = await supabase.from("settings").select("value").eq("key", appAdKey(platform)).maybeSingle();
    next = data?.value === "false";
  }
  const { error } = await supabase.from("settings").upsert(
    { key: appAdKey(platform), value: String(next), updated_at: new Date().toISOString() }, { onConflict: "key" }
  );
  if (error) return res.status(500).json({ error: error.message });
  res.json({ platform, enabled: next });
});

app.get("/admin/ads/networks", adminAuth, async (req, res) => {
  const { data, error } = await supabase.from("settings").select("key, value").in("key", AD_NETWORKS.map((n) => "ads_" + n));
  if (error) return res.status(500).json({ error: error.message });
  const map = {};
  (data || []).forEach((r) => { map[r.key] = r.value; });
  const out = {};
  AD_NETWORKS.forEach((n) => { out[n] = map["ads_" + n] !== "false"; });
  res.json(out);
});

app.post("/admin/ads/networks/:network", adminAuth, async (req, res) => {
  const network = String(req.params.network || "").toLowerCase();
  if (!AD_NETWORKS.includes(network)) return res.status(400).json({ error: "Unknown network" });
  const key = "ads_" + network;
  // Explicit `enabled` in the body wins; otherwise flip whatever is stored.
  let next;
  if (typeof req.body?.enabled === "boolean") next = req.body.enabled;
  else {
    const { data } = await supabase.from("settings").select("value").eq("key", key).maybeSingle();
    next = data?.value === "false";
  }
  const { error } = await supabase.from("settings").upsert(
    { key, value: String(next), updated_at: new Date().toISOString() }, { onConflict: "key" }
  );
  if (error) return res.status(500).json({ error: error.message });
  res.json({ network, enabled: next });
});

// ─── NeverBlock anti-adblock proxy ────────────────────────────────────────
// Fetches ExoClick banner ads server-side so ad blockers can't intercept.
// Frontend calls /api/neverblock?zones=5955418,5957132 and gets back
// the ad data to render directly — ad blocker sees your domain, not ExoClick.
app.get("/api/neverblock", async (req, res) => {
  try {
    const zones = (req.query.zones || "").split(",").filter(Boolean);
    if (!zones.length) return res.status(400).json({ error: "no zones" });
    const userIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
      || req.headers["x-real-ip"]
      || req.socket.remoteAddress
      || "1.1.1.1";
    const params = zones.map((z, i) => `zones[${i}][idzone]=${z.trim()}`).join("&");
    const url = `https://syndication-adblock.exoclick.com/ads-multi.php?${params}&user_ip=${userIp}`;
    const r = await fetch(url, {
      headers: {
        "X-Forwarded-For": userIp,
        "Referer": "https://foxyalexx.xyz",
        "User-Agent": req.headers["user-agent"] || "Mozilla/5.0",
        "Accept-Language": req.headers["accept-language"] || "en-US,en;q=0.9",
      },
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── ExoClick publisher stats ────────────────────────────────────────────────
// Proxies the ExoClick API so the admin app never sees the API token. The
// token (EXOCLICK_API_TOKEN) is exchanged for a 12h Bearer JWT, cached in
// memory and refreshed on expiry. Returns totals + zone + country + daily
// breakdowns for a date range (defaults: this month).
let exoJwt = { token: null, exp: 0 };
async function exoLogin() {
  if (exoJwt.token && Date.now() < exoJwt.exp) return exoJwt.token;
  const apiToken = process.env.EXOCLICK_API_TOKEN;
  if (!apiToken) throw new Error("EXOCLICK_API_TOKEN not set");
  const r = await fetch("https://api.exoclick.com/v2/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_token: apiToken }),
  });
  if (!r.ok) throw new Error(`ExoClick login ${r.status}`);
  const d = await r.json();
  // Refresh a minute before the real expiry to avoid a race.
  exoJwt = { token: d.token, exp: Date.now() + (d.expires_in - 60) * 1000 };
  return exoJwt.token;
}
async function exoStats(path, from, to) {
  const jwt = await exoLogin();
  const url = `https://api.exoclick.com/v2/statistics/publisher/${path}?date-from=${from}&date-to=${to}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` } });
  if (!r.ok) throw new Error(`ExoClick ${path} ${r.status}`);
  return (await r.json()).result || [];
}
function exoSum(rows) {
  return rows.reduce(
    (a, x) => ({
      impressions: a.impressions + (x.impressions || 0),
      clicks: a.clicks + (x.clicks || 0),
      revenue: a.revenue + (x.revenue || 0),
    }),
    { impressions: 0, clicks: 0, revenue: 0 }
  );
}
app.get("/admin/exoclick-stats", adminAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = today.slice(0, 8) + "01";
    const from = req.query.from || monthStart;
    const to = req.query.to || today;
    const [daily, zones, countries, todayRows] = await Promise.all([
      exoStats("date", from, to),
      exoStats("zone", from, to),
      exoStats("country", from, to),
      exoStats("date", today, today),
    ]);
    const round = (n) => Math.round(n * 1e4) / 1e4;
    const shape = (rows, key) =>
      rows
        .map((r) => ({
          [key]: r[key === "date" ? "ddate" : key],
          impressions: r.impressions || 0,
          clicks: r.clicks || 0,
          revenue: round(r.revenue || 0),
          cpm: round(r.cpm || 0),
        }))
        .sort((a, b) => b.revenue - a.revenue);
    res.json({
      range: { from, to },
      today: exoSum(todayRows),
      month: exoSum(daily),
      by_date: shape(daily, "date").sort((a, b) => (a.date < b.date ? -1 : 1)),
      by_zone: shape(zones, "idzone").slice(0, 25),
      by_country: shape(countries, "country").slice(0, 25),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/admin/settings", adminAuth, async (req, res) => {
  const { data, error } = await supabase.from("settings").select("*");
  if (error) return res.status(500).json({ error: error.message });
  const settings = {};
  data.forEach((row) => { settings[row.key] = row.value; });
  res.json(settings);
});

app.post("/admin/settings", adminAuth, async (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: "Missing key" });
  const { error } = await supabase.from("settings").upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, key, value });
});

app.post("/admin/ads/toggle", adminAuth, async (req, res) => {
  const { data } = await supabase.from("settings").select("value").eq("key", "ads_enabled").single();
  const newValue = String(data?.value !== "true");
  await supabase.from("settings").upsert({ key: "ads_enabled", value: newValue, updated_at: new Date().toISOString() }, { onConflict: "key" });
  res.json({ ads_enabled: newValue === "true" });
});

app.get("/admin/communities", adminAuth, async (req, res) => {
  const { data } = await supabase.from("videos").select("community");
  const unique = [...new Set(data?.map((v) => v.community) || [])];
  res.json({ communities: unique });
});

app.delete("/admin/videos/:id", adminAuth, async (req, res) => {
  // Grab the file URLs first: deleting only the row used to leave the video
  // and thumbnail behind in storage forever (3.3 GB of orphans by Jul 2026).
  const { data: vid } = await supabase.from("videos").select("video_url, thumbnail_url").eq("id", req.params.id).single();
  const { error } = await supabase.from("videos").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  if (vid) deleteFiles([vid.video_url, vid.thumbnail_url]);
  res.json({ success: true, deleted_id: req.params.id });
});

app.delete("/admin/communities/:community", adminAuth, async (req, res) => {
  const { data: vids } = await supabase.from("videos").select("video_url, thumbnail_url").eq("community", req.params.community);
  const { error } = await supabase.from("videos").delete().eq("community", req.params.community);
  if (error) return res.status(500).json({ error: error.message });
  if (vids?.length) deleteFiles(vids.flatMap((v) => [v.video_url, v.thumbnail_url]));
  res.json({ success: true, deleted_community: req.params.community });
});

app.post("/admin/announcement", adminAuth, async (req, res) => {
  const { message } = req.body;
  await supabase.from("settings").upsert({ key: "announcement", value: message || "", updated_at: new Date().toISOString() }, { onConflict: "key" });
  res.json({ success: true, announcement: message });
});

// Lets non-Telegram ingestion paths (e.g. the direct-uploader script) trigger
// the same "new video" push notification the Telegram webhook sends.
app.post("/admin/notify", adminAuth, async (req, res) => {
  const { community, label } = req.body;
  if (!community) return res.status(400).json({ error: "Missing community" });
  const communityLabels = { haul: "Femboys", haul2: "Trending" };
  const resolvedLabel = label || communityLabels[community] || community;
  sendPushToAll(
    "🦊 New video on Foxy Alexx!",
    `Fresh content just dropped in ${resolvedLabel}`,
    { community, label: resolvedLabel, emoji: community === "haul" ? "🌸" : "🔥" }
  );
  // Web push (PWA) — route to the right site by community.
  const site = siteOf(community);
  const siteName = site === "maitwerking" ? "Twerking Mai 🍑" : "Foxy Alexx 🦊";
  sendWebPushToAll(site, `New video on ${siteName}`, `Fresh content in ${resolvedLabel} — tap to watch`, `/community/${community}`);
  res.json({ success: true });
});

function scheduleDailyReminder() {
  const now = new Date();
  const target = new Date();
  target.setHours(19, 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  const msUntilTarget = target - now;
  setTimeout(() => {
    sendPushToAll("🦊 Don't miss out!", "New videos are waiting for you on Foxy Alexx. Tap to watch now!", { community: "haul" });
    setInterval(() => {
      sendPushToAll("🦊 Don't miss out!", "New videos are waiting for you on Foxy Alexx. Tap to watch now!", { community: "haul" });
    }, 24 * 60 * 60 * 1000);
  }, msUntilTarget);
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔐 Admin token: ${ADMIN_SECRET}`);
  console.log(`🤖 Bots: main=${BOT_TOKEN ? "set" : "MISSING"} foxy=${FOXY_BOT_TOKEN ? "set" : "MISSING"} wetlooks=${WETLOOKS_BOT_TOKEN ? "set" : "MISSING"}`);
  if (!FOXY_BOT_TOKEN) console.warn("⚠️ FOXY_BOT_TOKEN missing — Foxy channel videos cannot be downloaded/re-hosted");
  if (!WETLOOKS_BOT_TOKEN) console.warn("⚠️ WETLOOKS_BOT_TOKEN missing — Wetlooks videos cannot be downloaded/re-hosted");
  await registerWebhook();
  // Heal null-URL Foxy/Wetlooks rows soon after boot (was 2 min; now 15s).
  setTimeout(migrateLegacyVideos, 15 * 1000);
  setInterval(migrateLegacyVideos, 60 * 60 * 1000);
  scheduleDailyReminder();
});
