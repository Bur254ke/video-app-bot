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

module.exports = { uploadFile, isPermanentUrl, BUCKET };
