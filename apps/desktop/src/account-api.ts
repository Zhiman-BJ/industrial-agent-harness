export type AccountConfig = {
  issuer: string;
  clientId: string;
  audience: string;
  remoteOrigin: string;
  modelBaseUrl: string;
};
export type AccountView = {
  status:
    | 'not_configured'
    | 'signed_out'
    | 'signing_in'
    | 'signed_in'
    | 'refreshing'
    | 'reauth_required';
  user: { sub: string; name: string } | null;
  issuer: string;
  persistent: boolean;
  error: string | null;
  login: { loopbackAvailable: boolean; browserFailed: boolean; manualUrl: string } | null;
  config: AccountConfig;
  usePlatformModel: boolean;
  revoked?: boolean;
};
declare global {
  interface Window {
    harnessAccount: {
      get(): Promise<AccountView>;
      login(): Promise<AccountView>;
      openManual(): Promise<AccountView>;
      submitCode(value: string): Promise<AccountView>;
      cancel(): Promise<AccountView>;
      logout(): Promise<AccountView>;
      useModel(enabled: boolean): Promise<AccountView>;
      onChanged(callback: (view: AccountView) => void): () => void;
    };
  }
}
