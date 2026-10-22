# Platform account

Optional native OAuth 2.0 / OpenID Connect sign-in for Desktop. Local tasks and user-supplied model API keys do not require an account.

The shared module uses pinned `openid-client` 6.8.8 for discovery, Authorization Code + PKCE S256, state/nonce checks, ID-token signature verification, UserInfo, refresh and revocation. The browser callback listens only on `127.0.0.1:0` at `/callback`. Obol’s documented `/oauth/code` page provides a `code#state` paste fallback; it uses the same OIDC library, PKCE and nonce checks, with the redirect URI bound to the chosen path. HTTPS issuers are required; literal loopback HTTP is accepted for development. It never uses an embedded login page, client secret, password grant, implicit grant or unsigned token parsing.

## Configure

Register a **native/public** client in the platform with loopback callbacks enabled. A real client ID is required; this repository does not invent or ship a production registration. Desktop: Settings → Platform account → Platform connection. Environment overrides are supported:

| Variable | Meaning |
| --- | --- |
| `INDUSTRIAL_AUTH_ISSUER` | Issuer origin; defaults to `https://auth.zhiman.cn` |
| `INDUSTRIAL_AUTH_CLIENT_ID` | Registered native client ID; required |
| `INDUSTRIAL_AUTH_AUDIENCE` | Application slug the native client belongs to; distinct from client ID |
| `INDUSTRIAL_AUTH_REMOTE_ORIGIN` | Explicit remote service origin; leave empty until deployed |
| `INDUSTRIAL_AUTH_REMOTE_AUDIENCE` | Operator-only service audience, defaults to `industrial-mcp-remote`; also supported as `remoteAudience` in config.json |
| `INDUSTRIAL_AUTH_MODEL_BASE_URL` | Explicit model endpoint, including `/v1` when required |

One sign-in, one rotating refresh family, and a separate access token for each service. Login does not request a resource, so lack of remote access cannot prevent sign-in or model use. On demand the shared manager refreshes with RFC 8707 `resource`: the configured model base URL for audience `obol-api`, or the configured remote origin for its service audience. Obol supports matching a registered resource's path prefixes. The remote deployment must register the origin used here, not only a narrower MCP path. No second native client or browser authorization is needed. The account UI remains unchanged; service audiences and caches stay internal.

Existing main-branch login sessions retain their binding and acquire service tokens lazily. Cache entries bind both resource and audience. Changing the operator's remote audience cannot reuse its old token. Credentials from the unmerged dual-grant experiment are not imported.

## Credentials and lifecycle

- Desktop keeps credential material in the main process and encrypts it with Electron `safeStorage`. Linux `basic_text` is rejected. If encryption is unavailable, credentials stay in memory for that app process. Locked/corrupt storage does not prevent local app startup.
- `SessionStore.transaction` serializes local and inter-process operations using `proper-lockfile`; refresh re-reads the latest saved token inside the lock and atomically saves its replacement. Login and both service tokens share this lock; each resource keeps its own cache. Access tokens refresh on demand 60 seconds before expiry. No background polling is required.
- A durable refresh-in-progress marker prevents replay after a crash or ambiguous network response. `invalid_grant`, uncertain refresh or a crash marker requires sign-in again. Transient discovery failure before refresh leaves the saved refresh token intact.
- `invalid_target` leaves the refresh family unconsumed: only that service cache is evicted, sign-in and other service tokens remain usable.
- Logout cancels pending login, waits for late exchanges/refresh, attempts the latest refresh-token revocation and removes local credentials even when revocation fails. The UI reports unsuccessful server revocation. It does not sign out the entire system browser's SSO session or cancel submitted remote jobs.
- IPC exposes only curated account state, non-secret configuration and the current authorization URL (never the PKCE verifier). Pasted codes are submitted once, cleared from the input and never persisted or logged. Tokens do not enter renderer storage, project files, Domain Packs, model context or diagnostic events.

## Cloud consumers

This implementation targets Obol's existing [account API access contract](https://github.com/zhimanai/obol/blob/main/docs/account-api-access.md), without changing or deploying Obol. Direct API consumers create their own keys in Console; Desktop account mode uses login access tokens and never creates a user API key. Obol may provision the user's personal billing account on first inference; its internal login billing record has no usable API-key secret. Production model acceptance and real remote connectivity remain separate deployment checks.

Use `https://api.zhiman.cn/v1` for the OpenAI model protocol, or `https://api.zhiman.cn/anthropic/v1` for Anthropic. Model names, context limits and protocol stay in the existing model settings. There is no silent API-key fallback.

The remote client obtains a token per request through an injected credential provider. Only GET + `401 WWW-Authenticate: Bearer error="invalid_token"` retries once after refresh. It never retries mutation requests or a `403`; existing request journals remain authoritative. Account subject participates in remote binding identity, and existing clients reject account changes.

Desktop's **Use platform account for model API** uses a bounded loopback model proxy. It accepts a random local session key, fixed routes and an exact upstream; platform tokens are verified for issuer, exact service audience, subject, client ID, signature, expiry and `typ=at+jwt` before forwarding. An explicit `401 WWW-Authenticate: Bearer error="invalid_token"` refreshes and retries the model request once (including generation); plain 401, transport failure and other statuses never replay. Upstream error bodies are discarded; 402/403/429 receive fixed balance/access/rate-limit explanations. Streaming responses are forwarded without whole-response buffering. The local key is all Kimi receives. BYOK remains a separate model source. Logout closes the local proxy; the selected platform source does not silently fall back to a saved API key. Model name/protocol/context parameters remain in Model API settings.

## Desktop sign-in

Use Settings → Platform account to sign in through the system browser. If the local listener or browser is unavailable, copy the authorization link and paste the complete `code#state` into the masked application input. The first valid loopback or paste response wins; invalid paste can be retried. Cancellation, timeout and logout invalidate the pending attempt. Device authorization is not implemented, and tokens are never printed.

## Verification

```sh
pnpm --filter @industrial-agent-harness/harness-auth test
pnpm --filter @industrial-agent-harness/desktop build
pnpm --filter @industrial-agent-harness/desktop test:account
pnpm test:architecture-contract
pnpm test:architecture
```

The account selftest uses a controlled signed OIDC provider and the actual preload/main/renderer path, without SMS or production credentials. When socket listening is prohibited, `AUTH_TEST_TRANSPORT=memory node --test packages/harness-auth/tests/*.test.cjs` exercises the same HTTP handlers and real protocol/JWT libraries using in-memory transport. This is protocol validation, not OS loopback, browser or packaged-keychain acceptance.

On 2026-10-15, 88 targeted account/adapter/remote/model/language tests passed with real loopback sockets. Obol's existing `TestPostgresM0/account_api_access/real_harness_client` also passed with race detection against unmodified main `7137bd8` and this checkout, using temporary PostgreSQL/Redis and synthetic inference. It exercised sign-in, model proxy calls, resource refresh and immediate rejection of the old model token after logout. Production inference and a deployed remote MCP were not exercised.

Public references: [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252), [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700), [openid-client](https://github.com/panva/openid-client), [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).
