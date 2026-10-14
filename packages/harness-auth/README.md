# Platform account

Optional native OAuth 2.0 / OpenID Connect sign-in for Desktop and CLI. Local tasks and user-supplied model API keys do not require an account.

The shared module uses pinned `openid-client` 6.8.8 for discovery, Authorization Code + PKCE S256, state/nonce checks, ID-token signature verification, UserInfo, refresh and revocation. The browser callback listens only on `127.0.0.1:0` at `/callback`. Obol’s documented `/oauth/code` page provides a `code#state` paste fallback; it uses the same OIDC library, PKCE and nonce checks, with the redirect URI bound to the chosen path. HTTPS issuers are required; literal loopback HTTP is accepted for development. It never uses an embedded login page, client secret, password grant, implicit grant or unsigned token parsing.

## Configure

Register a **native/public** client in the platform with loopback callbacks enabled. A real client ID is required; this repository does not invent or ship a production registration. Desktop: Settings → Platform account → Platform connection. Environment overrides are supported:

| Variable | Meaning |
| --- | --- |
| `INDUSTRIAL_AUTH_ISSUER` | Issuer origin; defaults to `https://auth.zhiman.cn` |
| `INDUSTRIAL_AUTH_CLIENT_ID` | Registered native client ID; required |
| `INDUSTRIAL_AUTH_AUDIENCE` | Slug of the application the native client belongs to; distinct from client ID |
| `INDUSTRIAL_AUTH_MODEL_BASE_URL` | Obol model API including `/v1`, e.g. `https://api.zhiman.cn/v1` |
| `INDUSTRIAL_AUTH_REMOTE_ORIGIN` | Explicit remote service origin |
| `INDUSTRIAL_AUTH_REMOTE_AUDIENCE` | Application slug of the remote service; required with the remote origin |

One sign-in serves every connected service. For each service the client refreshes with that service's URL as RFC 8707 `resource` ([Obol ADR 0007](https://github.com/zhimanai/obol/blob/main/docs/adr/0007-gateway-accepts-account-tokens.md)) and gets a token whose audience is only that service: `obol-api` for the model API, the remote audience for the remote service. Tokens are verified for that audience before use and cached per service in the session. A service the user has no grant for answers `invalid_target`; the client reports *This account cannot use this service* and the sign-in stays valid for everything else. Services must still verify tokens and enforce project ownership, permissions and quotas themselves.

## Credentials and lifecycle

- Desktop keeps credential material in the main process and encrypts it with Electron `safeStorage`. Linux `basic_text` is rejected. If encryption is unavailable, credentials stay in memory for that app process. Locked/corrupt storage does not prevent local app startup.
- CLI uses a separate session. Its default store is memory only. `account login --allow-file-store` explicitly opts into a private 0600 file; this is not encrypted storage. Pass the flag to status/logout as well. Windows ACL qualification is pending.
- `SessionStore.transaction` serializes local and inter-process operations using `proper-lockfile`; refresh re-reads the latest saved token inside the lock and atomically saves its replacement. Access tokens refresh on demand 60 seconds before expiry. No background polling is required.
- A durable refresh-in-progress marker prevents replay after a crash or ambiguous network response. `invalid_grant`, uncertain refresh or a crash marker requires sign-in again. Transient discovery failure before refresh leaves the saved refresh token intact.
- Logout cancels pending login, attempts refresh-token revocation and removes local credentials even when revocation fails. The UI reports unsuccessful server revocation. It does not sign out the entire system browser's SSO session or cancel submitted remote jobs.
- IPC exposes only curated account state, non-secret configuration and the current authorization URL (never the PKCE verifier). Pasted codes are submitted once, cleared from the input and never persisted or logged. Tokens do not enter renderer storage, project files, Domain Packs, model context or diagnostic events.

## Cloud consumers

The Obol model gateway accepts account tokens for `obol-api` ([integration guide, section 8](https://github.com/zhimanai/obol/blob/main/docs/account-integration.md)): usage is billed to the signed-in user's own Obol account, opened with its signup credit on the first call. The remote service checkout still uses preconfigured Bearer credentials until it verifies account tokens.

The remote client obtains a token per request through an injected credential provider. Only GET + `401 WWW-Authenticate: Bearer error="invalid_token"` retries once after refresh. It never retries mutation requests or a `403`; existing request journals remain authoritative. Account subject participates in remote binding identity, and existing clients reject account changes.

Desktop's **Use platform account for model API** and CLI `run --platform-account` use a bounded loopback model proxy. It accepts a random local session key, fixed routes and an exact upstream; platform tokens for `obol-api` are verified for issuer, audience, signature, expiry and `typ=at+jwt` before forwarding. A `401` from the model API refreshes the token and retries the request once; `402` (balance), `403` (no access) and `429` reach the kernel as short explanations, never as upstream bodies. Streaming responses are forwarded without whole-response buffering. The local key is all Kimi receives. BYOK remains a separate model source. Logout closes the local proxy; the selected platform source does not silently fall back to a saved API key. Model name/protocol/context parameters remain in Model API settings.

## CLI

```sh
export INDUSTRIAL_AUTH_CLIENT_ID='<registered-native-client-id>'
export INDUSTRIAL_AUTH_AUDIENCE='<registered-application-slug>'
export INDUSTRIAL_AUTH_MODEL_BASE_URL='https://api.zhiman.cn/v1'
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
