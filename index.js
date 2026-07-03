require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const supabase = require("./supabase");
const communities = require("./communities");
const { uploadFile, isPermanentUrl } = require("./storage");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Gumroad's Ping webhook posts form-encoded, not JSON
app.use(cors({
  origin: ["https://foxyalexx.xyz", "https://www.foxyalexx.xyz", "https://video-app-web-one.vercel.app", "http://localhost:3000"],
  methods: ["GET", "POST", "DELETE"],
}));

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "Mbuki@2030.";
const APP_SECRET = process.env.APP_SECRET || "";

function adminAuth(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (token !== ADMIN_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
}

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

async function registerWebhook() {
  const webhookUrl = `${process.env.WEBHOOK_URL}/webhook`;
  const res = await fetch(`${TELEGRAM_API}/setWebhook?url=${webhookUrl}`);
  const data = await res.json();
  if (data.ok) console.log(`✅ Webhook registered: ${webhookUrl}`);
  else console.error("❌ Webhook failed:", data.description);
}

async function tgGetFile(file_id) {
  try {
    const res = await fetch(`${TELEGRAM_API}/getFile?file_id=${file_id}`);
    return await res.json();
  } catch (e) {
    return { ok: false, description: e.message };
  }
}

async function getFreshVideoUrl(file_id) {
  const data = await tgGetFile(file_id);
  if (!data.ok) return null;
  return `https://api.telegram.org/file/bot${BOT_TOKEN}/${data.result.file_path}`;
}

// Telegram's Bot API caps file downloads at 20MB and returns a hard error for
// anything bigger ("file is too big") — that is NOT the same as the file being
// gone, and must never be treated as such by callers deciding whether to delete
// a row. gone=true only for errors that mean Telegram no longer has this file.
function isFileGoneFromTelegram(getFileResponse) {
  const desc = (getFileResponse.description || "").toLowerCase();
  return desc.includes("file not found") || desc.includes("wrong file_id") || desc.includes("file_id is invalid");
}

async function downloadTelegramFile(file_id) {
  const fileInfo = await tgGetFile(file_id);
  if (!fileInfo.ok) return { buffer: null, gone: isFileGoneFromTelegram(fileInfo), reason: fileInfo.description };
  try {
    const res = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.result.file_path}`);
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
// Supabase Storage, so playback no longer depends on the source message still
// existing on Telegram (which is what was breaking videos on web + app).
async function persistVideoAssets(community, file_id, thumbnail_file_id, mimeType) {
  const result = { video_url: null, thumbnail_url: null };

  const video = await downloadTelegramFile(file_id);
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
    const thumb = await downloadTelegramFile(thumbnail_file_id);
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
// existed. Anything still pointing at a Telegram file link gets re-downloaded
// and re-hosted. A row is only ever removed when Telegram explicitly confirms
// the file is gone (isFileGoneFromTelegram) — every other failure (too big,
// rate limited, network blip, etc.) leaves the row untouched. Deleting on any
// failure is exactly what caused every video to disappear in production once.
async function migrateLegacyVideos() {
  const { data: videos } = await supabase.from("videos").select("id, community, video_url, file_id");
  if (!videos) return;
  const legacy = videos.filter((v) => !isPermanentUrl(v.video_url));
  if (legacy.length === 0) return;

  console.log(`🔄 Migrating ${legacy.length} legacy video(s) to permanent storage...`);
  let migrated = 0, deleted = 0, skipped = 0;
  for (const video of legacy) {
    const file = await downloadTelegramFile(video.file_id);
    if (!file.buffer) {
      if (file.gone) {
        await supabase.from("videos").delete().eq("id", video.id);
        deleted++;
        console.log(`🗑️ Confirmed gone from Telegram, removed: ${video.id} (${file.reason})`);
      } else {
        skipped++;
        console.log(`⏭️ Skipping ${video.id} for now — not deleting (${file.reason})`);
      }
      continue;
    }
    try {
      const url = await uploadFile(`${video.community}/${video.file_id}.mp4`, file.buffer, "video/mp4");
      await supabase.from("videos").update({ video_url: url }).eq("id", video.id);
      migrated++;
    } catch (e) {
      console.error(`❌ Migration upload failed for ${video.id}:`, e.message);
    }
  }
  console.log(`✅ Migration done — migrated ${migrated}, removed ${deleted} confirmed-gone, skipped ${skipped}`);
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
    const communityLabels = { haul: "Femboys", haul2: "Trending" };
    sendPushToAll(
      "🦊 New video on Foxy Alexx!",
      `Fresh content just dropped in ${communityLabels[community] || community}`,
      { community, label: communityLabels[community], emoji: community === "haul" ? "🌸" : "🔥" }
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

app.get("/api/videos/:community", async (req, res) => {
  const country = req.headers["cf-ipcountry"] || req.headers["x-country"] || "unknown";
  trackEvent("page_view", "web", req.params.community, country);
  const { data, error } = await supabase
    .from("videos")
    .select("*")
    .eq("community", req.params.community)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ videos: data });
});

app.get("/api/videos", async (req, res) => {
  const country = req.headers["cf-ipcountry"] || "unknown";
  trackEvent("app_open", "mobile", "all", country);
  const { data, error } = await supabase
    .from("videos")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ videos: data });
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

app.post("/api/track", async (req, res) => {
  const { event, platform, community, country } = req.body;
  await trackEvent(event || "unknown", platform || "unknown", community || "unknown", country || "unknown");
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

app.get("/admin/stats", adminAuth, async (req, res) => {
  const { data: videos } = await supabase.from("videos").select("id, community, caption, likes_count, created_at");
  const { data: users } = await supabase.from("users").select("id");
  const { data: analytics } = await supabase.from("analytics").select("*");
  const { data: appOpens } = await supabase.from("analytics").select("country").eq("event", "app_open");
  const uniqueUsers = new Set(appOpens?.map(a => a.country)).size;
  const communityCount = {};
  videos?.forEach((v) => { communityCount[v.community] = (communityCount[v.community] || 0) + 1; });
  const mostActive = Object.entries(communityCount).sort((a, b) => b[1] - a[1])[0];
  const totalViews = analytics?.length || 0;
  const todayViews = analytics?.filter(a => new Date(a.created_at) > new Date(Date.now() - 86400000)).length || 0;
  const webViews = analytics?.filter(a => a.platform === "web").length || 0;
  const mobileViews = analytics?.filter(a => a.platform === "mobile").length || 0;
  const countries = {};
  analytics?.forEach(a => { if (a.country && a.country !== "unknown") countries[a.country] = (countries[a.country] || 0) + 1; });
  const topCountries = Object.entries(countries).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const topVideos = [...(videos || [])]
    .sort((a, b) => (b.likes_count || 0) - (a.likes_count || 0))
    .slice(0, 5)
    .map(v => ({ id: v.id, community: v.community, caption: v.caption, likes_count: v.likes_count || 0 }));

  const days = last7DayKeys();
  const viewsByDay = Object.fromEntries(days.map(d => [d, 0]));
  analytics?.forEach(a => { const k = dayKey(a.created_at); if (k in viewsByDay) viewsByDay[k]++; });
  const videosByDay = Object.fromEntries(days.map(d => [d, 0]));
  videos?.forEach(v => { const k = dayKey(v.created_at); if (k in videosByDay) videosByDay[k]++; });

  const adAttempts = analytics?.filter(a => a.event === "vast_attempt").length || 0;
  const adFilled = analytics?.filter(a => a.event === "vast_filled").length || 0;
  const adErrors = analytics?.filter(a => a.event === "vast_error").length || 0;
  const adEmpty = analytics?.filter(a => a.event === "vast_empty").length || 0;
  const popunderFires = analytics?.filter(a => a.event === "popunder_fired").length || 0;

  res.json({
    app_users: uniqueUsers,
    total_videos: videos?.length || 0,
    total_users: users?.length || 0,
    videos_by_community: communityCount,
    most_active_community: mostActive ? mostActive[0] : "none",
    total_views: totalViews,
    views_today: todayViews,
    web_views: webViews,
    mobile_views: mobileViews,
    top_countries: topCountries,
    top_videos: topVideos,
    views_last_7_days: viewsByDay,
    videos_last_7_days: videosByDay,
    ad_funnel: {
      attempts: adAttempts,
      filled: adFilled,
      errors: adErrors,
      empty: adEmpty,
      fill_rate: adAttempts > 0 ? Math.round((adFilled / adAttempts) * 100) : 0,
      popunder_fires: popunderFires,
    },
  });
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
  const { error } = await supabase.from("videos").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, deleted_id: req.params.id });
});

app.delete("/admin/communities/:community", adminAuth, async (req, res) => {
  const { error } = await supabase.from("videos").delete().eq("community", req.params.community);
  if (error) return res.status(500).json({ error: error.message });
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
  await registerWebhook();
  setTimeout(migrateLegacyVideos, 2 * 60 * 1000);
  setInterval(migrateLegacyVideos, 60 * 60 * 1000);
  scheduleDailyReminder();
});
