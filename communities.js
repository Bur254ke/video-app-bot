// Map each Telegram channel ID to a community name
// To add more channels later, just add a new line here
//
// 2026-07-16: rewired the two "haul" channels from foxyalexx → twerking-mai.
// New videos arriving in these channels now land in maitwerking / maitrending.
// Existing haul/haul2 videos already in the DB keep their community (left as-is).
const communities = {
  "-1003870438959": "maitwerking", // was "haul" (Femboys, foxyalexx)
  "-1003859771687": "maitrending", // was "haul2" (Trending, foxyalexx)
};

module.exports = communities;
