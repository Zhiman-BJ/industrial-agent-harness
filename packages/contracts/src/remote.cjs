const { z } = require('zod');
const { ActionPresentationSchema } = require('./results.cjs');

// Frozen P0 contract for issue #199: remote sandbox as an optional Domain Pack
// execution backend. These schemas and transition rules are a versioned design
// contract; they are not proof that any remote service endpoint is deployed.
// The remote sync contract is versioned independently of the legacy 0.2 job
// protocol and of INDUSTRIAL_SCHEMA_VERSION.

const REMOTE_SCHEMA_VERSION = '1';
// Protocol implemented by the session/MCP client (PR #134 lineage). A service
// advertises its own protocol version, canonical contract version and feature
// flags separately; none of them substitutes for another.
const REMOTE_PROTOCOL_VERSION = '1.1';

const REMOTE_PROTOCOL_FEATURES = [
  // Chunked, resumable snapshot upload sessions with missing-blob negotiation.
  'upload-sessions',
  // SourceChangeSet publish, fetch, staged local apply and acknowledgement.
  'source-changesets',
  // Read-only recovery lookup of a persisted invocation by its identity.
  'invocation-recovery',
  // Presentation groups with companion-aware, integrity-checked downloads.
  'artifact-bundles',
  // Generation-fenced write lease on the remote workspace.
  'workspace-lease',
  // Idempotent local-apply acknowledgement with fixed retention references.
  'sync-ack',
];

const version = z.literal(REMOTE_SCHEMA_VERSION);
const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const datetime = z.string().datetime();
// Same project-relative POSIX rule as the canonical industrial contracts.
const relativePath = z
  .string()
  .min(1)
  .max(512)
  .refine(
    value =>
      !value.includes('\\') &&
      !value.includes('\0') &&
      !value.startsWith('/') &&
      !/^[A-Za-z]:/.test(value) &&
      !value.split('/').some(part => !part || part === '.' || part === '..'),
    'Expected a project-relative POSIX path',
  );
const blobRef = z.object({ sha256, sizeBytes: z.number().int().nonnegative() }).strict();
const snapshotId = z.string().min(1).max(128);
const featureFlag = z.enum(REMOTE_PROTOCOL_FEATURES);
const unique = values => new Set(values).size === values.length;

// --- Service discovery and qualification (issue section 3 and 8) ---

const RemoteFeatureFlagsSchema = z
  .array(featureFlag)
  .max(REMOTE_PROTOCOL_FEATURES.length)
  .refine(value => unique(value), 'Feature flags must be unique');

const RemoteTransferCapabilitySchema = z
  .object({
    schemaVersion: version,
    maxFiles: z.number().int().min(1).max(65536),
    maxFileBytes: z.number().int().positive(),
    maxTotalBytes: z.number().int().positive(),
    chunkedUploads: z.boolean(),
    resumable: z.boolean(),
    uploadTtlSeconds: z.number().int().positive(),
    downloadResume: z.boolean(),
    // Retention of unacknowledged candidates and uploaded-but-uncommitted blobs.
    retentionSeconds: z.number().int().positive(),
  })
  .strict();

const RemoteRecoveryCapabilitySchema = z
  .object({
    schemaVersion: version,
    // A service without persisted invocation lookup and outcome-unknown
    // reporting cannot qualify for recoverable write tools.
    invocationLookup: z.literal(true),
    outcomeUnknown: z.literal(true),
    retentionSeconds: z.number().int().positive(),
    retentionRefs: z.array(z.string().min(1).max(256)).max(64),
  })
  .strict();

const RemoteToolQualificationSchema = z
  .object({
    id: z.string().min(1).max(320),
    available: z.boolean(),
    // Required whenever the tool is not available; names the actual cause.
    reason: z.string().min(1).max(512).nullable(),
  })
  .strict()
  .refine(tool => tool.available || tool.reason !== null, 'Unavailable tools need a reason');

const RemoteProfileQualificationSchema = z
  .object({
    schemaVersion: version,
    profileId: z.string().min(1).max(128),
    // The actual installed runtime; a same-named tool on a different runtime
    // digest is a different qualification and must be pinned separately.
    runtime: z.object({ family: z.string().min(1).max(64), digest: sha256 }).strict(),
    nativeVersions: z.record(z.string().min(1).max(128), z.string().min(1).max(128)),
    tools: z
      .array(RemoteToolQualificationSchema)
      .min(1)
      .max(512)
      .refine(tools => unique(tools.map(tool => tool.id)), 'Qualified tool ids must be unique'),
    qualifiedAt: datetime,
  })
  .strict();

const RemoteServiceInfoSchema = z
  .object({
    schemaVersion: version,
    serverId: uuid,
    protocolVersion: z.string().min(1).max(32),
    // Canonical industrial contract version the service implements.
    contractsVersion: z.string().min(1).max(32),
    features: RemoteFeatureFlagsSchema,
    service: z
      .object({
        name: z.string().min(1).max(128),
        // Deployed service commit; qualification evidence binds to it.
        commit: z.string().regex(/^[0-9a-f]{7,64}$/),
      })
      .strict(),
    qualifiedProfiles: z.array(RemoteProfileQualificationSchema).max(64),
    transfer: RemoteTransferCapabilitySchema,
    recovery: RemoteRecoveryCapabilitySchema,
  })
  .strict();

// Features required before the corresponding client capability may be used.
// Missing entries must be shown to the user; there is no silent fallback.
function missingRemoteFeatures(info, required) {
  const advertised = new Set(RemoteServiceInfoSchema.parse(info).features);
  return required.filter(flag => !advertised.has(flag));
}

// --- Pack declarations (issue section 3; owned by the Pack, versioned here) ---

// ToolDescriptorSchema is canonical and lives in index.cjs; the lazy reference
// avoids a module-load cycle while keeping a single tool identity shape.
const canonicalTool = z.lazy(() => require('./index.cjs').ToolDescriptorSchema);
const canonicalArtifact = z.lazy(() => require('./index.cjs').ArtifactRefSchema);

const PackExecutionProfileSchema = z
  .object({
    schemaVersion: version,
    packId: z.string().min(1).max(128),
    packVersion: z.string().min(1).max(64),
    packDigest: sha256,
    coreApi: z
      .object({
        min: z.number().int().nonnegative(),
        max: z.number().int().nonnegative(),
      })
      .strict()
      .refine(range => range.min <= range.max, 'coreApi range is inverted'),
    tools: z
      .array(canonicalTool)
      .min(1)
      .max(512)
      .refine(tools => unique(tools.map(tool => tool.id)), 'Profile tool ids must be unique'),
    // Remote profile ids this Pack release supports; service-side profiles are
    // only usable through this intersection, never by directory listing.
    remoteProfiles: z
      .array(z.string().min(1).max(128))
      .min(1)
      .max(64)
      .refine(value => unique(value), 'Remote profile ids must be unique'),
  })
  .strict();

const WorkspacePolicySchema = z
  .object({
    schemaVersion: version,
    // How the input closure is computed; generic suffix scanning is not a mode.
    dependencyResolution: z.enum(['pack-resolver', 'declared-manifest']),
    // Schema-declared parameters the host may rewrite as project-relative
    // paths. No other string is rewritten.
    pathParameters: z.array(z.string().min(1).max(128)).max(128),
    allow: z.array(z.string().min(1).max(512)).max(256),
    // Explicit exclusions (e.g. .git, credential files); dotfiles are not
    // excluded wholesale because domains may keep required dotfile content.
    exclude: z.array(z.string().min(1).max(512)).max(256),
    hooks: z
      .object({
        save: z.boolean(),
        reload: z.boolean(),
        checkpoint: z.boolean(),
      })
      .strict(),
  })
  .strict();

const ToolMutationPolicySchema = z
  .object({
    schemaVersion: version,
    toolId: z.string().min(1).max(320),
    // Declared by the Pack; never inferred from a tool id or path suffix.
    effect: z.enum(['read-only', 'mutates-source', 'artifacts-only']),
    persistence: z.enum(['per-call', 'transaction-group']),
    transactionGroup: z.string().min(1).max(128).optional(),
  })
  .strict()
  .refine(
    policy => policy.persistence !== 'transaction-group' || Boolean(policy.transactionGroup),
    'A transaction group persistence policy names its group',
  );

const ToolResultPolicySchema = z
  .object({
    schemaVersion: version,
    toolId: z.string().min(1).max(320),
    // Identity of the Pack artifact collector that registers workspace results.
    collector: z.string().min(1).max(128),
    // Presentation group keys this tool may emit (see results.cjs).
    presentations: z.array(z.string().min(1).max(128)).max(32),
    // When true, a group is displayable only after every declared companion
    // validates; a partial download never masquerades as a complete result.
    requiresCompleteGroup: z.boolean(),
  })
  .strict();

// The Pack declares what it supports; the service reports what is actually
// installed and qualified. Only the intersection is usable. Tools the service
// lists but the Pack does not declare are never exposed.
function negotiateRemoteProfile(packProfile, qualification) {
  const pack = PackExecutionProfileSchema.parse(packProfile);
  const qualified = RemoteProfileQualificationSchema.parse(qualification);
  if (!pack.remoteProfiles.includes(qualified.profileId))
    throw Error(
      `Remote profile "${qualified.profileId}" is not supported by ${pack.packId}@${pack.packVersion}.`,
    );
  const reported = new Map(qualified.tools.map(tool => [tool.id, tool]));
  const tools = [];
  const unavailable = [];
  for (const tool of pack.tools) {
    const entry = reported.get(tool.id);
    if (!entry) unavailable.push({ id: tool.id, reason: 'Not reported by the service.' });
    else if (!entry.available) unavailable.push({ id: tool.id, reason: entry.reason });
    else tools.push(tool.id);
  }
  return {
    profileId: qualified.profileId,
    runtimeDigest: qualified.runtime.digest,
    qualifiedAt: qualified.qualifiedAt,
    tools,
    unavailable,
  };
}

// --- Input snapshots, upload sessions and change sets (issue section 4) ---

const RemoteSnapshotManifestSchema = z
  .object({
    schemaVersion: version,
    files: z
      .array(
        z
          .object({ path: relativePath, sha256, sizeBytes: z.number().int().nonnegative() })
          .strict(),
      )
      .min(1)
      .max(65536),
  })
  .strict()
  .refine(
    manifest =>
      manifest.files.every(
        (file, index) => index === 0 || manifest.files[index - 1].path < file.path,
      ),
    'Manifest files must be sorted by unique path',
  );

const RemoteUploadSessionSchema = z
  .object({
    schemaVersion: version,
    uploadId: uuid,
    remoteProjectId: uuid,
    baseSnapshotId: snapshotId.nullable(),
    manifestDigest: sha256,
    // Content the service still needs; uploads send only missing blobs.
    missing: z
      .array(
        z
          .object({ path: relativePath, sha256, sizeBytes: z.number().int().nonnegative() })
          .strict(),
      )
      .max(65536),
    expiresAt: datetime,
  })
  .strict()
  .refine(
    session =>
      session.missing.every(
        (file, index) => index === 0 || session.missing[index - 1].sha256 <= file.sha256,
      ) && unique(session.missing.map(file => file.sha256)),
    'Missing blobs must be unique by content digest',
  );

const SourceChangeEntrySchema = z
  .object({
    op: z.enum(['add', 'modify', 'delete', 'rename']),
    // Target path; for rename this is the new path.
    path: relativePath,
    // Rename source; absent for every other operation.
    from: relativePath.optional(),
    before: blobRef.nullable(),
    after: blobRef.nullable(),
  })
  .strict()
  .refine(
    entry => (entry.op === 'rename') === Boolean(entry.from),
    'Only rename carries a source path',
  )
  .refine(
    entry => entry.op !== 'rename' || entry.from !== entry.path,
    'Rename must change the path',
  )
  .refine(
    entry => (entry.op === 'add' ? entry.before === null && entry.after !== null : true),
    'Add requires a null before and a real after',
  )
  .refine(
    entry => (entry.op === 'delete' ? entry.before !== null && entry.after === null : true),
    'Delete requires a real before and a null after',
  )
  .refine(
    entry =>
      entry.op !== 'modify' ||
      (entry.before !== null && entry.after !== null && entry.before.sha256 !== entry.after.sha256),
    'Modify requires differing before/after content',
  )
  .refine(
    entry =>
      entry.op !== 'rename' ||
      (entry.before !== null && entry.after !== null && entry.before.sha256 === entry.after.sha256),
    'A rename keeps content; a rename with content change is a delete plus an add',
  );

const SourceChangeSetSchema = z
  .object({
    schemaVersion: version,
    id: uuid,
    // Canonical project identity; never a local path.
    projectId: sha256,
    invocationId: uuid,
    actionId: uuid,
    baseSnapshotId: snapshotId,
    outputSnapshotId: snapshotId,
    changes: z.array(SourceChangeEntrySchema).min(1).max(65536),
    // Dependency groups applied as one staged unit (issue section 5.3).
    groups: z.array(z.array(relativePath).min(1).max(1024)).max(1024).default([]),
  })
  .strict()
  .refine(
    set => set.baseSnapshotId !== set.outputSnapshotId,
    'A change set moves between snapshots',
  )
  .refine(
    set => unique(set.changes.map(entry => entry.path)),
    'Each target path may occur once per change set',
  )
  .refine(
    set =>
      set.groups.every(group =>
        group.every(path => set.changes.some(entry => entry.path === path)),
      ),
    'Dependency groups reference only changed paths',
  )
  .refine(
    set => set.groups.flat().length === new Set(set.groups.flat()).size,
    'A path belongs to at most one dependency group',
  );

// --- Artifact bundles (issue section 4.1 and 7) ---

const RemoteArtifactBundleSchema = z
  .object({
    schemaVersion: version,
    id: uuid,
    projectId: sha256,
    actionId: uuid,
    artifacts: z.array(canonicalArtifact).min(1).max(1024),
    presentation: ActionPresentationSchema.nullable(),
  })
  .strict()
  .refine(
    bundle => unique(bundle.artifacts.map(artifact => artifact.id)),
    'Bundle artifact ids must be unique',
  )
  .refine(
    bundle =>
      bundle.artifacts.every(
        artifact =>
          artifact.actionId === bundle.actionId && artifact.projectId === bundle.projectId,
      ),
    'Bundle artifacts belong to the bundle action and project',
  )
  .refine(
    bundle => !bundle.presentation || bundle.presentation.actionId === bundle.actionId,
    'Presentation binds to the bundle action',
  );

// --- Invocation identity and recovery (issue section 5) ---

const RemoteInvocationRecordSchema = z
  .object({
    schemaVersion: version,
    invocationId: uuid,
    projectId: sha256,
    toolId: z.string().min(1).max(320),
    toolVersion: z.string().min(1).max(64),
    inputSnapshotId: snapshotId,
    expectedStateId: uuid,
    // Capability/profile identity and the digest of the full intent summary,
    // both persisted before dispatch.
    capabilityHash: sha256,
    intentHash: sha256,
    grantId: uuid,
    status: z.enum(['submitted', 'running', 'committed', 'failed', 'unknown']),
    submittedAt: datetime,
  })
  .strict();

// --- Sync coordinator states (issue section 5.2) ---

// This state machine describes synchronization only. It never rewrites the
// canonical Run/Action/Verification outcome.
const SYNC_STATES = [
  'PREPARED',
  'DISPATCHED',
  'REMOTE_COMMITTED',
  'LOCAL_APPLYING',
  'READY',
  // Bypass states.
  'NOT_SUBMITTED',
  'OUTCOME_UNKNOWN',
  'CONFLICT',
  'RECOVERY_REQUIRED',
];

const SYNC_EVENTS = [
  'dispatch',
  'rejected',
  'remote-committed',
  'outcome-lost',
  'outcome-committed',
  'outcome-not-submitted',
  'apply-started',
  'apply-completed',
  'apply-conflict',
  'apply-crashed',
  'resume-apply',
  'retry',
  // Read-only and artifacts-only calls commit without source changes.
  'no-source-change',
];

const SYNC_TRANSITIONS = {
  'PREPARED:dispatch': 'DISPATCHED',
  'PREPARED:rejected': 'NOT_SUBMITTED',
  'DISPATCHED:remote-committed': 'REMOTE_COMMITTED',
  'DISPATCHED:rejected': 'NOT_SUBMITTED',
  'DISPATCHED:outcome-lost': 'OUTCOME_UNKNOWN',
  // Recovery is a read-only query by the original invocation identity; an
  // unknown outcome is never replayed into a new invocation.
  'OUTCOME_UNKNOWN:outcome-committed': 'REMOTE_COMMITTED',
  'OUTCOME_UNKNOWN:outcome-not-submitted': 'NOT_SUBMITTED',
  'REMOTE_COMMITTED:apply-started': 'LOCAL_APPLYING',
  'REMOTE_COMMITTED:no-source-change': 'READY',
  'LOCAL_APPLYING:apply-completed': 'READY',
  'LOCAL_APPLYING:apply-conflict': 'CONFLICT',
  'LOCAL_APPLYING:apply-crashed': 'RECOVERY_REQUIRED',
  'RECOVERY_REQUIRED:resume-apply': 'LOCAL_APPLYING',
  'RECOVERY_REQUIRED:apply-conflict': 'CONFLICT',
  // Only an explicit not-submitted rejection may retry, after re-checking
  // inputs, scope and grant freshness.
  'NOT_SUBMITTED:retry': 'PREPARED',
};

const RemoteSyncStateSchema = z
  .object({
    schemaVersion: version,
    invocationId: uuid,
    projectId: sha256,
    status: z.enum(SYNC_STATES),
    baseSnapshotId: snapshotId,
    outputSnapshotId: snapshotId.nullable(),
    appliedSnapshotId: snapshotId.nullable(),
    changeSetId: uuid.nullable(),
    updatedAt: datetime,
  })
  .strict()
  .refine(
    state => state.changeSetId === null || state.outputSnapshotId !== null,
    'A change set always belongs to an output snapshot',
  )
  .refine(
    state =>
      state.status !== 'READY' || state.changeSetId === null || state.appliedSnapshotId !== null,
    'A ready source-changing sync recorded its applied snapshot',
  );

function reduceSyncState(status, event) {
  if (!SYNC_STATES.includes(status)) throw Error(`Unknown sync state "${status}".`);
  if (!SYNC_EVENTS.includes(event)) throw Error(`Unknown sync event "${event}".`);
  const next = SYNC_TRANSITIONS[`${status}:${event}`];
  if (!next) throw Error(`Sync transition "${event}" is not allowed from "${status}".`);
  return next;
}

// --- Session binding (issue section 6) ---

// Persisted binding identity. Tokens and grants never appear in the binding,
// in a manifest, or in a journal; strict schemas reject such fields outright.
const RemoteSessionBindingSchema = z
  .object({
    schemaVersion: version,
    serviceOrigin: z
      .string()
      .min(1)
      .max(256)
      .refine(value => {
        try {
          const url = new URL(value);
          return (
            (url.protocol === 'https:' ||
              (url.protocol === 'http:' &&
                ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            url.pathname === '/'
          );
        } catch {
          return false;
        }
      }, 'Expected a clean HTTPS origin (loopback HTTP allowed for development)'),
    serverId: uuid,
    principalSubject: z.string().min(1).max(256),
    localProjectId: sha256,
    remoteProjectId: uuid,
    domain: z.string().min(1).max(128),
    chatId: uuid,
    // Reconnect key chosen by the client; distinct from the server-issued
    // application session and from the MCP transport.
    clientSessionId: uuid,
    applicationSessionId: uuid,
    profileId: z.string().min(1).max(128),
    appliedSnapshotId: snapshotId.nullable(),
  })
  .strict()
  .refine(
    binding => binding.clientSessionId !== binding.applicationSessionId,
    'Client reconnect identity and server application session differ',
  );

module.exports = {
  REMOTE_SCHEMA_VERSION,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_PROTOCOL_FEATURES,
  SYNC_STATES,
  SYNC_EVENTS,
  SYNC_TRANSITIONS,
  RemoteFeatureFlagsSchema,
  RemoteTransferCapabilitySchema,
  RemoteRecoveryCapabilitySchema,
  RemoteToolQualificationSchema,
  RemoteProfileQualificationSchema,
  RemoteServiceInfoSchema,
  PackExecutionProfileSchema,
  WorkspacePolicySchema,
  ToolMutationPolicySchema,
  ToolResultPolicySchema,
  RemoteSnapshotManifestSchema,
  RemoteUploadSessionSchema,
  SourceChangeEntrySchema,
  SourceChangeSetSchema,
  RemoteArtifactBundleSchema,
  RemoteInvocationRecordSchema,
  RemoteSyncStateSchema,
  RemoteSessionBindingSchema,
  missingRemoteFeatures,
  negotiateRemoteProfile,
  reduceSyncState,
};
