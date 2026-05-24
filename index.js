require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const supabase = require("./supabase");
const communities = require("./communities");

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ─── Register webhook with Telegram ───────────────────────────────────────────
async function registerWebhook() {
  const webhookUrl = `${process.env.WEBHOOK_URL}/webhook`;
  const res = await fetch(`${TELEGRAM_API}/setWebhook?url=${webhookUrl}`);
  const data = await res.json();
  if (data.ok) {
    console.log(`✅ Webhook registered: ${webhookUrl}`);
  } else {
    console.error("❌ Webhook registration failed:", data.description);
  }
}

// ─── Get a public file URL from Telegram ──────────────────────────────────────
async function getTelegramFileUrl(file_id) {
  const res = await fetch(`${TELEGRAM_API}/getFile?file_id=${file_id}`);
  const data = await res.json();
  if (!data.ok) return null;
  return `https://api.telegram.org/file/bot${BOT_TOKEN}/${data.result.file_path}`;
}

// ─── Handle incoming Telegram updates ─────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Always respond fast to Telegram

  const update = req.body;
  const message = update.channel_post;

  // Only process channel posts with a video
  if (!message || !message.video) return;

  const chatId = String(message.chat.id);
  const community = communities[chatId];

  if (!community) {
    console.log(`⚠️  Unknown channel: ${chatId} — add it to communities.js`);
    return;
  }

  const video = message.video;
  const file_id = video.file_id;
  const caption = message.caption || "";
  const thumbnail_file_id = video.thumbnail?.file_id || null;

  console.log(`🎬 New video in [${community}] — file_id: ${file_id}`);

  // Get playable URL and thumbnail URL from Telegram
  const video_url = await getTelegramFileUrl(file_id);
  const thumbnail_url = thumbnail_file_id
    ? await getTelegramFileUrl(thumbnail_file_id)
    : null;

  // Save to Supabase
  const { error } = await supabase.from("videos").insert({
    community,
    file_id,
    video_url,
    thumbnail_url,
    caption,
  });

  if (error) {
    console.error("❌ Supabase insert error:", error.message);
  } else {
    console.log(`✅ Saved to Supabase → community: ${community}`);
  }
});

// ─── Health check endpoint ─────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Video app bot is running 🚀" });
});

// ─── API: Get videos by community (used by frontend) ──────────────────────────
app.get("/api/videos/:community", async (req, res) => {
  const { community } = req.params;

  const { data, error } = await supabase
    .from("videos")
    .select("*")
    .eq("community", community)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ videos: data });
});

// ─── API: Get all videos (for home feed) ──────────────────────────────────────
app.get("/api/videos", async (req, res) => {
  const { data, error } = await supabase
    .from("videos")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ videos: data });
});

// ─── API: Save user after Telegram login ──────────────────────────────────────
app.post("/api/users/login", async (req, res) => {
  const { telegram_id, username, photo_url, first_name } = req.body;

  if (!telegram_id) return res.status(400).json({ error: "Missing telegram_id" });

  // Upsert — create or update user
  const { data, error } = await supabase
    .from("users")
    .upsert({ telegram_id, username, photo_url, first_name }, { onConflict: "telegram_id" })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ user: data });
});

// ─── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  await registerWebhook();
});
