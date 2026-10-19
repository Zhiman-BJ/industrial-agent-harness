import {
  INDUSTRIAL_SCHEMA_VERSION,
  IndustrialActionRecordSchema,
  ArtifactRefSchema,
  DomainStateSchema,
  ToolDescriptorSchema,
  ObservedArtifactSchema,
  type IndustrialActionRecord,
  type ArtifactRef,
  type DomainState,
  type ToolDescriptor,
} from '../src/index.cjs';

const action: IndustrialActionRecord = IndustrialActionRecordSchema.parse({});
const artifact: ArtifactRef = ArtifactRefSchema.parse({});
const state: DomainState = DomainStateSchema.parse({});
const tool: ToolDescriptor = ToolDescriptorSchema.parse({});
const version: '1' = INDUSTRIAL_SCHEMA_VERSION;
const canonicalVersion: '1' = action.schemaVersion;
const toolVersion: string = action.toolVersion;
const inputHashes: Record<string, string> = artifact.inputHashes;
const metrics: Record<string, number | boolean | string> = action.verification.metrics;
const references: string[] = state.verificationIds;
const observed = ObservedArtifactSchema.parse({});
const observedStatus: 'not_run' = observed.verificationStatus;
// @ts-expect-error Future versions require an explicit new contract.
const futureVersion: '2' = tool.schemaVersion;
// @ts-expect-error File observation is not an executed industrial artifact.
const fact: ArtifactRef = observed;
void [
  version,
  canonicalVersion,
  toolVersion,
  inputHashes,
  metrics,
  references,
  observedStatus,
  futureVersion,
  fact,
];

import {
  REMOTE_SCHEMA_VERSION,
  REMOTE_PROTOCOL_FEATURES,
  SYNC_STATES,
  SourceChangeSetSchema,
  RemoteServiceInfoSchema,
  RemoteSyncStateSchema,
  negotiateRemoteProfile,
  reduceSyncState,
  missingRemoteFeatures,
  type SourceChangeSet,
  type RemoteServiceInfo,
  type RemoteSyncState,
  type RemoteSyncStatus,
  type PackExecutionProfile,
  type RemoteProfileQualification,
} from '../src/index.cjs';

const remoteVersion: '1' = REMOTE_SCHEMA_VERSION;
const changeSet: SourceChangeSet = SourceChangeSetSchema.parse({});
const info: RemoteServiceInfo = RemoteServiceInfoSchema.parse({});
const syncState: RemoteSyncState = RemoteSyncStateSchema.parse({});
const featureList = REMOTE_PROTOCOL_FEATURES;
const missing = missingRemoteFeatures(info, ['source-changesets']);
const negotiated = negotiateRemoteProfile(
  {} as PackExecutionProfile,
  {} as RemoteProfileQualification,
);
const nextStatus: RemoteSyncStatus = reduceSyncState(syncState.status, 'dispatch');
const states: RemoteSyncStatus[] = SYNC_STATES;
const qualifiedTools: string[] = negotiated.tools;
// @ts-expect-error The remote contract has no implicit future version.
const futureRemoteVersion: '2' = remoteVersion;
void [
  remoteVersion,
  changeSet,
  info,
  featureList,
  missing,
  nextStatus,
  states,
  qualifiedTools,
  futureRemoteVersion,
];
