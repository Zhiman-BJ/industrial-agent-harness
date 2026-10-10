import { z } from 'zod';
export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  instructions: string;
  domain: string;
  tools?: string[];
  disallowedTools?: string[];
  skills?: string[];
  subagents?: string[];
}
export const AgentIdSchema: z.ZodType<string>;
export const AgentDefinitionSchema: z.ZodType<AgentDefinition>;
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
