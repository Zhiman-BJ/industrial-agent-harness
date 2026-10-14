# Platform account

Optional native OAuth 2.0 / OpenID Connect sign-in for Desktop and CLI. Local tasks and user-supplied model API keys do not require an account.

The shared module uses pinned `openid-client` 6.8.8 for discovery, Authorization Code + PKCE S256, state/nonce checks, ID-token signature verification, UserInfo, refresh and revocation. The browser callback listens only on `127.0.0.1:0` at `/callback`. Obol’s documented `/oauth/code` page provides a `code#state` paste fallback; it uses the same OIDC library, PKCE and nonce checks, with the redirect URI bound to the chosen path. HTTPS issuers are required; literal loopback HTTP is accepted for development. It never uses an embedded login page, client secret, password grant, implicit grant or unsigned token parsing.

Direct API consumers create and manage their own project API key in Obol Console. Our CLI/Desktop apps use the user access token obtained at login for model requests; the apps do not require, create or export an API key for this path.

## Configure

Register a **native/public** client in the platform with loopback callbacks enabled. A real client ID is required; this repository does not invent or ship a production registration. Desktop: Settings → Platform account → Platform connection. Environment overrides are supported:

| Variable | Meaning |
| --- | --- |
| `INDUSTRIAL_AUTH_ISSUER` | Issuer origin; defaults to `https://auth.zhiman.cn` |
| `INDUSTRIAL_AUTH_CLIENT_ID` | Registered native client ID; required |
| `INDUSTRIAL_AUTH_AUDIENCE` | Application slug accepted by the connected services; distinct from client ID |
| `INDUSTRIAL_AUTH_REMOTE_ORIGIN` | Explicit remote service origin |
| `INDUSTRIAL_AUTH_MODEL_BASE_URL` | Explicit model endpoint, including `/v1` when required |

With the existing production registration (`harness-desktop-1`, audience `harness-desktop`), `createAccountManager` maintains two grants under one account view. Models use that native client with RFC 8707 resource `https://api.zhiman.cn` and audience `obol-api`; remote MCP uses client `industrial-agent-harness`, audience `industrial-mcp-remote`. Both subjects must match. Custom deployments can provide `services.model` and `services.remote` with `clientId`, `audience` and optional `resource` in account/config.json; other single-app configurations retain their existing behavior. There is no token exchange or multi-audience credential.

Configure the production OpenAI model base as `https://api.zhiman.cn/v1`; for Anthropic use `https://api.zhiman.cn/anthropic/v1` instead. Leave remote origin empty until a service exists. Both grants can be obtained/refreshed without connecting to a remote MCP endpoint.

## Credentials and lifecycle

- Desktop keeps credential material in the main process and encrypts it with Electron `safeStorage`. Linux `basic_text` is rejected. If encryption is unavailable, credentials stay in memory for that app process. Locked/corrupt storage does not prevent local app startup.
- CLI uses a separate session. Its default store is memory only. `account login --allow-file-store` explicitly opts into a private 0600 file; this is not encrypted storage. Pass the flag to status/logout as well. Windows ACL qualification is pending.
- `SessionStore.transaction` serializes local and inter-process operations using `proper-lockfile`; refresh re-reads the latest saved token inside the lock and atomically saves its replacement. Access tokens refresh on demand 60 seconds before expiry. No background polling is required.
- A durable refresh-in-progress marker prevents replay after a crash or ambiguous network response. `invalid_grant`, uncertain refresh or a crash marker requires sign-in again. Transient discovery failure before refresh leaves the saved refresh token intact.
- Logout cancels pending login, waits for in-flight code exchanges/refresh, attempts revocation of both grants and removes both local credentials even when revocation fails. The UI reports unsuccessful server revocation. It does not sign out the entire system browser's SSO session or cancel submitted remote jobs.
- IPC exposes only curated account state, non-secret configuration and the current authorization URL (never the PKCE verifier). Pasted codes are submitted once, cleared from the input and never persisted or logged. Tokens do not enter renderer storage, project files, Domain Packs, model context or diagnostic events.

## Cloud consumers

Obol main commit `5a05c75` implements resource-scoped model access. This client targets that existing implementation: the native client remains `harness-desktop-1`, but the model access token must have audience `obol-api`. No extra model permission manifest or gateway feature flag is required. The first model call may open the user's personal billing account. Obol records a login-session billing row without a usable API-key prefix/hash; it does not create a user API key.

The real Harness coordinator/proxy has passed against that local upstream Obol issuer, gateway and ledger with a synthetic inference backend, including no user API-key creation. Production inference still requires confirmation of deployed server version and a real-user acceptance run. An existing legacy grant migrates through a resource refresh under its original refresh family. `invalid_target` restores the unconsumed refresh state and does not sign the account out.

The v1.1 remote-server companion validates Obol JWTs for `industrial-mcp-remote`, with `mcp:access`, `project:write`, `task:create` and `task:cancel`. It has local HTTP/MCP coverage; real remote connectivity is deferred.

Each service uses its own grant and refresh lock. A partial or mismatched login cannot supply either service token. The remote client obtains a token per request through an injected credential provider. Only GET + `401 WWW-Authenticate: Bearer error="invalid_token"` retries once after refresh. It never retries mutation requests or a `403`; existing request journals remain authoritative. Account subject participates in remote binding identity, and existing clients reject account changes.

Desktop's **Use platform account for model API** and CLI `run --platform-account` use a bounded loopback model proxy. It accepts a random local session key, fixed routes and an exact upstream; platform tokens are verified for issuer, application audience, signature, expiry and `typ=at+jwt` before forwarding. Streaming responses are forwarded without whole-response buffering. The local key is all Kimi receives. BYOK remains a separate model source. Logout closes the local proxy; the selected platform source does not silently fall back to a saved API key. Model name/protocol/context parameters remain in Model API settings.

## CLI

```sh
export INDUSTRIAL_AUTH_CLIENT_ID='<registered-native-client-id>'
export INDUSTRIAL_AUTH_AUDIENCE='<registered-application-slug>'
node apps/cli/src/main.cjs account login --allow-file-store
node apps/cli/src/main.cjs account status --allow-file-store
node apps/cli/src/main.cjs run --platform-account --project-dir /path/to/project --domain DOMAIN --task '...'
node apps/cli/src/main.cjs remote status --platform-account
node apps/cli/src/main.cjs account logout --allow-file-store
```

`--no-browser`, SSH and headless Linux use code paste without opening a browser or listener. Open the printed URL on any device and paste the complete `code#state` on stdin; terminal input is not echoed or retained in command history. Normal CLI login accepts either loopback or paste; the first valid response wins. An unavailable local listener falls back to paste. Desktop offers the same fallback with a selectable link and a masked code input. Invalid paste/state can be retried; cancellation, timeout and logout invalidate the pending attempt. Browser launch failure does not stop paste or cancellation. Device authorization is not implemented. No token-print command is exposed.

## Verification

```sh
pnpm --filter @industrial-agent-harness/harness-auth test
pnpm --filter @industrial-agent-harness/desktop build
pnpm --filter @industrial-agent-harness/desktop test:account
pnpm test:architecture-contract
pnpm test:architecture
```

The account selftest uses a controlled signed OIDC provider and the actual preload/main/renderer path, without SMS or production credentials. When socket listening is prohibited, `AUTH_TEST_TRANSPORT=memory node --test packages/harness-auth/tests/*.test.cjs` exercises the same HTTP handlers and real protocol/JWT libraries using in-memory transport. This is protocol validation, not OS loopback, browser or packaged-keychain acceptance.

Public references: [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252), [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700), [openid-client](https://github.com/panva/openid-client), [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).
