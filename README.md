# MAHNGUELOH MD SESSION

WhatsApp pairing page that generates a session ID for the bot.

## Session IDs never expire

- **Without a database:** you get a `MAHNGUELOH~...` ID (about 2–3k characters). It carries the whole login, so it works forever and never needs this server.
- **With a free Upstash Redis database:** you get a short `MH~...` ID (about 35 characters). The login is stored permanently in the database, and the ID can be redeemed any number of times.

### Turn on short permanent IDs
1. Create a free database at upstash.com (Redis).
2. On the page for that database, copy **UPSTASH_REDIS_REST_URL** and **UPSTASH_REDIS_REST_TOKEN** (the REST API section).
3. Add both as environment variables on the pairing site's host (Render → Environment) and redeploy.

If the database is missing or unreachable, the site automatically falls back to the long permanent ID, so pairing never breaks.
