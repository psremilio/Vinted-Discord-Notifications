# Vinted Discord Notifications

This project allows you to host your own bot on your discord server, and receive notifications for your favorite vinted searches.

It's a feature that is truly missed in the Vinted app, you will never miss a good deal again!

> [!WARNING]
>  Vinted uses Cloudflare to protect its API from scraping. A single IP is only allowed a limited number of calls before being blocked for 24h. If you want to have this bot running 24/7 you should consider adding rotating proxies.

Set the following environment variables before starting the bot:

```
export BOT_TOKEN=your_discord_bot_token
export VINTED_BASE_URL="https://www.vinted.de"      # or set LOGIN_URL for backward compatibility
# Either set PROXY_LIST_URL directly or let the app build it from
# PS_API_KEY and SERVICE_ID
export PS_API_KEY=your_key            # used to build ProxyScrape URL
export SERVICE_ID=your_service_id     # used to build ProxyScrape URL
# export PROXY_LIST_URL="https://api.proxyscrape.com/v2/account/datacenter_shared/proxy-list?auth=XYZ&type=getproxies&protocol=http&format=txt&status=all&country=all&service=123"
export PROXY_LIST_FILE="/app/config/proxies.txt"    # optional; defaults to /app/config/proxies.txt on Railway or config/proxies.txt locally
# optional: provider endpoint to whitelist current egress IP
export PROXY_WHITELIST_URL="https://provider.example/whitelist?token=XYZ&ip={{IP}}"
# optional: refresh proxy list every N minutes
export LIST_REFRESH_MIN=30
# set to 1 to allow direct requests when all proxies fail
export ALLOW_DIRECT=0

# Testing / Polling
# Override all per-channel frequencies (seconds). Useful to experiment quickly.
# Example: 25 = roughly every 25s (with jitter unless disabled)
export POLL_INTERVAL_SEC=25
# Optional: disable jitter (use exact interval)
export POLL_NO_JITTER=1

# Filtering / Dedupe
# Scope of dedupe keys: per rule (default) or global
export DEDUPE_SCOPE=per_rule   # or 'global'
# How long a processed item stays in-memory (minutes)
export PROCESSED_TTL_MIN=60
# Define how recent an item must be to be considered (minutes)
export RECENT_MAX_MIN=15
# Enable verbose poll logs (scraped counts, matches, sample reasons)
export DEBUG_POLL=0            # set to 1 for verbose

# Proxy-Pool Tuning
# Hard cap for concurrently healthy proxies
export PROXY_HEALTHY_CAP=200
# Background top-up interval (minutes). 0 disables auto top-up
export PROXY_TOPUP_MIN=3
# How many proxy tests run in parallel while filling the pool
export PROXY_TEST_CONCURRENCY=8
```

Start the bot with `npm start` (which runs `node main.js`). On startup the bot whitelists the
current egress IP (if `PROXY_WHITELIST_URL` is set) and downloads the proxy list from
`PROXY_LIST_URL` or, if not provided, builds the ProxyScrape URL using `PS_API_KEY` and
`SERVICE_ID`. Proxy addresses are read from `PROXY_LIST_FILE` (defaults to
`/app/config/proxies.txt` on Railway or `config/proxies.txt` locally). Ensure your deployment mounts a volume containing this file with one
`IP:PORT` entry per line or provide the variables above to download it automatically.

Functionalities:
----------------

- Ability to have as many searches as you wish in as little or as many discord channels as wanted (it's possible to have multiple searches in a single channel)
- Each search has its own schedule! you just have to configure how frequently it needs to be refreshed
- Ability to block certain words from the title of your search results, to make your searches even more precise!
- Checkout the 'autobuy' branch for to setup the autobuy feature.
- New searches added via `/new_search` start monitoring immediately and duplicate names are ignored to prevent rescheduling.
- Includes unit tests ensuring `/new_search` scheduling works without a restart.


Prerequisites:
--------------

- Need to be able to run JS code, preferably on a machine that is up 24/7 ( I use npm and node on a small raspberry pi, other options could be renting a VPS, or using services like Heroku)
- Have a discord server you can invite the bot on
- Node.js 20 or later

Step 0: Download the code (git clone or download as zip)
--------------------------------------------------------

Step 1: Create and invite the bot to your server
------------------------------------------------

- Go to the [Discord Developer Portal](https://discord.com/developers/applications).
- Click on "New Application" and give your bot a name.
- Go to the "Bot" tab and click on "Add Bot".
- Copy the "Token" to put in the configuration file in the next steps.
- Give intent permissions to the bot by going to the "Bot" tab and enabling the "Presence Intent", "Server Members Intent" and "Content Message Intent".
- Invite the bot with admin permissions to your server by going to the "OAuth2" tab and selecting the "bot" and "application.commands" scope and the "Administrator" permission.
- Copy the generated URL and paste it into your browser to invite the bot to your server. (credits:@teddy-vltn for the tutorial)

Step 2: Install dependencies
----------------------------

If you want to use autobuy you will need to clone this branch, then add your session tokens to `autobuy.json`. You will also need to add your home address latitude and longitude for the automatic selection of the pickup point. Google your User Agent and paste it in the config too.
```
{
  "user_agent": "Mozilla....",
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",
  "latitude":1.1313,
  "longitude":1.1313
}
```
You need to get the tokens from your browser storage, AFTER having logged-in with the account you want to use for your purchases

Don't hesitate to contact me on discord (@thewwk) or open an issue here if you have any concerns or requests!
