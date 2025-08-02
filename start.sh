#!/usr/bin/env bash
set -e

# Retrieve the container's public IP
MY_IP=$(curl -s https://api64.ipify.org)

# Whitelist the IP on ProxyScrape
curl -sG "https://api.proxyscrape.com/v2/account/datacenter_shared/whitelist" \
  --data-urlencode "auth=${PS_API_KEY}" \
  --data-urlencode "type=set" \
  --data-urlencode "ip[]=${MY_IP}"

# Wait for whitelist to propagate
sleep "${WHITELIST_SLEEP:-30}"

# Download proxy list
curl -s "${PROXY_LIST_URL}" -o proxies.txt

# Start the bot
node main.js
