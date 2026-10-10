export const SDK_SCHEMA_VERSION: 1;
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
/** Transport event. Industrial facts remain governed by @industrial-agent-harness/contracts. */
export interface CliEvent {
  schemaVersion: 1;
  type: string;
  runId?: string;
  chatId?: string;
  [key: string]: unknown;
}
/** CLI display summary only. Canonical engineering facts use contracts. */
export interface EngineeringSummary {
  stateId: string;
  status: string;
  checkpointId?: string;
}
export interface TerminalCliEvent extends CliEvent {
  type: 'result' | 'chats';
  status?: string;
  engineering?: EngineeringSummary;
  chats?: unknown[];
}
export interface RunResult {
  sdkSchemaVersion: 1;
  runId: string | null;
  chatId: string | null;
  /** References from the last real industrial result; does not restore project files. */
  references: {
    industrialRunId: string | null;
    actionId: string | null;
    checkpointId: string | null;
  };
  exitCode: number | null;
  signal: string | null;
  stderr: string;
  result: TerminalCliEvent;
  elapsedMs: number;
}
export class HarnessError extends Error {
  constructor(code: string, message: string, details?: Record<string, unknown>);
  code: string;
  details: Record<string, unknown>;
}
export interface RunOptions {
  /** Select a configured Agent for a new or empty chat. */
  agentId?: string;
  task: string;
  scopeOnly?: boolean;
  chatId?: string;
  chatDir?: string;
  stateDir?: string;
  logDir?: string;
  provider?: string;
  endpoint?: string;
  model?: string;
  contextSize?: number;
  apiKeyEnv?: string;
  kimiExecutable?: string;
  artifactManifest?: string;
  approval?: 'reject' | 'approve' | 'approve_for_session' | 'auto';
  thinking?: boolean;
  imageInput?: boolean;
  enableGui?: boolean;
  disabledSkills?: string[];
  disabledMcpServers?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface RunHandle {
  /** Local SDK request identity; differs from the durable CLI Run identity. */
  id: string;
  events: AsyncIterable<CliEvent>;
  result: Promise<RunResult>;
  /** Resolves after child process closure and forced descendant cleanup. */
  cancel(): Promise<unknown>;
}
export interface ClientConfig {
  cliPath: string;
  projectDir: string;
  domain: string;
  nodeExecutable?: string;
  environment?: Record<string, string | undefined>;
  cancelGraceMs?: number;
  maxBufferedEvents?: number;
}
export interface HarnessClient {
  sdkSchemaVersion: 1;
  project: Readonly<{ projectDir: string; domain: string }>;
  run(options: RunOptions): RunHandle;
  chats(options?: {
    chatDir?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<unknown[]>;
  close(): Promise<void>;
}
export function createClient(config: ClientConfig): HarnessClient;
