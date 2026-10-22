// Public native-client registration verified in doc/platform-account.md.
// Service tokens are requested only when the user chooses a platform service.
const DEFAULT_ACCOUNT_CONFIG = Object.freeze({
  issuer: 'https://auth.zhiman.cn',
  clientId: 'harness-desktop-1',
  audience: 'harness-desktop',
  remoteOrigin: '',
  remoteAudience: 'industrial-mcp-remote',
  modelBaseUrl: 'https://api.zhiman.cn/v1',
});

module.exports = { DEFAULT_ACCOUNT_CONFIG };
