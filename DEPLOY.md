# Deploying the duckling relay (Cloudflare Worker)

You only need to do this **once**, as the project maintainer. End users `npm install -g duckling` and pair against your deployment.

## Prerequisites

- Cloudflare account (free tier is fine)
- The Telegram bot token you got from [@BotFather](https://t.me/BotFather)

## Five commands

```bash
# 1. Authenticate wrangler with your Cloudflare account (opens a browser).
npx wrangler login

# 2. Push the bot token as a Worker secret (NOT committed to repo).
npx wrangler secret put TELEGRAM_BOT_TOKEN
# (paste token at the prompt)

# 3. Generate a random webhook secret and store it. Telegram will echo this
#    back on every webhook delivery so the Worker can reject spoofed calls.
WEBHOOK_SECRET=$(openssl rand -hex 32)
echo "$WEBHOOK_SECRET" | npx wrangler secret put TG_WEBHOOK_SECRET

# 4. Deploy.
npx wrangler deploy
# Note the URL it prints, e.g. https://duckling-relay.<your-subdomain>.workers.dev

# 5. Tell Telegram where to send updates.
RELAY_URL="https://duckling-relay.<your-subdomain>.workers.dev"
BOT_TOKEN="<your-bot-token>"
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -H 'content-type: application/json' \
  -d "{
    \"url\": \"${RELAY_URL}/tg-webhook\",
    \"secret_token\": \"${WEBHOOK_SECRET}\",
    \"allowed_updates\": [\"message\", \"callback_query\"],
    \"drop_pending_updates\": true
  }"
```

## Update `DEFAULT_RELAY_URL`

Open [`src/shared/paths.ts`](src/shared/paths.ts) and change `DEFAULT_RELAY_URL` to the URL from step 4. Rebuild:

```bash
npm run build
```

End users will pair against this by default. Self-hosters can override with `DUCKLING_RELAY_URL=…`.

## Verify

```bash
# Health check
curl https://duckling-relay.<your-subdomain>.workers.dev/healthz
# expected: {"ok":true,"bot":"DucklingCli_Bot"}

# Webhook info
curl "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
# expected: { "url": ".../tg-webhook", "pending_update_count": 0, ... }
```

## Pair a device

```bash
duckling setup
# follow the URL/QR, tap Start in Telegram, you're paired
```

## Optional — admin escape hatch

If you want `duckling relay bind`-style fallback for when Telegram deep links misbehave, set an admin token:

```bash
ADMIN_TOKEN=$(openssl rand -hex 32)
echo "$ADMIN_TOKEN" | npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

Then bind via:

```bash
curl -X POST https://duckling-relay.<your-subdomain>.workers.dev/pair/bind \
  -H "authorization: Bearer ${ADMIN_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"pairToken": "<token from duckling setup>", "tgUserId": "<numeric tg id>"}'
```

## Day-to-day

- **Logs:** `npm run worker:tail` (streams from `wrangler tail`)
- **Local dev:** `npm run worker:dev` — runs the Worker on localhost. Telegram webhook won't reach localhost, so TG flows need a deploy or a tunnel (`wrangler dev --remote`).
- **Re-deploy after code changes:** `npm run worker:deploy`
- **Rotate bot token:** `npx wrangler secret put TELEGRAM_BOT_TOKEN`, then re-deploy.
- **Free tier limits:** Workers free tier gives 100k requests/day, Durable Objects free tier gives 1M ops/day. For dozens-of-users scale, you'll never hit them.

## Costs

For personal / small-team use: **$0**. Workers free tier covers up to 100k requests/day and Durable Objects free tier covers 1M ops/day. duckling's volume per user is single-digits per session.

If you ever cross into paid, the relevant lines are:
- Workers Paid: $5/mo flat → 10M requests, then $0.30/M
- Durable Objects: $0.20 per 1M requests, $0.20 per 1M storage operations

You'd need hundreds of active users to feel anything.
