# Video App — Bot Backend

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Make sure ngrok is running:
   ```bash
   ngrok http 3000
   ```

3. Start the bot:
   ```bash
   node index.js
   ```

## API Endpoints

| Method | URL | Description |
|--------|-----|-------------|
| GET | `/` | Health check |
| GET | `/api/videos` | All videos (home feed) |
| GET | `/api/videos/:community` | Videos by community (e.g. `/api/videos/haul`) |
| POST | `/api/users/login` | Save user after Telegram login |

## Adding a New Channel/Community

1. Add your bot to the new Telegram channel as admin
2. Open `communities.js`
3. Add a new line:
   ```js
   "-1009999999999": "new-community-name",
   ```
That's it — no other code changes needed.

## Environment Variables (.env)

```
BOT_TOKEN=your_telegram_bot_token
WEBHOOK_URL=your_ngrok_or_production_url
SUPABASE_URL=your_supabase_url
SUPABASE_SECRET_KEY=your_supabase_secret_key
PORT=3000
```
