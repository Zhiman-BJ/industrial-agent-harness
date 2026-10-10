const { z } = require('zod');

const INDUSTRIAL_SCHEMA_VERSION = '1';
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const ObservedArtifactSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  relativePath: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256,
  source: z.literal('project-file'),
  verificationStatus: z.literal('not_run'),
});

const ObservedStateSchema = z.object({
  projectId: z.string().min(1),
  domain: z.string().min(1),
  artifacts: z.array(ObservedArtifactSchema),
  staleArtifactIds: z.array(z.string().min(1)),
});

const ContextCheckpointSchema = z.object({
  id: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  stateHash: sha256,
  createdAt: z.string().datetime(),
  state: ObservedStateSchema,
});

const VerificationResultSchema = z.object({
  status: z.enum(['not_run', 'passed', 'failed', 'insufficient_evidence']),
  schemaVersion: z.literal(INDUSTRIAL_SCHEMA_VERSION).optional(),
  id: z.string().uuid().optional(),
  metrics: z.record(z.string(), z.union([z.number().finite(), z.boolean(), z.string()])).optional(),
  evidence: z
    .object({ artifactIds: z.array(z.string().uuid()), inputHashes: z.record(z.string(), sha256) })
    .optional(),
  verifierId: z.string().min(1).nullable(),
  reason: z.string().min(1),
});

const ActionRecordSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  projectId: sha256,
  domain: z.string().min(1),
  toolId: z.string().min(1),
  schemaVersion: z.literal(INDUSTRIAL_SCHEMA_VERSION).optional(),
  toolVersion: z.string().min(1).optional(),
  stateId: z.string().uuid().optional(),
  inputHashes: z.record(z.string(), sha256).optional(),
  inputs: z.record(z.string(), z.unknown()),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  status: z.enum(['running', 'completed', 'failed']),
  diagnostics: z.array(z.string()),
  artifactIds: z.array(z.string()),
  verification: VerificationResultSchema,
});

// New industrial facts always carry an explicit version. Historical observation
// schemas remain readable and cannot become engineering evidence by migration.
const relativePath = z
  .string()
  .min(1)
  .refine(
    value =>
      !value.includes('\\') &&
      !value.includes('\0') &&
      !value.startsWith('/') &&
      !/^[A-Za-z]:/.test(value) &&
      !value.split('/').some(part => !part || part === '.' || part === '..'),
    'Expected a project-relative POSIX path',
  );
const inputHashes = z.record(relativePath, sha256);
const uuid = z.string().uuid();
const version = z.literal(INDUSTRIAL_SCHEMA_VERSION);
const ProjectRefSchema = z
  .object({ schemaVersion: version, projectId: sha256, domain: z.string().min(1) })
  .strict();
const ArtifactRefSchema = z
  .object({
    schemaVersion: version,
    id: uuid,
    projectId: sha256,
    runId: uuid,
    actionId: uuid,
    kind: z.string().min(1),
    relativePath,
    sha256,
    sizeBytes: z.number().int().nonnegative(),
    source: z.literal('domain-tool'),
    inputHashes,
  })
  .strict();
const DomainStateSchema = z
  .object({
    schemaVersion: version,
    id: uuid,
    projectId: sha256,
    domain: z.string().min(1),
    stage: z.string().min(1).nullable(),
    status: z.enum(['unverified', 'verified', 'failed', 'stale']),
    artifacts: z.array(ArtifactRefSchema),
    inputHashes,
    verificationIds: z.array(uuid),
    createdAt: z.string().datetime(),
  })
  .strict()
  .refine(
    state => state.status !== 'verified' || state.verificationIds.length > 0,
    'Verified state requires a verification identity',
  );
const RunRecordSchema = z
  .object({
    schemaVersion: version,
    id: uuid,
    projectId: sha256,
    domain: z.string().min(1),
    stateId: uuid,
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().nullable(),
    status: z.enum(['running', 'completed', 'failed']),
    actionIds: z.array(uuid),
  })
  .strict();
const IndustrialVerificationResultSchema = z
  .object({
    schemaVersion: version,
    id: uuid,
    status: z.enum(['not_run', 'passed', 'failed', 'insufficient_evidence']),
    verifierId: z.string().min(1).nullable(),
    reason: z.string().min(1),
    metrics: z.record(z.string(), z.union([z.number().finite(), z.boolean(), z.string()])),
    evidence: z.object({ artifactIds: z.array(uuid), inputHashes }).strict(),
  })
  .strict()
  .refine(
    result =>
      !['passed', 'failed'].includes(result.status) ||
      (result.verifierId !== null &&
        (result.evidence.artifactIds.length > 0 ||
          Object.keys(result.evidence.inputHashes).length > 0)),
    'Engineering verification requires a verifier and content-bound evidence',
  );
const IndustrialActionRecordSchema = ActionRecordSchema.extend({
  schemaVersion: version,
  toolVersion: z.string().min(1),
  stateId: uuid,
  inputHashes,
  artifactIds: z.array(uuid),
  verification: IndustrialVerificationResultSchema,
}).strict();
const IndustrialCheckpointSchema = z
  .object({
    schemaVersion: version,
    id: uuid,
    parentId: uuid.nullable(),
    stateHash: sha256,
    createdAt: z.string().datetime(),
    state: DomainStateSchema,
    runId: uuid.nullable(),
    actionIds: z.array(uuid),
    artifactIds: z.array(uuid),
  })
  .strict();
const ToolDescriptorSchema = z
  .object({
    schemaVersion: version,
    id: z.string().min(1),
    version: z.string().min(1),
    risk: z.enum(['read-only', 'mutating']),
    effect: z.enum(['inputs', 'execution', 'external']).optional(),
    verification: z.array(z.string().min(1)),
  })
  .strict()
  .refine(
    tool => tool.risk !== 'mutating' || tool.verification.length > 0,
    'Mutating tools require a verifier declaration',
  );
const ActionRequestSchema = ProjectRefSchema.extend({
  toolId: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()),
  expectedStateId: uuid,
}).strict();

module.exports = {
  ...require('./agents.cjs'),
  ...require('./workspace.cjs'),
  ...require('./results.cjs'),
  INDUSTRIAL_SCHEMA_VERSION,
  ProjectRefSchema,
  ArtifactRefSchema,
  DomainStateSchema,
  RunRecordSchema,
  IndustrialActionRecordSchema,
  IndustrialVerificationResultSchema,
  IndustrialCheckpointSchema,
  ToolDescriptorSchema,
  ActionRequestSchema,
  ObservedArtifactSchema,
  ObservedStateSchema,
  ContextCheckpointSchema,
  VerificationResultSchema,
  ActionRecordSchema,
};
