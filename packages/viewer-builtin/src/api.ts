export interface LayoutMeta {
  token: string;
  cell: string;
  bbox: number[];
  layers: Array<{ key: string; name: string }>;
  klayout: string;
}

export interface NetlistData {
  token: string;
  svg: string;
  top: string;
  modules: string[];
  cellCount: number;
  totalCells?: number;
  partial?: boolean;
  focus?: string;
  nets: Array<{ name: string; bits: Array<number | string> }>;
  cells: Array<{ name: string; type: string }>;
  elapsed_ms: number;
}

export interface ViewerArtifact {
  id: string;
  kind:
    | 'layout'
    | 'netlist'
    | 'waveform'
    | 'godot'
    | 'kicad'
    | 'engineering'
    | 'cad'
    | 'image'
    | 'sprite'
    | 'animation'
    | DocumentKind;
  name: string;
  design: string;
  sizeBytes: number;
  sha256: string;
  source: 'project file';
}

export interface WaveformData {
  url: string;
  name: string;
  defaultSignals?: string[];
  initialRange?: [number, number];
}

export interface GodotNode {
  path: string;
  name: string;
  class: string;
  children: GodotNode[];
}
export interface GodotState {
  scene: string;
  tree: GodotNode | null;
  paused: boolean;
  selectedPath: string;
  overlays: { collision: boolean; navmesh: boolean; physics: boolean };
}
export interface GodotData {
  token: string;
  name: string;
  url: string;
}
export interface KiCadData {
  token: string;
  name: string;
  document: 'board' | 'schematic';
  url: string;
}
export interface CadData {
  sketches?: CadSketch[];
  brep?: string;
  name: string;
  sha256: string;
  vertices: number[];
  bounds: number[];
  triangles: number;
  companions: Array<{ name: string; sha256: string }>;
}
export type CadSketchGeometry = { index: number; construction: boolean } & (
  | { kind: 'line'; start: number[]; end: number[] }
  | { kind: 'circle'; center: number[]; radius: number }
  | { kind: 'unsupported'; type: string }
);
export interface CadSketch {
  name: string;
  label: string;
  fullyConstrained: boolean;
  origin: number[];
  rotation: number[];
  geometry: CadSketchGeometry[];
  constraints: Array<{
    index: number;
    type: string;
    value: number;
    driving: boolean | null;
    first: number;
    firstPos: number;
    second: number;
    secondPos: number;
    third: number;
    thirdPos: number;
  }>;
}
export interface AssetImage {
  name: string;
  url: string;
  width: number;
  height: number;
  sha256: string;
}
export interface SpriteFrame {
  image: number;
  rect: [number, number, number, number];
  duration: number;
}
export interface SpriteAnimation {
  name: string;
  loop: boolean;
  frames: SpriteFrame[];
}
export interface AssetData {
  name: string;
  images: AssetImage[];
  columns: number;
  rows: number;
  animations: SpriteAnimation[];
  initialMode: 'image' | 'sprite' | 'animation';
}
export interface EngineeringSection {
  id: string;
  label: string;
  kind: string;
  line: number;
  properties: Record<string, string>;
}
export type EngineeringDrawing =
  | { type: 'line'; x1: number; y1: number; x2: number; y2: number; width?: number; group: string }
  | {
      type: 'rect' | 'pad';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      label?: string;
      group: string;
    }
  | { type: 'circle'; x: number; y: number; r: number; group: string }
  | { type: 'polyline'; points: number[][]; group: string }
  | { type: 'label'; x: number; y: number; label: string; group: string };
export interface EngineeringData {
  name: string;
  sha256: string;
  format: string;
  summary: string;
  sections: EngineeringSection[];
  drawings?: EngineeringDrawing[];
  links: Array<{ path: string; status: string }>;
  warnings: string[];
  source?: string;
  mediaUrl?: string;
  animation?: AssetData;
  mode: 'structure' | 'source' | 'metadata' | 'media' | 'geometry';
}
export type DocumentKind = 'table' | 'json' | 'jsonl' | 'markdown' | 'text';
export interface DocumentData {
  text: string;
  rows?: string[][];
  columns?: number;
  ragged?: boolean;
  records?: number;
  error?: string;
  warning?: string;
}

export type OpenedViewer =
  | { kind: 'layout'; artifact: ViewerArtifact; data: LayoutMeta }
  | { kind: 'netlist'; artifact: ViewerArtifact; data: NetlistData }
  | { kind: 'waveform'; artifact: ViewerArtifact; data: WaveformData }
  | { kind: 'godot'; artifact: ViewerArtifact; data: GodotData }
  | { kind: 'kicad'; artifact: ViewerArtifact; data: KiCadData }
  | { kind: 'engineering'; artifact: ViewerArtifact; data: EngineeringData }
  | { kind: 'cad'; artifact: ViewerArtifact; data: CadData }
  | { kind: 'image' | 'sprite' | 'animation'; artifact: ViewerArtifact; data: AssetData }
  | { kind: DocumentKind; artifact: ViewerArtifact; data: DocumentData };

export interface ViewerHostApi {
  open(request: { artifactId: string }): Promise<OpenedViewer>;
  openExternalArtifact(artifactId: string): Promise<{ launched: true }>;
  render(request: {
    token: string;
    box: number[];
    width: number;
    height: number;
    visible: string[];
    quality: string;
    theme?: string;
  }): Promise<{ png: string; box: number[] }>;
  netlist(request: { token: string; module: string; focus?: string }): Promise<NetlistData>;
  resolve(request: {
    task: string;
    chatId?: string;
    artifactKind?: string;
    domain?: string;
    stage?: string;
  }): Promise<BrokerResult>;
  domains(): Promise<DomainOption[]>;
  domainStatus(): Promise<DomainInstallationStatus>;
  domainAvailable(): Promise<AvailableDomainPack[]>;
  domainCancel(): Promise<{ cancelled: boolean }>;
  domainInstall(domains: string[]): Promise<{ installed: DomainOption[] }>;
  domainRemove(domain: string): Promise<{ installed: DomainOption[] }>;
  domainRepair(domain: string): Promise<{ installed: DomainOption[] }>;
  onDomainProgress(callback: (progress: DomainInstallProgress) => void): () => void;
  coreUpdateStatus(): Promise<CoreUpdateState>;
  coreUpdateCheck(): Promise<CoreUpdateState>;
  coreUpdateInstall(): Promise<void>;
  onCoreUpdateChanged(callback: (state: CoreUpdateState) => void): () => void;
  resourceGet(request: { projectId?: string }): Promise<ResourceSettingsSnapshot>;
  resourceSet(request: {
    projectId?: string;
    kind: 'skill' | 'mcp';
    id: string;
    mode: ResourceMode;
  }): Promise<ResourceSettingsSnapshot>;
  resourceCatalog(): Promise<ResourceCatalog>;
  remoteService(): Promise<RemoteServiceState>;
  remoteCheck(): Promise<RemoteServiceState>;
  remoteProject(request: { projectId: string }): Promise<RemoteProjectState>;
  remoteFiles(request: { projectId: string }): Promise<string[]>;
  remoteSetLocation(request: {
    projectId: string;
    location: 'local' | 'remote';
  }): ReturnType<ViewerHostApi['projectBindings']>;
  remoteReview(request: { projectId: string; files: string[] }): Promise<RemoteSyncReview>;
  remoteSync(request: {
    projectId: string;
    reviewId: string;
  }): ReturnType<ViewerHostApi['projectBindings']>;
  remoteTask(request: { projectId: string }): Promise<RemoteTaskState | null>;
  remoteCancel(request: {
    projectId: string;
    requestId: string;
    jobId: string;
  }): Promise<RemoteTaskState | null>;
  externalMcpList(): Promise<ExternalMcpSummary[]>;
  externalMcpAdd(request: { configuration: string }): Promise<ExternalMcpSummary[]>;
  externalMcpRefresh(id: string): Promise<ExternalMcpSummary[]>;
  externalMcpRemove(id: string): Promise<ExternalMcpSummary[]>;
  detail(capabilityId: string): Promise<CapabilityDetail>;
  brokerTrace(): Promise<BrokerResult['trace']>;
  diagnosticRuns(request: {
    projectId: string;
  }): Promise<{ runs: DiagnosticRun[]; limited: boolean }>;
  diagnosticPage(request: {
    projectId: string;
    runId: string;
    offset?: number;
    category?: DiagnosticCategory | 'all';
    query?: string;
  }): Promise<DiagnosticPage>;
  diagnosticView(request: {
    projectId: string;
    runId: string;
    view: DiagnosticView;
    offset?: number;
    query?: string;
  }): Promise<DiagnosticViewPage>;
  diagnosticDetail(request: {
    projectId: string;
    runId: string;
    id: string;
    field: string;
    offset?: number;
  }): Promise<DiagnosticContent>;
  diagnosticRecord(request: {
    projectId: string;
    runId: string;
    sequence: number;
    offset?: number;
  }): Promise<DiagnosticContent>;
  agentStatus(): Promise<{
    available: boolean;
    version: string;
    projectDir: string | null;
    configured: boolean;
    gui?: GuiPluginState;
  }>;
  guiState(): Promise<GuiPluginState>;
  openGuiPermissionSettings(permission: 'screen' | 'accessibility'): Promise<void>;
  setGuiPlugin(enabled: boolean): Promise<GuiPluginState>;
  onGuiProgress(
    callback: (event: { phase: string; tag?: string; cached?: boolean; error?: string }) => void,
  ): () => void;
  modelGet(): Promise<ModelProfileStatus>;
  modelSave(
    request: ModelProfile & { apiKey?: string; clearApiKey?: boolean },
  ): Promise<ModelProfileStatus>;
  chooseProjectDirectory(locale?: string): Promise<string | null>;
  createProject(request: {
    directory: string;
    name: string;
    domain: string;
  }): Promise<{ projects: ProjectBinding[]; activeId: string | null; projectDir: string | null }>;
  projectBindings(): Promise<{
    projects: ProjectBinding[];
    activeId: string | null;
    projectDir: string | null;
  }>;
  selectProject(
    id: string,
  ): Promise<{ projects: ProjectBinding[]; activeId: string | null; projectDir: string | null }>;
  setProjectDomain(
    id: string,
    domain: string,
  ): Promise<{ projects: ProjectBinding[]; activeId: string | null; projectDir: string | null }>;
  setProjectResource(
    projectId: string,
    kind: 'skill' | 'mcp',
    id: string,
    enabled: boolean,
  ): Promise<{ projects: ProjectBinding[]; activeId: string | null; projectDir: string | null }>;
  chats(): Promise<{ chats: ChatSummary[]; activeId: string | null; sessions: SessionStatus[] }>;
  chatHistory(request: { id: string; before?: string | null }): Promise<ChatHistory>;
  selectChat(id: string): Promise<ChatHistory>;
  deleteChat(
    id: string,
  ): Promise<{ chats: ChatSummary[]; activeId: string | null; sessions: SessionStatus[] }>;
  renameChat(
    id: string,
    title: string,
  ): Promise<{ chats: ChatSummary[]; activeId: string | null; sessions: SessionStatus[] }>;
  onChatUpdated(callback: () => void): () => void;
  onModelChanged(callback: () => void): () => void;
  onProjectsChanged(callback: () => void): () => void;
  newChat(): Promise<ChatHistory>;
  projectFiles(): Promise<Array<{ path: string; name: string; depth: number; directory: boolean }>>;
  readProjectFile(relative: string): Promise<{
    path: string;
    name: string;
    sizeBytes: number;
    viewer: ViewerArtifact['kind'] | null;
    content: string | null;
    truncated: boolean;
  }>;
  revealResult(request: ResultOpenRequest): Promise<void>;
  openResult(request: ResultOpenRequest): Promise<{
    path: string;
    name: string;
    artifact?: ViewerArtifact;
    source?: {
      path: string;
      name: string;
      sizeBytes: number;
      viewer: ViewerArtifact['kind'] | null;
      content: string | null;
      truncated: boolean;
    };
  }>;
  openProjectFile(relative: string): Promise<ViewerArtifact>;
  validateImages(request: { projectId: string; images: PromptImage[] }): Promise<PromptImage[]>;
  runAgent(
    task: string | { task: string; chatId?: string; projectId?: string; images?: PromptImage[] },
    chatId?: string,
  ): Promise<{ started: boolean }>;
  approveAgent(
    id: string,
    response: 'approve' | 'approve_for_session' | 'reject',
    chatId?: string,
  ): Promise<void>;
  answerAgentQuestion(id: string, answers: Record<string, string>, chatId?: string): Promise<void>;
  setChatApprovalMode(request: {
    projectId: string;
    chatId: string;
    mode: 'ask' | 'auto';
  }): Promise<'ask' | 'auto'>;
  interruptAgent(chatId?: string): Promise<void>;
  onAgentEvent(callback: (event: AgentEvent) => void): () => void;
  window: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
  };
  platform: NodeJS.Platform;
}

export interface ProjectBinding {
  id: string;
  name: string;
  path: string;
  domain?: string | null;
  executionLocation?: 'local' | 'remote';
  disabledSkills?: string[];
  disabledMcpServers?: string[];
}
export interface GuiPluginState {
  enabled: boolean;
  install: 'missing' | 'ready' | 'installing' | 'error' | string;
  version: string | null;
  permissions?: {
    screen: 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';
    accessibility: 'granted' | 'denied' | 'unknown';
  } | null;
  error?: string;
}
export interface InstallationFootprint {
  downloadBytes: number;
  installedBytes: number;
  requiredBytes: number;
  availableBytes?: number;
  cacheReused?: boolean;
  estimated?: boolean;
}
export interface DomainInstallProgress {
  domain?: string;
  label: string;
  phase: string;
  active?: boolean;
  received?: number;
  total?: number;
  bytesPerSecond?: number;
  etaSeconds?: number;
  requiredBytes?: number;
  availableBytes?: number;
  downloadBytes?: number;
  installedBytes?: number;
  cacheReused?: boolean;
}
export interface InstalledDomainPack {
  domain: string;
  version: string;
  label: string;
  emoji: string;
  summary?: string;
  prerequisites?: string[];
  runtimeState?: 'ready' | 'needs-preparation' | 'external-dependencies' | 'installed' | null;
}
export interface AvailableDomainPack {
  domain: string;
  version: string;
  label?: string;
  emoji?: string;
  summary?: string;
  prerequisites?: string[];
  size: number;
  runtimeDownloadSize?: number;
  runtimeInstalledSize?: number;
  installation?: InstallationFootprint;
  updateAvailable?: boolean;
  platforms: string[];
}
export interface DomainInstallationStatus {
  managed: boolean;
  catalogWarning?: string;
  catalog?: {
    state: 'unconfigured' | 'not-checked' | 'connected' | 'unavailable';
    bundledDomains: number;
    compatibleDomains?: number;
    message?: string;
    unavailableDomains?: Array<{
      domain: string;
      label: string;
      emoji?: string;
      summary?: string;
      prerequisites?: string[];
      version?: string;
      reason: 'not-distributed' | 'platform-unsupported' | 'catalog-unavailable';
    }>;
  };
  operation?: {
    active: boolean;
    progress: DomainInstallProgress | null;
    source?: 'desktop' | 'external';
    cancellable?: boolean;
  } | null;
  lastOperation?: {
    operation?: 'install' | 'remove';
    outcome: 'completed' | 'cancelled' | 'failed' | 'interrupted';
    finishedAt: string;
    error?: string;
    statusWarning?: string;
  } | null;
  installed: InstalledDomainPack[];
  errors: Array<{ domain: string; version: string; message: string }>;
}
export interface DomainOption {
  id: string;
  label: string;
  emoji: string;
}
export interface CoreUpdateState {
  status:
    | 'development'
    | 'unconfigured'
    | 'idle'
    | 'checking'
    | 'current'
    | 'available'
    | 'downloading'
    | 'ready'
    | 'error';
  version: string | null;
  progress: number | null;
  error: string | null;
}
export interface ResourceCatalog {
  skills: Array<{ id: string; domain: string; title: string; enabledByDefault: boolean }>;
  mcpServers: Array<{ id: string; domain: string; title: string; enabledByDefault: boolean }>;
}

export type ResourceMode = 'inherit' | 'enabled' | 'disabled';
export interface ExternalMcpSummary {
  id: string;
  title: string;
  domain: 'all';
  transport: 'stdio' | 'http' | 'sse';
  toolCount: number;
  checkedAt: string;
  enabledByDefault: boolean;
  external: true;
}
export interface ResourceSettingsSnapshot {
  catalog: ResourceCatalog;
  global: { skills: string[]; mcpServers: string[] };
  overrides: { skills: Record<string, boolean>; mcpServers: Record<string, boolean> };
  effective: { skills: string[]; mcpServers: string[] };
}

export type SubagentState = {
  type: 'subagent-state';
  id: string;
  agentId: string;
  parentToolCallId: string;
  subagentType: string;
  description: string;
  background: boolean;
  status: 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
  summary?: string;
};
export interface ResultArtifactRef {
  id: string;
  actionId: string;
  relativePath: string;
  kind: string;
  sha256: string;
  sizeBytes: number;
}
export interface ResultOpenRequest {
  chatId: string;
  turnId: string;
  artifactId: string;
  groupId?: string;
  actionId?: string;
  previewOnly?: boolean;
  revealOnly?: boolean;
}
export interface TaskResultView {
  schemaVersion: '1';
  projectId: string;
  chatId: string;
  turnId: string;
  revision: number;
  phase: 'running' | 'background' | 'settled';
  requestStatus: string;
  executionStatus: string;
  diagnostics?: string[];
  actionIds: string[];
  selection: { groupIds: string[]; historical: boolean; basedOnRevision: number } | null;
  groups: Array<{
    id: string;
    actionId: string;
    title: string;
    primaryArtifactId: string;
    previewArtifactId?: string;
    superseded: boolean;
    historical: boolean;
    selected: boolean;
    executionStatus: string;
    contentStatus: 'recorded' | 'changed' | 'unavailable' | 'unchecked';
    artifacts: ResultArtifactRef[];
    verifications: Array<{
      id: string;
      status: 'passed' | 'failed' | 'not_run' | 'insufficient_evidence';
      reason: string;
    }>;
  }>;
}

export type AgentEvent = {
  /** Host receipt time for display; absent on older persisted events. */
  recordedAt?: string;
  chatId?: string;
  projectId?: string;
  turnId?: string;
  eventRevision?: number;
  agentId?: string;
  background?: boolean;
} & (
  | { type: 'results-changed'; eventId: string; results: TaskResultView }
  | {
      type: 'results-ready';
      eventId: string;
      results: TaskResultView;
      autoPreviewEligible: boolean;
    }
  | { type: 'user-images'; images: PromptImage[] }
  | { type: 'input-images'; images: PromptImage[] }
  | { type: 'context-reset'; message: string }
  | { type: 'diagnostic-log'; traceId: string; path: string }
  | { type: 'background-state'; running: boolean }
  | SubagentState
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'approval';
      id: string;
      description: string;
      action: string;
      agentId?: string;
      preview?: {
        title: string;
        text: string;
        truncated: boolean;
        stateId: string;
        requestSha256: string;
      };
    }
  | {
      type: 'approval-resolved';
      id: string;
      decision: 'approve' | 'approve_for_session' | 'reject' | 'expired';
    }
  | {
      type: 'question';
      agentId?: string;
      id: string;
      toolCallId: string;
      questions: Array<{
        question: string;
        header?: string;
        options: Array<{ label: string; description?: string }>;
        multi_select?: boolean;
      }>;
    }
  | {
      type: 'question-resolved';
      id: string;
      decision: 'answered' | 'skipped' | 'expired';
      answers?: Record<string, string>;
    }
  | { type: 'tool'; id: string; name: string; arguments: string }
  | {
      type: 'tool-result';
      id: string;
      error: boolean;
      message: string;
      output: string;
      outputBytes?: number;
      outputTruncated?: boolean;
      imageCount?: number;
    }
  | { type: 'todo'; items: Array<{ title: string; status: 'pending' | 'in_progress' | 'done' }> }
  | {
      type: 'status';
      contextUsage: number | null;
      tokenUsage: {
        input_other: number;
        output: number;
        input_cache_read: number;
        input_cache_creation: number;
      } | null;
    }
  | { type: 'compaction'; state: 'begin' | 'end' }
  | {
      type: 'context-metrics';
      peakContextUsage: number | null;
      lastContextUsage: number | null;
      compactions: number;
      toolResults: number;
      peakToolResultBytes: number;
    }
  | { type: 'step'; number: number }
  | { type: 'done'; result: { status: string } }
  | { type: 'error'; message: string }
  | {
      type: 'execution-boundary';
      platform: string;
      projectWritable: boolean;
      mechanism: string;
    }
  | {
      type: 'resources-filtered';
      externalMcp: string[];
      plugins: string[];
    }
  | {
      type: 'industrial-result';
      action: { id: string; status: string };
      artifacts?: ResultArtifactRef[];
      verification: {
        evidence?: { artifactIds: string[] };
        status: 'not_run' | 'passed' | 'failed' | 'insufficient_evidence';
        reason: string;
      };
      state: { id: string; status: 'unverified' | 'verified' | 'failed' | 'stale' };
      checkpoint: { id: string };
    }
);

export interface PromptImage {
  id: string;
  name: string;
  dataUrl: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
  sha256?: string;
}

export interface ModelProfile {
  provider: 'kimi' | 'openai_legacy';
  endpoint: string;
  model: string;
  contextSize: number;
  thinking: boolean;
  imageInput: boolean;
  imageInputMode: 'auto' | 'enabled' | 'disabled';
}
export interface ModelProfileStatus extends ModelProfile {
  hasApiKey: boolean;
  keyPersisted: boolean;
}

export interface BrokerResult {
  chatId?: string;
  turnId?: string;
  scope: {
    version: string;
    domain: string | null;
    stage: string | null;
    capabilityIds: string[];
    skills: string[];
    tools: string[];
  };
  matches: Array<{ id: string; title: string }>;
  contexts: Array<{ domain: string; stage: string }>;
  trace: Array<{ level: string; event: string; detail: unknown }>;
}

export interface CapabilityDetail {
  capability: string;
  skills: Array<{ id: string; summary: string; reference: string }>;
  tools: Array<{ id: string; summary: string; schema: Record<string, string> }>;
  verification: string[];
}

declare global {
  interface Window {
    viewerHost?: ViewerHostApi;
  }
}

export type DiagnosticCategory = 'tools' | 'context' | 'thinking' | 'approvals' | 'run' | 'ui';
export interface DiagnosticRun {
  runId: string;
  traceId: string;
  at: string;
  sizeBytes: number | null;
  model: string | null;
  status: string | null;
  metrics: {
    peakContextUsage: number | null;
    compactions: number | null;
    toolResults: number | null;
  } | null;
  error?: string;
}
export interface DiagnosticRecord {
  sequence: number;
  at: string;
  type: string;
  event: string | null;
  category: DiagnosticCategory;
  summary: string;
  bytes: number;
}
export interface DiagnosticPage {
  records: DiagnosticRecord[];
  nextOffset: number | null;
  total: number;
  totalRecords: number;
  counts: Record<DiagnosticCategory, number>;
  pending: boolean;
}
export interface DiagnosticContent {
  text: string;
  offset: number;
  nextOffset: number | null;
  totalBytes: number;
}

export interface SessionStatus {
  backgroundTasks?: boolean;
  chatId: string;
  projectId: string;
  running: boolean;
  awaitingApproval: boolean;
  awaitingQuestion?: boolean;
}
export interface ChatSummary {
  id: string;
  approvalMode: 'ask' | 'auto';
  running?: boolean;
  awaitingApproval?: boolean;
  awaitingQuestion?: boolean;
  title: string;
  domain: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}
export interface ChatTurn {
  id: string;
  task: string;
  broker: BrokerResult | null;
  status: string;
  createdAt: string;
  events: AgentEvent[];
}
export interface ChatHistory {
  eventRevision?: number;
  agentId?: string;
  background?: boolean;
  executing?: boolean;
  chat: ChatSummary;
  turns: ChatTurn[];
  hasMore: boolean;
  before: string | null;
}

export type DiagnosticView = 'timeline' | 'context' | 'tools';
export interface DiagnosticField {
  key: string;
  label: string;
  open: boolean;
  bytes: number;
}
export interface DiagnosticEntry {
  id: string;
  kind: string;
  title: string;
  at: string;
  sequences: number[];
  summary: string;
  fields: DiagnosticField[];
  stepId?: string | null;
  contextId?: string;
  callId?: string;
  status?: string;
  durationMs?: number;
  number?: number;
  usage?: Record<string, number> | null;
  contextUsage?: number | null;
  note?: string;
}
export interface DiagnosticViewPage {
  entries: DiagnosticEntry[];
  nextOffset: number | null;
  total: number;
  totalRecords: number;
  counts: Record<DiagnosticView, number>;
}

export interface RemoteServiceState {
  status: 'not_configured' | 'credentials_missing' | 'unchecked' | 'connected' | 'unavailable';
  domains: string[];
}
export interface RemoteTaskState {
  requestId: string;
  jobId: string | null;
  status: string;
  queuePosition: number | null;
}
export interface RemoteProjectState {
  location: 'local' | 'remote';
  files: string[];
  syncedAt: string | null;
  service: RemoteServiceState;
  task: RemoteTaskState | null;
}
export interface RemoteSyncReview {
  id: string;
  destination: string;
  files: Array<{ path: string; sizeBytes: number }>;
  totalBytes: number;
}
