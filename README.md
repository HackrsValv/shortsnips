# The Snip Report

Prepared October 8, 2026. Not deployed. JavaScript ES module for Cloudflare Workers.

## Flow

Existing self-hosted Snipd sync -> Notion data source -> publish tag -> signed Notion webhook (IDs only) -> one SQLite-backed Durable Object -> fetch latest Notion notes -> Spiral writing API -> Buttondown draft -> human review/send -> verify Buttondown status `sent` -> mark original Notion notes published.

The Durable Object gives the Worker a persistent job ledger, sequential processing, debounced batching, retries, and alarm-based continuation without an always-running server. No frequent Notion polling: query after relevant events, optionally daily reconcile. Active draft jobs check Buttondown hourly; the reviewed API-send route checks after five minutes. A single issue batches up to 20 eligible notes within a 90-second debounce window. This is not a weekly edition scheduler.

## Safety and scope

- No external deployment, DNS edit, paid API request or newsletter send has happened.
- Draft-only by default. Creating a draft does not mean publication. `Published` stays false until Buttondown reports `sent`.
- The API-send route is disabled. Enable only after the owner approves the sending workflow. Each invocation requires the exact reviewed content hash and a fixed audience acknowledgement. Initial release supports only the full newsletter audience, not segmented sends.
- Human review must include recipients, facts, links, attribution and final words in Buttondown. A hash protects content, not permission; the operator still needs actual user approval. Subscribers can change between review and send; use Buttondown's own send review when exact audience control matters.
- Only tagged notes in the configured Notion data source are fetched. Their title, rich text, source URLs, tags and date properties go to Spiral by default. Confirm this disclosure scope, language and paid API limits before activation.
- Treat note text as data, not instructions. The model has no tools. Generated claims or links still need review.
- Raw HMAC verification, workspace/subscription allowlists, webhook event dedupe, durable per-note reservations, Buttondown idempotency keys, and persisted stages protect against duplicates.
- Oversized notes fail instead of silently truncating. Children of blocks are read recursively; child pages/databases are not traversed. Unsupported block types and file-hosted attachments are not transcribed. Some Snipd sources may require a custom parser after inspecting a real note.
- No API response bodies or secrets are logged; observability is disabled to avoid leaking the private bootstrap URL. The admin token is a separate generated credential. Cloudflare deployment token is not a runtime secret.
- LLM calls and Cloudflare/Buttondown plans can cost money. Account existence does not establish API/hosting entitlement or approve spending. Check plans and agree limits before activation.

## Files

- `src/worker.js`: ingress, bootstrap, job state machine, Notion/LLM/Buttondown clients, review/send and marking logic.
- `wrangler.jsonc`: Worker and Durable Object bindings, non-secret configuration.
- `.dev.vars.example`: empty local secret names.
- `test/worker.test.js`: mocked integration/state-machine tests; no live calls.
- `package.json`, `package-lock.json`: tools and reproducible dependencies.

## Prerequisites and configuration

1. Identify the correct Notion database and its **data source ID** (API version 2025-09-03). Share that database with the integration. Grant read and update capabilities, not access to unrelated content.
2. Inspect actual synced note properties/blocks. Defaults assume `Tags` is multi_select, selected tag is `snip-report`, `Published` is checkbox, `Buttondown Issue ID` is rich_text, `Published At` is date. These names/tag are placeholders, not choices verified from the user's database. Agree them and check the existing sync does not erase publishing fields.
3. Fill `NOTION_DATA_SOURCE_ID`, `NOTION_WORKSPACE_ID`, property/tag settings, issue language, model and size limits in `wrangler.jsonc`. Fill `NOTION_SUBSCRIPTION_ID` after webhook creation.
4. Buttondown API access must be enabled for the account; confirm newsletter identity and API key scope. Default writing provider is Spiral, using `SPIRAL_TOKEN`. Optional explicit `WRITING_PROVIDER=openai` uses `LLM_API_KEY`; it is not required for Spiral and there is no silent fallback. Optional OpenAI base URL is `https://api.openai.com/v1`, model `gpt-4.1-mini`. Other OpenAI-compatible providers can use another base/model but must support JSON-object response format. Anthropic's native API is not drop-in compatible.
5. Cloudflare: choose account ID and the zone for `thesnipreport.com`. Start with the Edit Cloudflare Workers token template scoped to that account, plus Zone Read and DNS Write scoped only to `thesnipreport.com`. Validate actual deployment requirements, especially new Worker/Durable Object migration permissions, before use. Never request a Global API key. If using granular product permissions, creating a new Worker requires Workers product Admin; updating an existing Worker requires Editor. A workers.dev endpoint does not need a custom Worker DNS route. This token is deployment-only.
6. Runtime secrets: `NOTION_TOKEN`, `NOTION_WEBHOOK_SECRET`, `BUTTONDOWN_API_KEY`, `SPIRAL_TOKEN`, `ADMIN_TOKEN`, `NOTION_SETUP_TOKEN`. Generate the last two as separate high-entropy random values in secure storage, not conversation. Never put secrets in committed config or shell arguments. `wrangler secret put NAME` supports stdin; populate through an approved secure deployment process. Vault entries must never be printed to logs or sent in chat.

## Webhook setup sequencing

The Notion verification token does not exist until Notion reaches a deployed endpoint. Four service keys can come first; the webhook token comes during bootstrap. Do not invent a token or wait indefinitely for a nonexistent one.

1. After approval to deploy, make a bootstrap deployment with `NOTION_SETUP_TOKEN` but without `NOTION_WEBHOOK_SECRET`. Use `/setup/<high-entropy-token>` as the final Notion subscription URL. It accepts only a small token receipt and never processes unsigned events.
2. Create a subscription for `page.created`, `page.properties_updated`, `page.content_updated`, `data_source.content_updated`. Notion sends the one-time verification token.
3. Retrieve the token through the authenticated `/admin/setup` endpoint using the admin token, through a secure operator path. Store it in the requested vault entry and Worker secret, without exposing it in chat or logs. Confirm webhook subscription in Notion using that token.
4. Set `NOTION_SUBSCRIPTION_ID`, then deploy the signed-event configuration. Keep `NOTION_SETUP_TOKEN` as the private route identifier because the subscription URL is immutable after verification. The same route now requires HMAC. `/webhook` also accepts signed events. Recreating the subscription to use `/webhook` requires a new verification cycle/token.
5. Subscribe only to the intended workspace; use least-privilege Notion integration access. Initial unsigned verification is validated by the setup URL possession and subsequent authenticated manual confirmation, not by trusting arbitrary payloads.

## DNS and archive

Public DNS queried October 8, 2026:
- `thesnipreport.com` NS: `sue.ns.cloudflare.com`, `duke.ns.cloudflare.com`.
- No answer returned for `short.thesnipreport.com` CNAME, A or NS at that time. Recheck the live Cloudflare zone before creating or replacing anything. AAAA/TXT and other records were not fully audited.

In Buttondown Settings -> Domains -> Hosting domain, choose `short.thesnipreport.com`. Confirm the record shown there, then add:

| Type | Name | Target | Proxy | TTL |
| --- | --- | --- | --- | --- |
| CNAME | short | custom-domains.buttondown.com | DNS only (grey cloud) | Auto |

Do not point this name at the Worker. Buttondown hosts the archive. Do not overwrite an existing conflicting record without approval. Sending-domain NS delegation cannot coexist with the archive CNAME on `short`; use another sending subdomain if needed. Sending-domain authentication is a separate setup. Archive plan entitlement and any cost are still unverified. Buttondown manages archive HTTPS after domain verification; click Check records in its settings and test the actual archive page.

## Local validation and deployment

```sh
npm ci
npm test
npm run check
npx wrangler deploy --dry-run --outdir /tmp/snip-report-build
# Actual deploy only after permissions, spending limits, schema and secrets are confirmed:
# npx wrangler deploy
```

Set `WRANGLER_SEND_METRICS=false` when running Wrangler if anonymous CLI telemetry is unwanted.

The lockfile pins Wrangler 4.148.0 and overrides its optional dev dependency sharp to patched 0.35.5. Local `npm audit` returned zero vulnerabilities after this override. Development/bundling passed; a real local simulator session has not been tested.

No local command above makes real Notion, Buttondown or LLM calls. Do not run a normal deploy merely to validate the code.

## Operations

- `GET /health`: public liveness only.
- `GET /admin/status`: admin bearer required; job IDs, stages, note IDs and reviewed-content hash. Never public.
- `POST /admin/reconcile`: admin bearer required; queues a current-source check, no immediate send. Also recovers exhausted failures.
- `GET /admin/setup`: admin bearer required; returns bootstrap verification token, must be handled as a secret.
- `POST /admin/send`: disabled unless `ALLOW_REVIEWED_SEND=true`. JSON: `job_id`, `review_hash`, `confirm_audience` exactly `all newsletter subscribers`. Requires owner-reviewed exact words/audience. No automatic send on a tag change.
- Optional daily cron is commented out in Wrangler config. Remove comments/add triggers only if needed.

Errors are stored as sanitized codes. Remote HTTP failures/timeouts retry with backoff; after eight failures automatic retries stop. Inspect `/admin/status` and fix the cause before reconcile. There is no configured notification channel or proactive error alert yet. Manual reconciliation is available.

An ambiguous Buttondown creation retries the same persisted UUID and payload. A draft is never regenerated after its payload has been saved. Note reservations keep edited/tagged notes from generating duplicate issues. Deleted drafts require deliberate ledger recovery, not blind new sends. Completed job provenance is retained; define a retention/export policy before long-term operation.

If a source changes after draft creation, API send blocks. After manual Buttondown send, changed notes are not falsely marked published; the `source_changed_after_draft` state requires operator review. Partial Notion marking retries safely; existing published checkboxes allow recovery. The code has no public ledger-reset endpoint. Review/correct the ledger through an authorized migration, not by deleting all Durable Object data.

## Acceptance test after setup

Use a sandbox/test newsletter and one known test note. Confirm a genuine signed event creates exactly one draft, duplicate delivery creates no second draft, unrelated tags do nothing, no note is marked published before sending, and a sent test issue marks only unchanged source notes. Confirm source URLs, attribution and language; review actual Buttondown preview/recipient audience. Verify archive loads at the configured subdomain after publishing. Then activate for real content only within approved scope.

## Sources

- Notion signatures and verification: https://developers.notion.com/reference/webhooks
- IDs-only payloads, event types, retries: https://developers.notion.com/reference/webhooks-events-delivery
- Data source queries: https://developers.notion.com/reference/query-a-data-source
- Buttondown draft/send: https://docs.buttondown.com/drafting-emails-via-the-api
- Buttondown status semantics: https://docs.buttondown.com/api-emails-status
- Buttondown idempotency: https://docs.buttondown.com/api-idempotency-keys
- Body format: https://docs.buttondown.com/api-emails-create
- Archive DNS: https://docs.buttondown.com/hosting-domain
- Cloudflare DNS-only requirement: https://docs.buttondown.com/cloudflare-dns-setup
- Durable Object storage: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- Cloudflare alarms: https://developers.cloudflare.com/durable-objects/api/alarms/
- Token template: https://developers.cloudflare.com/fundamentals/api/reference/template/
- Granular deployment permissions: https://developers.cloudflare.com/workers/authorization/
- OpenAI chat API: https://platform.openai.com/docs/api-reference/chat/create
- DNS NS: https://dns.google/resolve?name=thesnipreport.com&type=NS
- DNS CNAME: https://dns.google/resolve?name=short.thesnipreport.com&type=CNAME


## Spiral revision, October 8, 2026 00:20 EEST

Public REST contract verified at https://api.writewithspiral.com/api/v1/prime and in the official CLI package https://registry.npmjs.org/@every-env/spiral-cli/-/spiral-cli-1.11.0.tgz . Authentication: https://writewithspiral.com/auth.md .

- Default `WRITING_PROVIDER=spiral`, PAT in `SPIRAL_TOKEN`, base `https://api.writewithspiral.com`.
- GET `/api/v1/billing/session-quota`: checks `remaining`, `plan_tier` before generation.
- POST `/api/v1/generate`: multipart FormData, `prompt`, `mode=instant`, `num_drafts=1`, optional complete `style_id`, `workspace_id`, and `saved_prompt`.
- Successful response: `status=complete`, `session_id`, exactly one draft with `title`, `content` and observed `url`. Title becomes subject, content becomes Markdown. No JSON-output prompting of Spiral.
- `needs_input` is a review blocker, never permission to fetch unrelated context. No programmatic auto-follow-up requests.
- The REST guide documents synchronous complete/needs_input responses. MCP background-session wording is not substituted for this contract. Unknown states stop for review.
- Generate requests consume quota/credits. No live generation has run. An ambiguous request timeout records a pending state and requires operator reconciliation, rather than spending again. A captured successful session/result is reused without generation.
- Optional `SPIRAL_WORKSPACE_ID` and `SPIRAL_STYLE_ID` are empty until actual account objects and voice-sample permission are verified.
- GET `/api/v1/writing-styles/`, `/api/v1/workspaces/`, `/api/v1/saved-prompts/` can discover existing choices. POST `/api/v1/saved-prompts/` accepts command, content and optional workspace_id; PUT `/{id}` edits it. Official CLI implements sample upload through POST `/api/v1/setup/add-samples` and style creation through POST `/api/v1/writing-styles/basic`, but exact mutation payloads still require inspection before use.
- A standalone knowledge-entry API is not documented in the public guide inspected. Do not invent a knowledge endpoint. Project context can live in the saved prompt, or verified workspace settings when real account UI is accessible.

Nine mocked tests and dry-run bundling pass with Spiral support. Credentialed setup (Notion, Buttondown, Spiral, Cloudflare) has not been performed; complete it through supported access paths before deployment.


## Scope decisions, October 8, 2026

Owner selected https://thesnipreport.com/ as the writing-reference source, English language, minimal text based strictly on tagged snips, and template review before any generation. This is not an archive-domain relocation request; the existing archive target short.thesnipreport.com stays. No sample uploads, generation or external mutations while the template decision is pending. See post-template-proposal.md.
