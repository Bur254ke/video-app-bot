require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const supabase = require("./supabase");
const communities = require("./communities");

const app = express();
app.use(express.json());
app.use(cors({
  origin: ["https://video-app-web-one.vercel.app", "http://localhost:3000"],
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
  console.log(`🎬 New video in [${community}]`);
  const video_url = await getFreshVideoUrl(file_id);
  const thumbnail_url = thumbnail_file_id ? await getFreshVideoUrl(thumbnail_file_id) : null;
  const { error } = await supabase.from("videos").insert({ community, file_id, video_url, thumbnail_url, caption });
  if (error) console.error("❌ Supabase error:", error.message);
  else console.log(`✅ Saved → community: ${community}`);
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

app.post("/api/track", async (req, res) => {
  const { event, platform, community, country } = req.body;
  await trackEvent(event || "unknown", platform || "unknown", community || "unknown", country || "unknown");
  res.json({ success: true });
});

app.get("/admin/stats", adminAuth, async (req, res) => {
  const { data: videos } = await supabase.from("videos").select("community");
  const { data: users } = await supabase.from("users").select("id");
  const { data: analytics } = await supabase.from("analytics").select("*");

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

const PORT = process.env.PORT || 4000;
// Like a video
app.post("/api/videos/:id/like", async (req, res) => {
  const { id } = req.params;
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ error: "Missing session_id" });

  // Check if already liked
  const { data: existing } = await supabase
    .from("likes")
    .select("id")
    .eq("video_id", id)
    .eq("session_id", session_id)
    .single();

  if (existing) {
    // Unlike
    await supabase.from("likes").delete().eq("video_id", id).eq("session_id", session_id);
    await supabase.rpc("decrement_likes", { video_id: id });
    return res.json({ liked: false });
  }

  // Like
  await supabase.from("likes").insert({ video_id: id, session_id });
  await supabase.from("videos").update({ likes_count: supabase.raw("likes_count + 1") }).eq("id", id);
  res.json({ liked: true });
});

// Get like count for a video
app.get("/api/videos/:id/likes", async (req, res) => {
  const { data } = await supabase.from("likes").select("id").eq("video_id", req.params.id);
  res.json({ count: data?.length || 0 });
});
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔐 Admin token: ${ADMIN_SECRET}`);
  await registerWebhook();
});
