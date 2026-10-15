import { z } from 'zod';
export const INDUSTRIAL_SCHEMA_VERSION: '1';
export type InputHashes = Record<string, string>;
export type VerificationStatus = 'not_run' | 'passed' | 'failed' | 'insufficient_evidence';
export interface ProjectRef {
  schemaVersion: '1';
  projectId: string;
  domain: string;
}
export interface ArtifactRef {
  schemaVersion: '1';
  id: string;
  projectId: string;
  runId: string;
  actionId: string;
  kind: string;
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  source: 'domain-tool';
  inputHashes: InputHashes;
}
export interface DomainState extends ProjectRef {
  id: string;
  stage: string | null;
  status: 'unverified' | 'verified' | 'failed' | 'stale';
  artifacts: ArtifactRef[];
  inputHashes: InputHashes;
  verificationIds: string[];
  createdAt: string;
}
export interface RunRecord extends ProjectRef {
  id: string;
  stateId: string;
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'completed' | 'failed';
  actionIds: string[];
}
export interface IndustrialVerificationResult {
  schemaVersion: '1';
  id: string;
  status: VerificationStatus;
  verifierId: string | null;
  reason: string;
  metrics: Record<string, number | boolean | string>;
  evidence: { artifactIds: string[]; inputHashes: InputHashes };
}
export interface VerificationResult {
  status: VerificationStatus;
  verifierId: string | null;
  reason: string;
  schemaVersion?: '1';
  id?: string;
  metrics?: IndustrialVerificationResult['metrics'];
  evidence?: IndustrialVerificationResult['evidence'];
}
export interface ActionRecord {
  id: string;
  runId: string;
  projectId: string;
  domain: string;
  toolId: string;
  inputs: Record<string, unknown>;
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'completed' | 'failed';
  diagnostics: string[];
  artifactIds: string[];
  verification: VerificationResult;
  schemaVersion?: '1';
  toolVersion?: string;
  stateId?: string;
  inputHashes?: InputHashes;
}
export interface IndustrialActionRecord extends ActionRecord {
  schemaVersion: '1';
  toolVersion: string;
  stateId: string;
  inputHashes: InputHashes;
  verification: IndustrialVerificationResult;
}
export interface IndustrialCheckpoint {
  schemaVersion: '1';
  id: string;
  parentId: string | null;
  stateHash: string;
  createdAt: string;
  state: DomainState;
  runId: string | null;
  actionIds: string[];
  artifactIds: string[];
}
export interface ToolDescriptor {
  schemaVersion: '1';
  id: string;
  version: string;
  risk: 'read-only' | 'mutating';
  verification: string[];
  effect?: 'inputs' | 'execution' | 'external';
}
export interface ActionRequest extends ProjectRef {
  toolId: string;
  inputs: Record<string, unknown>;
  expectedStateId: string;
}
export interface ObservedArtifact {
  id: string;
  kind: string;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  source: 'project-file';
  verificationStatus: 'not_run';
}
export interface ObservedState {
  projectId: string;
  domain: string;
  artifacts: ObservedArtifact[];
  staleArtifactIds: string[];
}
export interface ContextCheckpoint {
  id: string;
  parentId: string | null;
  stateHash: string;
  createdAt: string;
  state: ObservedState;
}
export const ProjectRefSchema: z.ZodType<ProjectRef>;
export const ArtifactRefSchema: z.ZodType<ArtifactRef>;
export const DomainStateSchema: z.ZodType<DomainState>;
export const RunRecordSchema: z.ZodType<RunRecord>;
export const IndustrialActionRecordSchema: z.ZodType<IndustrialActionRecord>;
export const IndustrialVerificationResultSchema: z.ZodType<IndustrialVerificationResult>;
export const IndustrialCheckpointSchema: z.ZodType<IndustrialCheckpoint>;
export const ToolDescriptorSchema: z.ZodType<ToolDescriptor>;
export const ActionRequestSchema: z.ZodType<ActionRequest>;
export const ObservedArtifactSchema: z.ZodType<ObservedArtifact>;
export const ObservedStateSchema: z.ZodType<ObservedState>;
export const ContextCheckpointSchema: z.ZodType<ContextCheckpoint>;
export const VerificationResultSchema: z.ZodType<VerificationResult>;
export const ActionRecordSchema: z.ZodType<ActionRecord>;
export interface ProjectTask {
  command: string[];
  inputs: string[];
  outputs: { path: string; kind: string }[];
  timeoutMs: number;
  verification?: { kind: 'checks-json'; path: string };
  runtime:
    | { kind: 'local'; readOnlyDirs?: string[] }
    | { kind: 'docker'; image: string; cpus: number; memoryMb: number; pids: number };
}
export const ProjectPathSchema: z.ZodType<string>;
export const ProjectInitializeRequestSchema: z.ZodType<{ name: string }>;
export const ProjectFileReadRequestSchema: z.ZodType<{ path?: string }>;
export const ProjectFileApplyRequestSchema: z.ZodType<{
  changes: { path: string; content: string | null; expectedSha256: string | null }[];
}>;
export const ProjectTaskManifestSchema: z.ZodType<{
  schemaVersion: '1';
  workspace?: { inputs?: string[]; ignore?: string[] };
  tasks: Record<string, ProjectTask>;
}>;
export const ProjectTaskRunRequestSchema: z.ZodType<{ task: string }>;
export const ProjectTaskCheckReportSchema: z.ZodType<{
  schemaVersion: '1';
  checks: { name: string; passed: boolean; details?: string }[];
}>;

export interface ResultGroup {
  schemaVersion: '1';
  id: string;
  projectId: string;
  chatId: string;
  turnId: string;
  actionId: string;
  title: string;
  primaryArtifactId: string;
  previewArtifactId?: string;
  attachmentArtifactIds: string[];
  companionArtifactIds: string[];
  supersedes: string[];
  verificationRefs: Array<{ actionId: string; verificationId: string }>;
}
export interface PresentationInput {
  relativePath: string;
  sha256: string;
}
export interface ToolPresentation {
  schemaVersion: '1';
  inputs: Array<{ output: string; relativePath: string }>;
  groups: Array<{
    key: string;
    title: string;
    primary: string;
    preview?: string;
    attachments: string[];
    companions: string[];
    supersedesInput?: PresentationInput;
  }>;
  checks: Array<{ input: PresentationInput; outputs: string[] }>;
}
export interface ActionPresentation {
  schemaVersion: '1';
  actionId: string;
  groups: Array<{
    key: string;
    title: string;
    primaryArtifactId: string;
    previewArtifactId?: string;
    attachmentArtifactIds: string[];
    companionArtifactIds: string[];
    supersedesInput?: PresentationInput;
  }>;
  checks: Array<{ input: PresentationInput; artifactIds: string[] }>;
  diagnostics: string[];
}
export const ToolPresentationSchema: z.ZodType<ToolPresentation>;
export const ActionPresentationSchema: z.ZodType<ActionPresentation>;
export const ResultGroupSchema: z.ZodType<ResultGroup>;
export const ResultSelectionRequestSchema: z.ZodType<{
  groupIds: string[];
  revision: number;
  historical: boolean;
}>;

// --- Remote sandbox sync contract (issue #199, P0 freeze) ---
export const REMOTE_SCHEMA_VERSION: '1';
export const REMOTE_PROTOCOL_VERSION: '1.1';
export type RemoteProtocolFeature =
  | 'upload-sessions'
  | 'source-changesets'
  | 'invocation-recovery'
  | 'artifact-bundles'
  | 'workspace-lease'
  | 'sync-ack';
export const REMOTE_PROTOCOL_FEATURES: RemoteProtocolFeature[];
export interface RemoteBlobRef {
  sha256: string;
  sizeBytes: number;
}
export interface RemoteTransferCapability {
  schemaVersion: '1';
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  chunkedUploads: boolean;
  resumable: boolean;
  uploadTtlSeconds: number;
  downloadResume: boolean;
  retentionSeconds: number;
}
export interface RemoteRecoveryCapability {
  schemaVersion: '1';
  invocationLookup: true;
  outcomeUnknown: true;
  retentionSeconds: number;
  retentionRefs: string[];
}
export interface RemoteToolQualification {
  id: string;
  available: boolean;
  reason: string | null;
}
export interface RemoteProfileQualification {
  schemaVersion: '1';
  profileId: string;
  runtime: { family: string; digest: string };
  nativeVersions: Record<string, string>;
  tools: RemoteToolQualification[];
  qualifiedAt: string;
}
export interface RemoteServiceInfo {
  schemaVersion: '1';
  serverId: string;
  protocolVersion: string;
  contractsVersion: string;
  features: RemoteProtocolFeature[];
  service: { name: string; commit: string };
  qualifiedProfiles: RemoteProfileQualification[];
  transfer: RemoteTransferCapability;
  recovery: RemoteRecoveryCapability;
}
export interface PackExecutionProfile {
  schemaVersion: '1';
  packId: string;
  packVersion: string;
  packDigest: string;
  coreApi: { min: number; max: number };
  tools: ToolDescriptor[];
  remoteProfiles: string[];
}
export interface WorkspacePolicy {
  schemaVersion: '1';
  dependencyResolution: 'pack-resolver' | 'declared-manifest';
  pathParameters: string[];
  allow: string[];
  exclude: string[];
  hooks: { save: boolean; reload: boolean; checkpoint: boolean };
}
export interface ToolMutationPolicy {
  schemaVersion: '1';
  toolId: string;
  effect: 'read-only' | 'mutates-source' | 'artifacts-only';
  persistence: 'per-call' | 'transaction-group';
  transactionGroup?: string;
}
export interface ToolResultPolicy {
  schemaVersion: '1';
  toolId: string;
  collector: string;
  presentations: string[];
  requiresCompleteGroup: boolean;
}
export interface RemoteSnapshotManifest {
  schemaVersion: '1';
  files: Array<{ path: string; sha256: string; sizeBytes: number }>;
}
export interface RemoteUploadSession {
  schemaVersion: '1';
  uploadId: string;
  remoteProjectId: string;
  baseSnapshotId: string | null;
  manifestDigest: string;
  missing: Array<{ path: string; sha256: string; sizeBytes: number }>;
  expiresAt: string;
}
export interface SourceChangeEntry {
  op: 'add' | 'modify' | 'delete' | 'rename';
  path: string;
  from?: string;
  before: RemoteBlobRef | null;
  after: RemoteBlobRef | null;
}
export interface SourceChangeSet {
  schemaVersion: '1';
  id: string;
  projectId: string;
  invocationId: string;
  actionId: string;
  baseSnapshotId: string;
  outputSnapshotId: string;
  changes: SourceChangeEntry[];
  groups: string[][];
}
export interface RemoteArtifactBundle {
  schemaVersion: '1';
  id: string;
  projectId: string;
  actionId: string;
  artifacts: ArtifactRef[];
  presentation: ActionPresentation | null;
}
export interface RemoteInvocationRecord {
  schemaVersion: '1';
  invocationId: string;
  projectId: string;
  toolId: string;
  toolVersion: string;
  inputSnapshotId: string;
  expectedStateId: string;
  capabilityHash: string;
  intentHash: string;
  grantId: string;
  status: 'submitted' | 'running' | 'committed' | 'failed' | 'unknown';
  submittedAt: string;
}
export type RemoteSyncStatus =
  | 'PREPARED'
  | 'DISPATCHED'
  | 'REMOTE_COMMITTED'
  | 'LOCAL_APPLYING'
  | 'READY'
  | 'NOT_SUBMITTED'
  | 'OUTCOME_UNKNOWN'
  | 'CONFLICT'
  | 'RECOVERY_REQUIRED';
export type RemoteSyncEvent =
  | 'dispatch'
  | 'rejected'
  | 'remote-committed'
  | 'outcome-lost'
  | 'outcome-committed'
  | 'outcome-not-submitted'
  | 'apply-started'
  | 'apply-completed'
  | 'apply-conflict'
  | 'apply-crashed'
  | 'resume-apply'
  | 'retry'
  | 'no-source-change';
export const SYNC_STATES: RemoteSyncStatus[];
export const SYNC_EVENTS: RemoteSyncEvent[];
export const SYNC_TRANSITIONS: Record<string, RemoteSyncStatus>;
export interface RemoteSyncState {
  schemaVersion: '1';
  invocationId: string;
  projectId: string;
  status: RemoteSyncStatus;
  baseSnapshotId: string;
  outputSnapshotId: string | null;
  appliedSnapshotId: string | null;
  changeSetId: string | null;
  updatedAt: string;
}
export interface RemoteSessionBinding {
  schemaVersion: '1';
  serviceOrigin: string;
  serverId: string;
  principalSubject: string;
  localProjectId: string;
  remoteProjectId: string;
  domain: string;
  chatId: string;
  clientSessionId: string;
  applicationSessionId: string;
  profileId: string;
  appliedSnapshotId: string | null;
}
export const RemoteFeatureFlagsSchema: z.ZodType<RemoteProtocolFeature[]>;
export const RemoteTransferCapabilitySchema: z.ZodType<RemoteTransferCapability>;
export const RemoteRecoveryCapabilitySchema: z.ZodType<RemoteRecoveryCapability>;
export const RemoteToolQualificationSchema: z.ZodType<RemoteToolQualification>;
export const RemoteProfileQualificationSchema: z.ZodType<RemoteProfileQualification>;
export const RemoteServiceInfoSchema: z.ZodType<RemoteServiceInfo>;
export const PackExecutionProfileSchema: z.ZodType<PackExecutionProfile>;
export const WorkspacePolicySchema: z.ZodType<WorkspacePolicy>;
export const ToolMutationPolicySchema: z.ZodType<ToolMutationPolicy>;
export const ToolResultPolicySchema: z.ZodType<ToolResultPolicy>;
export const RemoteSnapshotManifestSchema: z.ZodType<RemoteSnapshotManifest>;
export const RemoteUploadSessionSchema: z.ZodType<RemoteUploadSession>;
export const SourceChangeEntrySchema: z.ZodType<SourceChangeEntry>;
export const SourceChangeSetSchema: z.ZodType<SourceChangeSet>;
export const RemoteArtifactBundleSchema: z.ZodType<RemoteArtifactBundle>;
export const RemoteInvocationRecordSchema: z.ZodType<RemoteInvocationRecord>;
export const RemoteSyncStateSchema: z.ZodType<RemoteSyncState>;
export const RemoteSessionBindingSchema: z.ZodType<RemoteSessionBinding>;
export function missingRemoteFeatures(
  info: RemoteServiceInfo,
  required: RemoteProtocolFeature[],
): RemoteProtocolFeature[];
export interface NegotiatedRemoteProfile {
  profileId: string;
  runtimeDigest: string;
  qualifiedAt: string;
  tools: string[];
  unavailable: Array<{ id: string; reason: string }>;
}
export function negotiateRemoteProfile(
  packProfile: PackExecutionProfile,
  qualification: RemoteProfileQualification,
): NegotiatedRemoteProfile;
export function reduceSyncState(status: RemoteSyncStatus, event: RemoteSyncEvent): RemoteSyncStatus;
