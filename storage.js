const supabase = require("./supabase");

const BUCKET = "videos";

// ─── Cloudflare R2 (S3-compatible) ────────────────────────────────────────────
// Active when all R2_* env vars are set; otherwise uploads fall back to
// Supabase Storage. Public URLs are served via R2_PUBLIC_BASE (custom domain),
// which has zero egress fees — Supabase egress was blowing the free tier.
const R2_BUCKET = process.env.R2_BUCKET;
const R2_PUBLIC_BASE = (process.env.R2_PUBLIC_BASE || "").replace(/\/+$/, "");
const CDN_HOSTS = ["cdn.foxyalexx.xyz", ".r2.dev"];

let r2 = null;
function getR2() {
  if (r2) return r2;
  if (!R2_BUCKET || !R2_PUBLIC_BASE || !process.env.R2_ACCOUNT_ID ||
      !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) return null;
  const { S3Client } = require("@aws-sdk/client-s3");
  r2 = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  return r2;
}

function encodeKey(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

// ─── Supabase Storage (legacy/fallback) ───────────────────────────────────────
let bucketReady = null;

async function ensureBucket() {
  if (bucketReady) return bucketReady;
  bucketReady = (async () => {
    const { data: buckets } = await supabase.storage.listBuckets();
    if (!buckets?.find((b) => b.name === BUCKET)) {
      const { error } = await supabase.storage.createBucket(BUCKET, {
        public: true,
        fileSizeLimit: "50MB",
      });
      if (error && !String(error.message).includes("already exists")) throw error;
    }
  })();
  return bucketReady;
}

async function uploadFile(path, buffer, contentType) {
  const client = getR2();
  if (client) {
    const { PutObjectCommand } = require("@aws-sdk/client-s3");
    await client.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: path,
      Body: buffer,
      ContentType: contentType,
    }));
    return `${R2_PUBLIC_BASE}/${encodeKey(path)}`;
  }
  await ensureBucket();
  const { error } = await supabase.storage.from(BUCKET).upload(path, buffer, {
    contentType,
    upsert: true,
  });
  if (error) throw error;
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

// Permanent = already re-hosted by us (Supabase or R2), i.e. not an expiring
// Telegram file URL. Hosts are hardcoded so old rows stay "permanent" even in
// an environment missing the R2_* vars — otherwise the bot would re-host
// everything again.
function isPermanentUrl(url) {
  if (!url) return false;
  if (url.includes(`/storage/v1/object/public/${BUCKET}/`)) return true;
  return CDN_HOSTS.some((h) => url.includes(h));
}

function supabasePathFromUrl(url) {
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  if (!url || !url.includes(marker)) return null;
  return decodeURIComponent(url.split(marker)[1]);
}

function r2KeyFromUrl(url) {
  if (!url || !CDN_HOSTS.some((h) => url.includes(h))) return null;
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch (e) {
    return null;
  }
}

// Remove the storage objects behind a list of public URLs — handles both
// Supabase and R2 URLs, so cleanup keeps working through the migration.
// Errors are logged, not thrown, so a failed storage cleanup never blocks
// the DB deletion that triggered it.
async function deleteFiles(urls) {
  const sbPaths = [];
  const r2Keys = [];
  for (const u of urls || []) {
    const sb = supabasePathFromUrl(u);
    if (sb) { sbPaths.push(sb); continue; }
    const key = r2KeyFromUrl(u);
    if (key) r2Keys.push(key);
  }
  if (sbPaths.length) {
    const { error } = await supabase.storage.from(BUCKET).remove(sbPaths);
    if (error) console.error("❌ Supabase storage delete error:", error.message);
    else console.log(`🗑️ Deleted ${sbPaths.length} Supabase storage file(s)`);
  }
  const client = r2Keys.length ? getR2() : null;
  if (client) {
    try {
      const { DeleteObjectsCommand } = require("@aws-sdk/client-s3");
      await client.send(new DeleteObjectsCommand({
        Bucket: R2_BUCKET,
        Delete: { Objects: r2Keys.map((Key) => ({ Key })) },
      }));
      console.log(`🗑️ Deleted ${r2Keys.length} R2 file(s)`);
    } catch (e) {
      console.error("❌ R2 delete error:", e.message);
    }
  }
}

module.exports = { uploadFile, isPermanentUrl, deleteFiles, BUCKET };
