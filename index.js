require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const supabase = require("./supabase");
const communities = require("./communities");

const app = express();
app.use(express.json());
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

async function getFreshVideoUrl(file_id) {
  try {
    const res = await fetch(`${TELEGRAM_API}/getFile?file_id=${file_id}`);
    const data = await res.json();
    if (!data.ok) return null;
    return `https://api.telegram.org/file/bot${BOT_TOKEN}/${data.result.file_path}`;
  } catch (e) { return null; }
}

async function refreshVideoUrls(videos) {
  return await Promise.all(
    videos.map(async (video) => {
      if (!video.file_id) return video;
      const freshUrl = await getFreshVideoUrl(video.file_id);
      if (freshUrl) {
        await supabase.from("videos").update({ video_url: freshUrl }).eq("id", video.id);
        return { ...video, video_url: freshUrl };
      }
      return video;
    })
  );
}

// Auto-cleanup dead videos every hour
async function cleanupDeadVideos() {
  console.log("🧹 Running video cleanup...");
  const { data: videos } = await supabase.from("videos").select("id, video_url, file_id");
  if (!videos) return;
  let deleted = 0;
  for (const video of videos) {
    try {
      const res = await fetch(video.video_url, { method: "HEAD" });
      if (res.status === 404 || res.status === 403) {
        const freshUrl = await getFreshVideoUrl(video.file_id);
        if (!freshUrl) {
          await supabase.from("videos").delete().eq("id", video.id);
          deleted++;
          console.log(`🗑️ Deleted dead video: ${video.id}`);
        } else {
          await supabase.from("videos").update({ video_url: freshUrl }).eq("id", video.id);
        }
      }
    } catch (e) { continue; }
  }
  console.log(`✅ Cleanup done — removed ${deleted} dead videos`);
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

  // Prevent duplicate inserts of the same file_id in the same community
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
  const video_url = await getFreshVideoUrl(file_id);
  const thumbnail_url = thumbnail_file_id ? await getFreshVideoUrl(thumbnail_file_id) : null;
  const { error } = await supabase.from("videos").insert({ community, file_id, video_url, thumbnail_url, caption });
  if (error) {console.error("❌ Supabase error:", error.message);
} else {
  console.log(`✅ Saved → community: ${community}`);
  // Notify users of new video
  const communityLabels = { haul: "Femboys", haul2: "Trending" };
  sendPushToAll(
    "🦊 New video on Foxy Alexx!",
    `Fresh content just dropped in ${communityLabels[community] || community}`,
    { community, label: communityLabels[community], emoji: community === "haul" ? "🌸" : "🔥" }
  );
}

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
  const fresh = await refreshVideoUrls(data);
  res.json({ videos: fresh });
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
  const fresh = await refreshVideoUrls(data);
  res.json({ videos: fresh });
});

app.get("/api/settings", async (req, res) => {
  const { data, error } = await supabase.from("settings").select("*");
  if (error) return res.status(500).json({ error: error.message });
  const settings = {};
  data.forEach((row) => { settings[row.key] = row.value; });
  res.json(settings);
});
   // Store push token
app.post("/api/push-token", async (req, res) => {
  const { push_token, platform } = req.body;
  if (!push_token) return res.status(400).json({ error: "Missing push_token" });
  try {
    await supabase.from("push_tokens").upsert(
      { push_token, platform },
      { onConflict: "push_token" }
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Send push notification to all registered devices
async function sendPushToAll(title, body, data = {}) {
  const { data: tokens } = await supabase.from("push_tokens").select("push_token");
  if (!tokens || tokens.length === 0) {
    console.log("📵 No push tokens registered");
    return;
  }

  const messages = tokens.map(t => ({
    to: t.push_token,
    sound: "default",
    title,
    body,
    data,
  }));

  // Expo push API accepts batches of up to 100
  const chunks = [];
  for (let i = 0; i < messages.length; i += 100) {
    chunks.push(messages.slice(i, i + 100));
  }

  for (const chunk of chunks) {
    try {
      await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Accept-Encoding": "gzip, deflate",
        },
        body: JSON.stringify(chunk),
      });
    } catch (e) {
      console.error("Push send error:", e.message);
    }
  }
  console.log(`📲 Sent push to ${messages.length} devices`);
}
app.post("/api/track", async (req, res) => {
  const { event, platform, community, country } = req.body;
  await trackEvent(event || "unknown", platform || "unknown", community || "unknown", country || "unknown");
  res.json({ success: true });
});

// Like a video
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

// Get like count for a video
app.get("/api/videos/:id/likes", async (req, res) => {
  const { data } = await supabase.from("likes").select("id").eq("video_id", req.params.id);
  res.json({ count: data?.length || 0 });
});

app.get("/admin/stats", adminAuth, async (req, res) => {
  const { data: videos } = await supabase.from("videos").select("community");
  const { data: users } = await supabase.from("users").select("id");
  const { data: analytics } = await supabase.from("analytics").select("*");
  const { data: appOpens } = await supabase.from("analytics").select("country").eq("event", "app_open");
  const uniqueUsers = new Set(appOpens?.map(a => a.country)).size;
  const communityCount = {};
  videos?.forEach((v) => { communityCount[v.community] = (communityCount[v.community] || 0) + 1; });
  const mostActive = Object.entries(communityCount).sort((a, b) => b[1] - a[1])[0];

  const totalViews = analytics?.length || 0;
  const todayViews = analytics?.filter(a =>
    new Date(a.created_at) > new Date(Date.now() - 86400000)
  ).length || 0;

  const webViews = analytics?.filter(a => a.platform === "web").length || 0;
  const mobileViews = analytics?.filter(a => a.platform === "mobile").length || 0;

  const countries = {};
  analytics?.forEach(a => {
    if (a.country && a.country !== "unknown") {
      countries[a.country] = (countries[a.country] || 0) + 1;
    }
  });
  const topCountries = Object.entries(countries).sort((a, b) => b[1] - a[1]).slice(0, 5);

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

// Daily reminder notification at a fixed time
function scheduleDailyReminder() {
  const now = new Date();
  const target = new Date();
  target.setHours(19, 0, 0, 0); // 7 PM daily
  if (target <= now) target.setDate(target.getDate() + 1);
  const msUntilTarget = target - now;
  setTimeout(() => {
    sendPushToAll(
      "🦊 Don't miss out!",
      "New videos are waiting for you on Foxy Alexx. Tap to watch now!",
      { community: "haul" }
    );
    setInterval(() => {
      sendPushToAll(
        "🦊 Don't miss out!",
        "New videos are waiting for you on Foxy Alexx. Tap to watch now!",
        { community: "haul" }
      );
    }, 24 * 60 * 60 * 1000);
  }, msUntilTarget);
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔐 Admin token: ${ADMIN_SECRET}`);
  await registerWebhook();
  // Run cleanup once on startup after 2 minutes
  setTimeout(cleanupDeadVideos, 2 * 60 * 1000);
  // Run cleanup every hour
  setInterval(cleanupDeadVideos, 60 * 60 * 1000);
  scheduleDailyReminder();
});
