const supabase = require("./supabase");

const BUCKET = "videos";
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
  await ensureBucket();
  const { error } = await supabase.storage.from(BUCKET).upload(path, buffer, {
    contentType,
    upsert: true,
  });
  if (error) throw error;
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

function isPermanentUrl(url) {
  return !!url && url.includes(`/storage/v1/object/public/${BUCKET}/`);
}

function pathFromPublicUrl(url) {
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  if (!url || !url.includes(marker)) return null;
  return decodeURIComponent(url.split(marker)[1]);
}

// Remove the storage objects behind a list of public URLs. Non-URL or
// external entries are ignored; errors are logged, not thrown, so a failed
// storage cleanup never blocks the DB deletion that triggered it.
async function deleteFiles(urls) {
  const paths = (urls || []).map(pathFromPublicUrl).filter(Boolean);
  if (!paths.length) return;
  const { error } = await supabase.storage.from(BUCKET).remove(paths);
  if (error) console.error("❌ Storage delete error:", error.message);
  else console.log(`🗑️ Deleted ${paths.length} storage file(s)`);
}

module.exports = { uploadFile, isPermanentUrl, deleteFiles, BUCKET };
