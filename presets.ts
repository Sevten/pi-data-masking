/**
 * Built-in, versioned masking presets. Config files reference these by name;
 * the loader expands each reference into an ordinary runtime regex rule.
 */

import type { PreserveStructure, RegexMaskingRule } from "./masker.ts";

const IPV4_OCTET = "(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)";

export interface MaskingPreset {
  name: string;
  label: string;
  description: string;
  example: string;
  pattern: string;
  flags?: string;
  preserveStructure?: PreserveStructure;
}

export const MASKING_PRESETS: readonly MaskingPreset[] = [
  {
    name: "github-pat",
    label: "GitHub access token",
    description: "GitHub tokens: classic (ghp_), OAuth (gho_), GitHub App (ghu_/ghs_), refresh (ghr_), and fine-grained (github_pat_)",
    example: "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
    pattern: "\\bgh[posur]_[A-Za-z0-9]{36}\\b|\\bgithub_pat_[A-Za-z0-9_]{22,}\\b",
  },
  {
    name: "npm-token",
    label: "npm access token",
    description: "npm access tokens beginning with npm_",
    example: "npm_1234567890abcdefghijklmnopqrstuvwxyz",
    pattern: "\\bnpm_[A-Za-z0-9]{36}\\b",
  },
  {
    name: "huggingface-token",
    label: "Hugging Face access token",
    description: "Hugging Face access tokens beginning with hf_",
    example: "hf_1234567890abcdefghijklmnopqrstuvwx",
    pattern: "\\bhf_[A-Za-z0-9]{34,}\\b",
  },
  {
    name: "aws-access-key-id",
    label: "AWS access key ID",
    description: "AWS access key IDs beginning with AKIA",
    example: "AKIAIOSFODNN7EXAMPLE",
    pattern: "\\bAKIA[0-9A-Z]{16}\\b",
  },
  {
    name: "slack-token",
    label: "Slack token",
    description: "Slack bot, user, app, refresh, and legacy tokens",
    example: "xoxb-1234567890-abcdefghijkl",
    pattern: "\\bxox[eabprs]-[A-Za-z0-9-]{10,}\\b",
  },
  {
    name: "openai-api-key",
    label: "OpenAI API key",
    description: "OpenAI API keys beginning with sk- (including project and service-account keys)",
    example: "sk-proj-4fJ8xQ2mL9vBnR7sT3wYhKdPcE6uZa1XoI5gyU0bVqN",
    pattern: "\\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\\b",
  },
  {
    name: "anthropic-api-key",
    label: "Anthropic API key",
    description: "Anthropic API keys beginning with sk-ant-",
    example: "sk-ant-api03-9dWf2xQ7mLvBnR4sT8wYhKdPcE6uZa",
    pattern: "\\bsk-ant-[A-Za-z0-9_-]{20,}\\b",
  },
  {
    name: "google-api-key",
    label: "Google API key",
    description: "Google API keys beginning with AIza (Cloud Platform and Maps)",
    example: "AIzaSyA4fJ8xQ2mL9vBnR7sT3wYhKdPcE6uZa1X",
    pattern: "\\bAIza[0-9A-Za-z_-]{35}\\b",
  },
  {
    name: "cloudflare-api-token",
    label: "Cloudflare API credential",
    description: "Cloudflare API credentials: prefixed format (cfk_/cfut_/cfat_ + 40 chars + 8-char hex checksum) and legacy Global API keys (37 hex chars)",
    example: "cfut_J8xQ2mL9vBnR7sT3wYhKdPcE6uZa1XoI5gyU0ba1b2c3d4e5",
    pattern: "\\bc(?:fk|fut|fat)_[A-Za-z0-9]{40}[0-9a-fA-F]{8}\\b|\\b[A-Fa-f0-9]{37}\\b",
  },
  {
    name: "gitlab-pat",
    label: "GitLab personal access token",
    description: "GitLab personal access tokens beginning with glpat-",
    example: "glpat-J8xQ2mL9vBnR7sT3wYhK",
    pattern: "\\bglpat-[A-Za-z0-9_-]{20,}(?:\\.\\d{2}\\.[A-Za-z0-9]+)?\\b",
  },
  {
    name: "stripe-secret-key",
    label: "Stripe secret key",
    description: "Stripe secret keys, restricted keys, and webhook signing secrets (sk_/rk_/whsec_)",
    example: "sk_live_J8xQ2mL9vBnR7sT3wYhKdPc",
    pattern: "\\b[sr]k_(?:test|live)_[A-Za-z0-9]{16,}\\b|\\bwhsec_[A-Za-z0-9]{16,}\\b",
  },
  {
    name: "sendgrid-api-key",
    label: "SendGrid API key",
    description: "SendGrid API keys starting with SG. and two dot-separated segments",
    example: "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",
    pattern: "\\bSG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}\\b",
  },
  {
    name: "twilio-api-key",
    label: "Twilio API key SID",
    description: "Twilio API key SIDs beginning with SK followed by 32 hex characters",
    example: "SK0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d",
    pattern: "\\bSK[0-9a-fA-F]{32}\\b",
  },
  {
    name: "telegram-bot-token",
    label: "Telegram bot token",
    description: "Telegram bot tokens (bot ID, colon, token starting with AA)",
    example: "1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawk",
    pattern: "\\b[0-9]{8,10}:[A-Za-z0-9_-]{35}\\b",
  },
  {
    name: "linear-api-key",
    label: "Linear API key",
    description: "Linear API keys beginning with lin_api_",
    example: "lin_api_J8xQ2mL9vBnR7sT3wYhKdPcE6uZa1XoI5gyU0b",
    pattern: "\\blin_api_[A-Za-z0-9]{38,}\\b",
  },
  {
    name: "groq-api-key",
    label: "Groq API key",
    description: "Groq API keys beginning with gsk_",
    example: "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",
    pattern: "\\bgsk_[A-Za-z0-9]{48,}\\b",
  },
  {
    name: "openrouter-api-key",
    label: "OpenRouter API key",
    description: "OpenRouter API keys: sk-or-v1- followed by 64 lowercase hex characters",
    example: "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",
    pattern: "\\bsk-or-v1-[0-9a-f]{64}\\b",
  },
  {
    name: "xai-api-key",
    label: "xAI API key",
    description: "xAI (Grok) API keys beginning with xai-",
    example: "xai-J8xQ2mL9vBnR7sT3wYhKdPcE6uZa1XoI5gyU0bwvFtRnMkLpQrZeCsVaHoDlGjWfEyUiOaPzXcBmNkRt",
    pattern: "\\bxai-[A-Za-z0-9]{60,}\\b",
  },
  {
    name: "cerebras-api-key",
    label: "Cerebras API key",
    description: "Cerebras API keys beginning with csk-",
    example: "csk-J8xQ2mL9vBnR7sT3wYhKdPcE6uZa1XoI5gyU0bwvFtRnMk",
    pattern: "\\bcsk-[A-Za-z0-9]{20,}\\b",
  },
  {
    name: "vercel-ai-gateway-key",
    label: "Vercel AI Gateway API key",
    description: "Vercel AI Gateway API keys beginning with vck_",
    example: "vck_J8xQ2mL9vBnR7sT3wYhKdPcE6uZa1XoI5gyU0",
    pattern: "\\bvck_[A-Za-z0-9]{20,}\\b",
  },
  {
    name: "kimi-api-key",
    label: "Kimi (Moonshot) API key",
    description: "Kimi Code API keys beginning with sk-kimi-",
    example: "sk-kimi-J8xQ2mL9vBnR7sT3wYhKdPcE6uZa1XoI5gyU0",
    pattern: "\\bsk-kimi-[A-Za-z0-9_-]{20,}\\b",
  },
  {
    name: "nvidia-api-key",
    label: "NVIDIA API key",
    description: "NVIDIA (NIM) API keys beginning with nvapi-",
    example: "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",
    pattern: "\\bnvapi-[A-Za-z0-9]{20,}\\b",
  },
  {
    name: "qwen-plan-api-key",
    label: "Qwen plan API key",
    description: "Qwen Coding Plan (sk-sp-) and Token Plan (sk-ws-) API keys",
    example: "sk-sp-J8xQ2mL9vBnR7sT3wYhKdPc",
    pattern: "\\bsk-(?:sp|ws)-[A-Za-z0-9]{16,}\\b",
  },
  {
    name: "brave-search-api-key",
    label: "Brave Search API key",
    description: "Brave Search API keys beginning with BSA",
    example: "BSAJ8xQ2mL9vBnR7sT3wYhKdPcE6uZa1XoI5gyU0bwvF",
    pattern: "\\bBSA[A-Za-z0-9_-]{24,}\\b",
  },
  {
    name: "perplexity-api-key",
    label: "Perplexity API key",
    description: "Perplexity API keys beginning with pplx-",
    example: "pplx-J8xQ2mL9vBnR7sT3wYhKdPc",
    pattern: "\\bpplx-[A-Za-z0-9]{16,}\\b",
  },
  {
    name: "tavily-api-key",
    label: "Tavily API key",
    description: "Tavily API keys beginning with tvly-",
    example: "tvly-dev-J8xQ2mL9vBnR7sT3wYhKdPc",
    pattern: "\\btvly-[A-Za-z0-9-]{16,}\\b",
  },
  {
    name: "firecrawl-api-key",
    label: "Firecrawl API key",
    description: "Firecrawl API keys: fc- followed by 32 lowercase hex characters (UUID without dashes)",
    example: "fc-3d478a296e59403e85c794aba81ffd2a",
    pattern: "\\bfc-[0-9a-f]{32}\\b",
  },
  {
    name: "jina-api-key",
    label: "Jina AI API key",
    description: "Jina AI API keys beginning with jina_",
    example: "jina_J8xQ2mL9vBnR7sT3wYhKdPc",
    pattern: "\\bjina_[A-Za-z0-9]{16,}\\b",
  },
  {
    name: "tinyfish-api-key",
    label: "TinyFish API key",
    description: "TinyFish API keys beginning with sk-tinyfish-",
    example: "sk-tinyfish-J8xQ2mL9vBnR7sT3wYhKdPc",
    pattern: "\\bsk-tinyfish-[A-Za-z0-9]{16,}\\b",
  },
  {
    name: "atlassian-api-token",
    label: "Atlassian API token",
    description: "Atlassian (Jira/Confluence) API tokens beginning with ATATT",
    example: "ATATTJ8xQ2mL9vBnR7sT3wYhKdPcE6uZa1XoI5gyU0bwv",
    pattern: "\\bATATT[A-Za-z0-9_-]{40}\\b",
  },
  {
    name: "digitalocean-api-token",
    label: "DigitalOcean API token",
    description: "DigitalOcean tokens: do[pao]_v1_ followed by 64 lowercase hex characters",
    example: "dop_v1_0e6f44a47a05f1dad2ad7e88c4c1d6b77688157716fb1a5271146f7464951c96",
    pattern: "\\bdo[pao]_v1_[0-9a-f]{64}\\b",
  },
  {
    name: "sentry-auth-token",
    label: "Sentry auth token",
    description: "Sentry auth tokens beginning with sntrys_",
    example: "sntrys_eyJpYXQiOjE2ODczMzY1NDMsInVybCI6bnVsbH0_NzJkYzA3NzMyZTRjNGE2",
    pattern: "\\bsntrys_[A-Za-z0-9+/=_]{30,}\\b",
  },
  {
    name: "shopify-access-token",
    label: "Shopify access token",
    description: "Shopify Admin API tokens (shpat_), delegate tokens (shppa_), and app client secrets (shpss_)",
    example: "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",
    pattern: "\\bshp(?:at|pa|ss)_[a-f0-9]{32}\\b",
  },
  {
    name: "notion-integration-token",
    label: "Notion integration token",
    description: "Notion integration secrets: current ntn_ and legacy secret_ prefixes",
    example: "ntn_J8xQ2mL9vBnR7sT3wYhKdPcE6uZa1XoI5gyU0bwvFtRnMkLp",
    pattern: "\\b(?:ntn|secret)_[A-Za-z0-9]{40,}\\b",
  },
  {
    name: "hubspot-private-app-token",
    label: "HubSpot private app token",
    description: "HubSpot private app tokens: pat-<region>- followed by a UUID",
    example: "pat-na1-2c5a1b3d-9f4e-4a7b-8c6d-1e2f3a4b5c6d",
    pattern: "\\bpat-(?:na|eu|ap)\\d-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b",
  },
  {
    name: "dockerhub-pat",
    label: "Docker Hub personal access token",
    description: "Docker Hub personal access tokens beginning with dckr_pat_",
    example: "dckr_pat_J8xQ2mL9vBnR7sT3wYhKdPcE6uZa",
    pattern: "\\bdckr_pat_[A-Za-z0-9_-]{27,64}\\b",
  },
  {
    name: "figma-access-token",
    label: "Figma access token",
    description: "Figma personal access tokens: current figu_ and legacy figd_ prefixes",
    example: "figd_J8xQ2mL9vBnR7sT3wYhKdPc",
    pattern: "\\bfig[du]_[A-Za-z0-9-]{20,}\\b",
  },
  {
    name: "resend-api-key",
    label: "Resend API key",
    description: "Resend API keys beginning with re_",
    example: "re_J8xQ2mL9vBnR7sT3wYhKdPcE6uZa",
    pattern: "\\bre_[A-Za-z0-9]{20,}\\b",
  },
  {
    name: "supabase-access-token",
    label: "Supabase access token",
    description: "Supabase personal access tokens: sbp_ followed by 40 lowercase hex characters",
    example: "sbp_fc0e6f44a47a05f1dad2ad7e88c4c1d6b7768815",
    pattern: "\\bsbp_(?:oauth_)?[0-9a-f]{40}\\b",
  },
  {
    name: "supabase-secret-key",
    label: "Supabase secret key",
    description: "Supabase new-style secret API keys beginning with sb_secret_",
    example: "sb_secret_J8xQ2mL9vBnR7sT3wYhKdPc",
    pattern: "\\bsb_secret_[A-Za-z0-9]{20,}\\b",
  },
  {
    name: "neon-api-key",
    label: "Neon API key",
    description: "Neon API keys beginning with napi_",
    example: "napi_J8xQ2mL9vBnR7sT3wYhKdPcE6uZa1XoI5gyU0bwvFtRnMkLp",
    pattern: "\\bnapi_[A-Za-z0-9]{40,}\\b",
  },
  {
    name: "newrelic-api-key",
    label: "New Relic API key",
    description: "New Relic user API keys (NRAK-) and API access keys (NRAA-)",
    example: "NRAK-J8xQ2mL9vBnR7sT3wYhKdPcE6uZa",
    pattern: "\\bNRA[KA]-[A-Za-z0-9]{20,}\\b",
  },
  {
    name: "grafana-service-account-token",
    label: "Grafana service account token",
    description: "Grafana service account tokens: glsa_ + token body + 8-character hex checksum",
    example: "glsa_J8xQ2mL9vBnR7sT3wYhKdPcE6uZa1X_5b582697",
    pattern: "\\bglsa_[A-Za-z0-9]{20,}_[0-9a-f]{8}\\b",
  },
  {
    name: "vault-token",
    label: "HashiCorp Vault token",
    description: "HashiCorp Vault tokens: hvs. (service), hvb. (batch), and hvr. (recovery) prefixes",
    example: "hvs.J8xQ2mL9vBnR7sT3wYhKdPcE6uZa1XoI5gyU0",
    pattern: "\\bhv[sbr]\\.[A-Za-z0-9]{20,}\\b",
  },
  {
    name: "planetscale-service-token",
    label: "PlanetScale service token",
    description: "PlanetScale service tokens beginning with pscale_tkn_",
    example: "pscale_tkn_J8xQ2mL9vBnR7sT3wYhKdPc",
    pattern: "\\bpscale_tkn_[A-Za-z0-9]{20,}\\b",
  },
  {
    name: "square-access-token",
    label: "Square access token",
    description: "Square access tokens: EAAA followed by 60 characters",
    example: "EAAAJ8xQ2mL9vBnR7sT3wYhKdPcE6uZa1XoI5gyU0bwvFtRnMkLpQrZeCsVaHoDl",
    pattern: "\\bEAAA[A-Za-z0-9-+=]{60}\\b",
  },
  {
    name: "woocommerce-consumer-key",
    label: "WooCommerce consumer key/secret",
    description: "WooCommerce REST API consumer keys (ck_) and secrets (cs_): 64 lowercase hex characters",
    example: "cs_0e6f44a47a05f1dad2ad7e88c4c1d6b77688157716fb1a5271146f7464951c96",
    pattern: "\\bc[ks]_[0-9a-f]{64}\\b",
  },
  {
    name: "mercadopago-access-token",
    label: "Mercado Pago access token",
    description: "Mercado Pago access tokens beginning with APP_USR-",
    example: "APP_USR-1585551492-030918-J8xQ2mL9vBnR7sT3wYhKdPcE6uZa1XoI-2880736",
    pattern: "\\bAPP_USR-[0-9]+-[0-9]+-[A-Za-z0-9-]{16,}-[0-9]+\\b",
  },
  {
    name: "flutterwave-secret-key",
    label: "Flutterwave secret key",
    description: "Flutterwave secret keys: FLWSECK- followed by 32 lowercase hex characters and -X suffix",
    example: "FLWSECK-0e6f44a47a05f1dad2ad7e88c4c1d6b7-X",
    pattern: "\\bFLWSECK-[0-9a-f]{32}-X\\b",
  },
  {
    name: "paystack-clerk-secret-key",
    label: "Paystack/Clerk live secret key",
    description: "Live secret keys with the shared sk_live_ prefix used by Paystack and Clerk",
    example: "sk_live_J8xQ2mL9vBnR7sT3wYhKdPcE6uZa",
    pattern: "\\bsk_live_[A-Za-z0-9]{16,}\\b",
  },
  {
    name: "braintree-access-token",
    label: "Braintree access token",
    description: "Braintree OAuth access tokens: access_token$production$ + id + 32-character hex secret",
    example: "access_token$production$x8y2k4m6q8w0r2t4$0e6f44a47a05f1dad2ad7e88c4c1d6b7",
    pattern: "\\baccess_token\\$production\\$[0-9a-z]{16}\\$[0-9a-f]{32}\\b",
  },
  {
    name: "brevo-api-key",
    label: "Brevo API key",
    description: "Brevo (Sendinblue) API keys: xkeysib- followed by 64 lowercase hex characters and a suffix",
    example: "xkeysib-a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456-Ab1Cd2Ef3Gh4",
    pattern: "\\bxkeysib-[0-9a-f]{64}-[A-Za-z0-9]+\\b",
  },
  {
    name: "posthog-personal-api-key",
    label: "PostHog personal API key",
    description: "PostHog personal API keys beginning with phx_",
    example: "phx_J8xQ2mL9vBnR7sT3wYhKdPcE6uZa1XoI5gyU0bwvFtRnMkLp",
    pattern: "\\bphx_[A-Za-z0-9]{43,48}\\b",
  },
  {
    name: "mapbox-secret-token",
    label: "Mapbox secret token",
    description: "Mapbox secret access tokens: sk. followed by a JWT (pk. public tokens are not matched)",
    example: "sk.eyJ1IjoiZXhhbXBsZS11c2VyIiwiYSI6IjEyMzQ1Njc4OTAifQ.J8xQ2mL9vBnR7sT3wYhKdPcE6uZa1XoI",
    pattern: "\\bsk\\.[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}\\b",
  },
  {
    name: "shippo-api-token",
    label: "Shippo API token",
    description: "Shippo live API tokens beginning with shippo_live_",
    example: "shippo_live_J8xQ2mL9vBnR7sT3wYhKdPcE6uZa",
    pattern: "\\bshippo_live_[A-Za-z0-9]{16,}\\b",
  },
  {
    name: "stytch-secret-key",
    label: "Stytch secret key",
    description: "Stytch backend API secrets: secret-live- (production) and secret-test- prefixes",
    example: "secret-live-IJ7zLTgXp8xoS7yXO2xavNxZTbYfvm-2nZM=",
    pattern: "\\bsecret-(?:live|test)-[A-Za-z0-9_-]{20,}={0,2}\\b",
  },
  {
    name: "elevenlabs-api-key",
    label: "ElevenLabs API key",
    description: "ElevenLabs API keys: sk_ followed by 32-48 lowercase hex characters",
    example: "sk_7b3e5d8c1a9f4e2b6c8d3a5e9f1b7c4d1a2c5e8f0b9d6a3c",
    pattern: "(?<![A-Za-z0-9_])sk_[0-9a-f]{32,48}(?![A-Za-z0-9_])",
  },
  {
    name: "tailscale-key",
    label: "Tailscale key",
    description: "Tailscale API access tokens (tskey-api-), auth keys (tskey-auth-), and OAuth client secrets (tskey-client-)",
    example: "tskey-api-J8xQ2mL9vBnR7sT3-091234567890ABCDEF",
    pattern: "\\btskey-(?:api|auth|client)-[A-Za-z0-9-]{10,}\\b",
  },
  {
    name: "doppler-token",
    label: "Doppler token",
    description: "Doppler personal tokens (dp.pt.) and service tokens (dp.st.): followed by 40-44 alphanumeric characters",
    example: "dp.st.dev.J8xQ2mL9vBnR7sT3wYhKdPcE6uZa1XoI5gyU0bwvF",
    pattern: "\\bdp\\.(?:pt|st(?:\\.[a-z0-9_-]{2,35})?\\.)[A-Za-z0-9]{40,44}\\b",
  },
  {
    name: "onepassword-service-account-token",
    label: "1Password service account token",
    description: "1Password service account tokens: ops_ followed by a JWT",
    example: "ops_eyJ1IjoiZXhhbXBsZS11c2VyIiwiYSI6IjEyMzQ1Njc4OTAifQ.J8xQ2mL9vBnR7sT3wYhKdPcE6uZa1XoI",
    pattern: "\\bops_[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}\\b",
  },
  {
    name: "netlify-token",
    label: "Netlify token",
    description: "Netlify authentication tokens: nfp_ (personal), nfc_ (CLI), nfo_ (OAuth), nfu_ (website), and nfb_ (build)",
    example: "nfp_J8xQ2mL9vBnR7sT3wYhKdPcE6uZa1XoI",
    pattern: "\\bnf[p.cou]_[A-Za-z0-9_-]{20,}\\b",
  },
  {
    name: "render-api-key",
    label: "Render API key",
    description: "Render API keys beginning with rnd_",
    example: "rnd_J8xQ2mL9vBnR7sT3wYhKdPcE6uZa1XoI",
    pattern: "\\brnd_[A-Za-z0-9]{20,}\\b",
  },
  {
    name: "pulumi-access-token",
    label: "Pulumi access token",
    description: "Pulumi Cloud access tokens beginning with pul-",
    example: "pul-J8xQ2mL9vBnR7sT3wYhKdPcE6uZa1XoI5gyU",
    pattern: "\\bpul-[A-Za-z0-9]{20,}\\b",
  },
  {
    name: "jwt",
    label: "JSON Web Token",
    description: "JSON Web Tokens with three base64url segments",
    example: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signatureABC",
    pattern: "\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b",
  },
  {
    name: "pem-private-key",
    label: "PEM private key",
    description: "PEM private-key body while preserving BEGIN/END markers",
    example: "-----BEGIN PRIVATE KEY----- … -----END PRIVATE KEY-----",
    pattern: "-----BEGIN [A-Z ]*PRIVATE KEY-----([\\s\\S]*?)-----END [A-Z ]*PRIVATE KEY-----",
  },
  {
    name: "bearer-token",
    label: "Bearer token",
    description: "Bearer token value while preserving the authorization prefix",
    example: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.demo-token",
    pattern: "Authorization:\\s*Bearer\\s+([A-Za-z0-9._-]+)",
    flags: "i",
  },
  {
    name: "database-userinfo",
    label: "Database connection credentials",
    description: "Credentials in common database and message-queue connection strings",
    example: "postgresql://admin:secret@db.example/app",
    pattern: "(?:postgresql|mysql|mariadb|redis|mongodb(?:\\+srv)?|amqp|amqps):\\/\\/([^\\s]+)@",
  },
  {
    name: "private-ipv4",
    label: "Private IPv4 address",
    description: "RFC 1918 private IPv4 addresses; preserves the first two octets by default",
    example: "192.168.10.25",
    pattern: `\\b(?:10\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}|172\\.(?:1[6-9]|2\\d|3[01])\\.${IPV4_OCTET}\\.${IPV4_OCTET}|192\\.168\\.${IPV4_OCTET}\\.${IPV4_OCTET})\\b`,
    preserveStructure: { keepIPv4Octets: 2 },
  },
  {
    name: "public-ipv4",
    label: "Public IPv4 address",
    description: "Publicly routable IPv4 addresses, excluding private and common special-use ranges",
    example: "8.8.8.8",
    pattern: `\\b(?!(?:0|10|127)\\.)(?!100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.)(?!169\\.254\\.)(?!172\\.(?:1[6-9]|2\\d|3[01])\\.)(?!192\\.0\\.(?:0|2)\\.)(?!192\\.88\\.99\\.)(?!192\\.168\\.)(?!198\\.(?:18|19)\\.)(?!198\\.51\\.100\\.)(?!203\\.0\\.113\\.)(?!(?:22[4-9]|23\\d|24\\d|25[0-5])\\.)${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}\\b`,
  },
];

const PRESET_BY_NAME = new Map(MASKING_PRESETS.map((preset) => [preset.name, preset]));

export function getMaskingPreset(name: string): MaskingPreset | undefined {
  return PRESET_BY_NAME.get(name);
}

export function expandMaskingPreset(
  preset: MaskingPreset,
  overrides: {
    id: string;
    name?: string;
    enabled?: boolean;
    description?: string;
    lowEntropy?: boolean;
    preserveStructure?: PreserveStructure;
  },
): RegexMaskingRule {
  return {
    id: overrides.id,
    name: overrides.name,
    type: "regex",
    enabled: overrides.enabled,
    description: overrides.description ?? `${preset.description} · Example: ${preset.example}`,
    pattern: preset.pattern,
    flags: preset.flags,
    lowEntropy: overrides.lowEntropy,
    preserveStructure: overrides.preserveStructure ?? (
      preset.preserveStructure ? { ...preset.preserveStructure } : undefined
    ),
  };
}
