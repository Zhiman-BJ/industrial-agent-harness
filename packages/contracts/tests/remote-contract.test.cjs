const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  REMOTE_SCHEMA_VERSION,
  REMOTE_PROTOCOL_FEATURES,
  SYNC_STATES,
  SYNC_EVENTS,
  SYNC_TRANSITIONS,
  RemoteServiceInfoSchema,
  RemoteFeatureFlagsSchema,
  RemoteProfileQualificationSchema,
  PackExecutionProfileSchema,
  WorkspacePolicySchema,
  ToolMutationPolicySchema,
  ToolResultPolicySchema,
  RemoteSnapshotManifestSchema,
  RemoteUploadSessionSchema,
  SourceChangeSetSchema,
  RemoteArtifactBundleSchema,
  RemoteInvocationRecordSchema,
  RemoteSyncStateSchema,
  RemoteSessionBindingSchema,
  missingRemoteFeatures,
  negotiateRemoteProfile,
  reduceSyncState,
} = require('../src/index.cjs');

const id = () => crypto.randomUUID();
const hash = 'a'.repeat(64);
const otherHash = 'b'.repeat(64);
const now = () => new Date().toISOString();

const serviceInfo = {
  schemaVersion: '1',
  serverId: id(),
  protocolVersion: '1.1',
  contractsVersion: '1',
  features: [...REMOTE_PROTOCOL_FEATURES],
  service: { name: 'industrial-harness-remote', commit: '1234abcd' },
  qualifiedProfiles: [
    {
      schemaVersion: '1',
      profileId: 'linux-freecad-1',
      runtime: { family: 'linux', digest: hash },
      nativeVersions: { freecad: '1.0.0' },
      tools: [{ id: 'cad.model.build', available: true, reason: null }],
      qualifiedAt: now(),
    },
  ],
  transfer: {
    schemaVersion: '1',
    maxFiles: 4096,
    maxFileBytes: 268435456,
    maxTotalBytes: 1073741824,
    chunkedUploads: true,
    resumable: true,
    uploadTtlSeconds: 3600,
    downloadResume: true,
    retentionSeconds: 86400,
  },
  recovery: {
    schemaVersion: '1',
    invocationLookup: true,
    outcomeUnknown: true,
    retentionSeconds: 86400,
    retentionRefs: [],
  },
};

const packProfile = {
  schemaVersion: '1',
  packId: 'freecad-pack',
  packVersion: '1.2.0',
  packDigest: hash,
  coreApi: { min: 1, max: 1 },
  tools: [
    {
      schemaVersion: '1',
      id: 'cad.model.build',
      version: '1.0.0',
      risk: 'mutating',
      verification: ['cad-readback'],
    },
    {
      schemaVersion: '1',
      id: 'cad.model.inspect',
      version: '1.0.0',
      risk: 'read-only',
      verification: [],
    },
  ],
  remoteProfiles: ['linux-freecad-1'],
};

test('service info freezes protocol version, contract version and feature flags separately', () => {
  const parsed = RemoteServiceInfoSchema.parse(serviceInfo);
  assert.equal(parsed.protocolVersion, '1.1');
  assert.equal(parsed.contractsVersion, '1');
  assert.deepEqual(parsed.features, REMOTE_PROTOCOL_FEATURES);
  assert.equal(missingRemoteFeatures(serviceInfo, ['source-changesets', 'sync-ack']).length, 0);
  // A service missing a feature reports the concrete gap; no silent fallback.
  const partial = { ...serviceInfo, features: ['upload-sessions'] };
  assert.deepEqual(missingRemoteFeatures(partial, ['upload-sessions', 'source-changesets']), [
    'source-changesets',
  ]);
  assert.equal(
    RemoteFeatureFlagsSchema.safeParse([...REMOTE_PROTOCOL_FEATURES, 'teleport']).success,
    false,
  );
  assert.equal(
    RemoteFeatureFlagsSchema.safeParse(['upload-sessions', 'upload-sessions']).success,
    false,
  );
  // Credentials never travel inside service metadata (account isolation, #189).
  assert.equal(
    RemoteServiceInfoSchema.safeParse({ ...serviceInfo, token: 'secret' }).success,
    false,
  );
  assert.equal(
    RemoteServiceInfoSchema.safeParse({
      ...serviceInfo,
      service: { ...serviceInfo.service, credential: 'secret' },
    }).success,
    false,
  );
});

test('qualification pins the runtime digest and explains every unavailable tool', () => {
  const parsed = RemoteProfileQualificationSchema.parse(serviceInfo.qualifiedProfiles[0]);
  assert.equal(parsed.runtime.digest, hash);
  assert.equal(
    RemoteProfileQualificationSchema.safeParse({
      ...serviceInfo.qualifiedProfiles[0],
      tools: [{ id: 'cad.model.build', available: false, reason: null }],
    }).success,
    false,
  );
  assert.equal(
    RemoteProfileQualificationSchema.safeParse({
      ...serviceInfo.qualifiedProfiles[0],
      tools: [
        { id: 'a', available: true, reason: null },
        { id: 'a', available: true, reason: null },
      ],
    }).success,
    false,
  );
});

test('capability negotiation uses only the pack-declared and service-qualified intersection', () => {
  const qualification = {
    ...serviceInfo.qualifiedProfiles[0],
    tools: [
      { id: 'cad.model.build', available: true, reason: null },
      { id: 'cad.model.inspect', available: false, reason: 'KiCad-only sandbox image.' },
      // A directory-listed tool the Pack never declared stays untrusted.
      { id: 'shell.exec', available: true, reason: null },
    ],
  };
  const negotiated = negotiateRemoteProfile(packProfile, qualification);
  assert.deepEqual(negotiated.tools, ['cad.model.build']);
  assert.deepEqual(negotiated.unavailable, [
    { id: 'cad.model.inspect', reason: 'KiCad-only sandbox image.' },
  ]);
  assert.equal(negotiated.runtimeDigest, hash);
  const unreported = negotiateRemoteProfile(packProfile, serviceInfo.qualifiedProfiles[0]);
  assert.deepEqual(unreported.unavailable, [
    { id: 'cad.model.inspect', reason: 'Not reported by the service.' },
  ]);
  assert.throws(
    () =>
      negotiateRemoteProfile(packProfile, {
        ...serviceInfo.qualifiedProfiles[0],
        profileId: 'linux-unknown-9',
      }),
    /not supported/,
  );
});

test('pack execution profiles pin identity, core range and declared remote profiles', () => {
  assert.equal(PackExecutionProfileSchema.safeParse(packProfile).success, true);
  assert.equal(
    PackExecutionProfileSchema.safeParse({
      ...packProfile,
      coreApi: { min: 2, max: 1 },
    }).success,
    false,
  );
  assert.equal(
    PackExecutionProfileSchema.safeParse({ ...packProfile, remoteProfiles: [] }).success,
    false,
  );
  // Mutating tools inherit the canonical verifier-declaration rule.
  assert.equal(
    PackExecutionProfileSchema.safeParse({
      ...packProfile,
      tools: [
        {
          schemaVersion: '1',
          id: 'cad.model.build',
          version: '1.0.0',
          risk: 'mutating',
          verification: [],
        },
      ],
    }).success,
    false,
  );
});

test('mutation policy is declared, never inferred from suffixes', () => {
  const policy = {
    schemaVersion: '1',
    toolId: 'pcb.design.board-outline',
    effect: 'mutates-source',
    persistence: 'transaction-group',
    transactionGroup: 'pcb-edit-tx',
  };
  assert.equal(ToolMutationPolicySchema.safeParse(policy).success, true);
  assert.equal(
    ToolMutationPolicySchema.safeParse({ ...policy, transactionGroup: undefined }).success,
    false,
  );
  assert.equal(
    ToolMutationPolicySchema.safeParse({ ...policy, effect: 'probably-readonly' }).success,
    false,
  );
  const workspace = {
    schemaVersion: '1',
    dependencyResolution: 'pack-resolver',
    pathParameters: ['board', 'schematic'],
    allow: ['**/*.kicad_pcb'],
    exclude: ['.git/**'],
    hooks: { save: true, reload: true, checkpoint: true },
  };
  assert.equal(WorkspacePolicySchema.safeParse(workspace).success, true);
  const result = {
    schemaVersion: '1',
    toolId: 'pcb.design.board-outline',
    collector: 'pcb-workspace-collector',
    presentations: ['board-preview'],
    requiresCompleteGroup: true,
  };
  assert.equal(ToolResultPolicySchema.safeParse(result).success, true);
});

test('input snapshot manifests are sorted, unique and reject unsafe paths', () => {
  const manifest = {
    schemaVersion: '1',
    files: [
      { path: 'a/board.kicad_pcb', sha256: hash, sizeBytes: 10 },
      { path: 'b/project.kicad_pro', sha256: otherHash, sizeBytes: 5 },
    ],
  };
  assert.equal(RemoteSnapshotManifestSchema.safeParse(manifest).success, true);
  assert.equal(
    RemoteSnapshotManifestSchema.safeParse({
      ...manifest,
      files: [manifest.files[1], manifest.files[0]],
    }).success,
    false,
  );
  assert.equal(
    RemoteSnapshotManifestSchema.safeParse({
      ...manifest,
      files: [manifest.files[0], manifest.files[0]],
    }).success,
    false,
  );
  for (const path of ['../outside', '/etc/passwd', 'C:/x', 'a//b', 'a\\b'])
    assert.equal(
      RemoteSnapshotManifestSchema.safeParse({
        ...manifest,
        files: [{ path, sha256: hash, sizeBytes: 1 }],
      }).success,
      false,
    );
  // The legacy 0.1 manifest stays readable by the old protocol but is not the
  // versioned remote sync contract.
  assert.equal(
    RemoteSnapshotManifestSchema.safeParse({ schemaVersion: '0.1', files: manifest.files }).success,
    false,
  );
});

test('upload sessions carry only missing blobs with unique digests', () => {
  const session = {
    schemaVersion: '1',
    uploadId: id(),
    remoteProjectId: id(),
    baseSnapshotId: 'R0',
    manifestDigest: hash,
    missing: [{ path: 'a/board.kicad_pcb', sha256: hash, sizeBytes: 10 }],
    expiresAt: now(),
  };
  assert.equal(RemoteUploadSessionSchema.safeParse(session).success, true);
  assert.equal(
    RemoteUploadSessionSchema.safeParse({
      ...session,
      missing: [...session.missing, { path: 'a/other.kicad_pcb', sha256: hash, sizeBytes: 10 }],
    }).success,
    false,
  );
});

const changeSet = {
  schemaVersion: '1',
  id: id(),
  projectId: hash,
  invocationId: id(),
  actionId: id(),
  baseSnapshotId: 'R0',
  outputSnapshotId: 'R1',
  changes: [
    {
      op: 'modify',
      path: 'board.kicad_pcb',
      before: { sha256: hash, sizeBytes: 10 },
      after: { sha256: otherHash, sizeBytes: 12 },
    },
    { op: 'add', path: 'reports/drc.rpt', before: null, after: { sha256: hash, sizeBytes: 3 } },
    { op: 'delete', path: 'old/outline.dxf', before: { sha256: hash, sizeBytes: 8 }, after: null },
    {
      op: 'rename',
      path: 'sch/main.kicad_sch',
      from: 'sch/root.kicad_sch',
      before: { sha256: hash, sizeBytes: 7 },
      after: { sha256: hash, sizeBytes: 7 },
    },
  ],
  groups: [['board.kicad_pcb', 'reports/drc.rpt']],
};

test('source change sets bind base/output snapshots and per-path content identity', () => {
  assert.equal(SourceChangeSetSchema.safeParse(changeSet).success, true);
  // Base and output revisions must differ.
  assert.equal(
    SourceChangeSetSchema.safeParse({ ...changeSet, outputSnapshotId: 'R0' }).success,
    false,
  );
  // A path changes once per set.
  const duplicated = {
    ...changeSet,
    groups: [],
    changes: [changeSet.changes[0], { ...changeSet.changes[1], path: 'board.kicad_pcb' }],
  };
  assert.equal(SourceChangeSetSchema.safeParse(duplicated).success, false);
  // Dependency groups reference changed paths only, each at most once.
  assert.equal(
    SourceChangeSetSchema.safeParse({ ...changeSet, groups: [['not/changed.txt']] }).success,
    false,
  );
  assert.equal(
    SourceChangeSetSchema.safeParse({
      ...changeSet,
      groups: [['board.kicad_pcb'], ['board.kicad_pcb']],
    }).success,
    false,
  );
  // Modify requires real content change; rename keeps content.
  const fakeModify = {
    ...changeSet,
    groups: [],
    changes: [{ ...changeSet.changes[0], after: { sha256: hash, sizeBytes: 10 } }],
  };
  assert.equal(SourceChangeSetSchema.safeParse(fakeModify).success, false);
  const renameWithEdit = {
    ...changeSet,
    groups: [],
    changes: [{ ...changeSet.changes[3], after: { sha256: otherHash, sizeBytes: 9 } }],
  };
  assert.equal(SourceChangeSetSchema.safeParse(renameWithEdit).success, false);
  // Non-rename operations never carry a source path.
  const strayFrom = {
    ...changeSet,
    groups: [],
    changes: [{ ...changeSet.changes[1], from: 'elsewhere.txt' }],
  };
  assert.equal(SourceChangeSetSchema.safeParse(strayFrom).success, false);
  // Change sets never overwrite arbitrary local paths.
  const escape = {
    ...changeSet,
    groups: [],
    changes: [{ ...changeSet.changes[0], path: '../../outside' }],
  };
  assert.equal(SourceChangeSetSchema.safeParse(escape).success, false);
});

test('artifact bundles rebind canonical artifacts and presentation to their action', () => {
  const artifact = {
    schemaVersion: '1',
    id: id(),
    projectId: hash,
    runId: id(),
    actionId: changeSet.actionId,
    kind: 'report',
    relativePath: 'reports/drc.rpt',
    sha256: hash,
    sizeBytes: 3,
    source: 'domain-tool',
    inputHashes: { 'board.kicad_pcb': hash },
  };
  const bundle = {
    schemaVersion: '1',
    id: id(),
    projectId: hash,
    actionId: changeSet.actionId,
    artifacts: [artifact],
    presentation: {
      schemaVersion: '1',
      actionId: changeSet.actionId,
      groups: [],
      checks: [],
      diagnostics: [],
    },
  };
  assert.equal(RemoteArtifactBundleSchema.safeParse(bundle).success, true);
  assert.equal(
    RemoteArtifactBundleSchema.safeParse({
      ...bundle,
      presentation: { ...bundle.presentation, actionId: id() },
    }).success,
    false,
  );
  assert.equal(
    RemoteArtifactBundleSchema.safeParse({
      ...bundle,
      artifacts: [{ ...artifact, actionId: id() }],
    }).success,
    false,
  );
});

test('invocation records persist identity before dispatch and never carry credentials', () => {
  const invocation = {
    schemaVersion: '1',
    invocationId: id(),
    projectId: hash,
    toolId: 'pcb.design.board-outline',
    toolVersion: '1.0.0',
    inputSnapshotId: 'R0',
    expectedStateId: id(),
    capabilityHash: hash,
    intentHash: otherHash,
    grantId: id(),
    status: 'submitted',
    submittedAt: now(),
  };
  assert.equal(RemoteInvocationRecordSchema.safeParse(invocation).success, true);
  for (const field of ['token', 'credential', 'authorization'])
    assert.equal(
      RemoteInvocationRecordSchema.safeParse({ ...invocation, [field]: 'secret' }).success,
      false,
    );
  assert.equal(
    RemoteInvocationRecordSchema.safeParse({ ...invocation, status: 'maybe-done' }).success,
    false,
  );
});

test('sync coordinator transitions follow the frozen table', () => {
  // Source-changing happy path.
  let status = 'PREPARED';
  for (const event of ['dispatch', 'remote-committed', 'apply-started', 'apply-completed'])
    status = reduceSyncState(status, event);
  assert.equal(status, 'READY');
  // Read-only and artifacts-only calls skip local apply.
  status = reduceSyncState(reduceSyncState('PREPARED', 'dispatch'), 'remote-committed');
  assert.equal(reduceSyncState(status, 'no-source-change'), 'READY');
  // Outcome recovery queries by identity; it never replays.
  const unknown = reduceSyncState('DISPATCHED', 'outcome-lost');
  assert.equal(unknown, 'OUTCOME_UNKNOWN');
  assert.equal(reduceSyncState(unknown, 'outcome-committed'), 'REMOTE_COMMITTED');
  assert.equal(reduceSyncState(unknown, 'outcome-not-submitted'), 'NOT_SUBMITTED');
  // Only explicit not-submitted rejections retry, back through preparation.
  assert.equal(reduceSyncState('NOT_SUBMITTED', 'retry'), 'PREPARED');
  // Crash during local apply resumes through recovery, not re-execution.
  assert.equal(reduceSyncState('RECOVERY_REQUIRED', 'resume-apply'), 'LOCAL_APPLYING');
  // Terminal states and illegal moves are rejected.
  for (const event of SYNC_EVENTS) {
    assert.throws(() => reduceSyncState('READY', event), /not allowed/);
    assert.throws(() => reduceSyncState('CONFLICT', event), /not allowed/);
  }
  assert.throws(() => reduceSyncState('DISPATCHED', 'apply-completed'), /not allowed/);
  assert.throws(() => reduceSyncState('OUTCOME_UNKNOWN', 'retry'), /not allowed/);
  assert.throws(() => reduceSyncState('REMOTE_COMMITTED', 'dispatch'), /not allowed/);
  assert.throws(() => reduceSyncState('BOGUS', 'dispatch'), /Unknown sync state/);
  assert.throws(() => reduceSyncState('PREPARED', 'teleport'), /Unknown sync event/);
  // The table covers exactly the declared states and events.
  for (const key of Object.keys(SYNC_TRANSITIONS)) {
    const [from, event] = key.split(':');
    assert.ok(SYNC_STATES.includes(from));
    assert.ok(SYNC_EVENTS.includes(event));
    assert.ok(SYNC_STATES.includes(SYNC_TRANSITIONS[key]));
  }
});

test('sync state records keep snapshot and change-set identity consistent', () => {
  const base = {
    schemaVersion: '1',
    invocationId: id(),
    projectId: hash,
    status: 'REMOTE_COMMITTED',
    baseSnapshotId: 'R0',
    outputSnapshotId: 'R1',
    appliedSnapshotId: null,
    changeSetId: id(),
    updatedAt: now(),
  };
  assert.equal(RemoteSyncStateSchema.safeParse(base).success, true);
  assert.equal(RemoteSyncStateSchema.safeParse({ ...base, outputSnapshotId: null }).success, false);
  assert.equal(RemoteSyncStateSchema.safeParse({ ...base, status: 'READY' }).success, false);
  assert.equal(
    RemoteSyncStateSchema.safeParse({ ...base, status: 'READY', appliedSnapshotId: 'R1' }).success,
    true,
  );
  // No-source-change calls reach READY without an applied snapshot.
  assert.equal(
    RemoteSyncStateSchema.safeParse({
      ...base,
      status: 'READY',
      changeSetId: null,
      appliedSnapshotId: null,
    }).success,
    true,
  );
});

test('session bindings separate the three identities and exclude tokens', () => {
  const binding = {
    schemaVersion: '1',
    serviceOrigin: 'https://remote.example.com',
    serverId: id(),
    principalSubject: 'user-123',
    localProjectId: hash,
    remoteProjectId: id(),
    domain: 'pcb',
    chatId: id(),
    clientSessionId: id(),
    applicationSessionId: id(),
    profileId: 'linux-kicad-1',
    appliedSnapshotId: 'R1',
  };
  assert.equal(RemoteSessionBindingSchema.safeParse(binding).success, true);
  // Reconnect key and server-issued session are never the same identity.
  const same = { ...binding, applicationSessionId: binding.clientSessionId };
  assert.equal(RemoteSessionBindingSchema.safeParse(same).success, false);
  for (const origin of [
    'http://remote.example.com',
    'https://user:pass@remote.example.com',
    'https://remote.example.com/path',
    'https://remote.example.com?x=1',
    'not-a-url',
  ])
    assert.equal(
      RemoteSessionBindingSchema.safeParse({ ...binding, serviceOrigin: origin }).success,
      false,
    );
  assert.equal(
    RemoteSessionBindingSchema.safeParse({ ...binding, serviceOrigin: 'http://127.0.0.1' }).success,
    true,
  );
  // A token cannot hide in a binding; a new account cannot reuse one either
  // without changing the persisted principal subject.
  assert.equal(
    RemoteSessionBindingSchema.safeParse({ ...binding, token: 'secret' }).success,
    false,
  );
});

test('remote contract version is independent and rejects unknown versions', () => {
  assert.equal(REMOTE_SCHEMA_VERSION, '1');
  assert.equal(
    RemoteInvocationRecordSchema.safeParse({
      ...{
        schemaVersion: '2',
        invocationId: id(),
        projectId: hash,
        toolId: 't',
        toolVersion: '1',
        inputSnapshotId: 'R0',
        expectedStateId: id(),
        capabilityHash: hash,
        intentHash: hash,
        grantId: id(),
        status: 'submitted',
        submittedAt: now(),
      },
    }).success,
    false,
  );
});
