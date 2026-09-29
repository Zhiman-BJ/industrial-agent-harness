export interface LayoutMeta {
  token: string;
  cell: string;
  bbox: number[];
  layers: Array<{key: string; name: string}>;
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
  nets: Array<{name: string; bits: Array<number | string>}>;
  cells: Array<{name: string; type: string}>;
  elapsed_ms: number;
}

export interface ViewerArtifact {
  id: string;
  kind: 'layout' | 'netlist' | 'waveform' | 'godot' | 'kicad' | 'image' | 'sprite' | 'animation' | DocumentKind;
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

export interface GodotNode {path: string; name: string; class: string; children: GodotNode[]}
export interface GodotState {scene: string; tree: GodotNode | null; paused: boolean; selectedPath: string; overlays: {collision: boolean; navmesh: boolean; physics: boolean}}
export interface GodotData {token: string; name: string; url: string}
export interface KiCadData {token: string; name: string; document: 'board' | 'schematic'; url: string}
export interface AssetImage {name: string; url: string; width: number; height: number; sha256: string}
export interface SpriteFrame {image: number; rect: [number, number, number, number]; duration: number}
export interface SpriteAnimation {name: string; loop: boolean; frames: SpriteFrame[]}
export interface AssetData {name: string; images: AssetImage[]; columns: number; rows: number; animations: SpriteAnimation[]; initialMode: 'image' | 'sprite' | 'animation'}
export type DocumentKind = 'table' | 'json' | 'jsonl' | 'markdown' | 'text';
export interface DocumentData {text: string; rows?: string[][]; columns?: number; ragged?: boolean; records?: number; error?: string; warning?: string}

export type OpenedViewer =
  | {kind: 'layout'; artifact: ViewerArtifact; data: LayoutMeta}
  | {kind: 'netlist'; artifact: ViewerArtifact; data: NetlistData}
  | {kind: 'waveform'; artifact: ViewerArtifact; data: WaveformData}
  | {kind: 'godot'; artifact: ViewerArtifact; data: GodotData}
  | {kind: 'kicad'; artifact: ViewerArtifact; data: KiCadData}
  | {kind: 'image' | 'sprite' | 'animation'; artifact: ViewerArtifact; data: AssetData}
  | {kind: DocumentKind; artifact: ViewerArtifact; data: DocumentData};

export interface ViewerHostApi {
  open(request: {artifactId: string}): Promise<OpenedViewer>;
  render(request: {token: string; box: number[]; width: number; height: number; visible: string[]; quality: string; theme?: string}): Promise<{png: string; box: number[]}>;
  netlist(request: {token: string; module: string; focus?: string}): Promise<NetlistData>;
  resolve(request: {task: string; chatId?: string; artifactKind?: string; domain?: string; stage?: string}): Promise<BrokerResult>;
  domains(): Promise<DomainOption[]>;
  resourceGet(request: {projectId?: string}): Promise<ResourceSettingsSnapshot>;
  resourceSet(request: {projectId?: string; kind: 'skill' | 'mcp'; id: string; mode: ResourceMode}): Promise<ResourceSettingsSnapshot>;
  resourceCatalog(): Promise<ResourceCatalog>;
  detail(capabilityId: string): Promise<CapabilityDetail>;
  brokerTrace(): Promise<BrokerResult['trace']>;
  diagnosticRuns(request: {projectId: string}): Promise<{runs: DiagnosticRun[]; limited: boolean}>;
  diagnosticPage(request: {projectId: string; runId: string; offset?: number; category?: DiagnosticCategory | 'all'; query?: string}): Promise<DiagnosticPage>;
  diagnosticView(request: {projectId: string; runId: string; view: DiagnosticView; offset?: number; query?: string}): Promise<DiagnosticViewPage>;
  diagnosticDetail(request: {projectId: string; runId: string; id: string; field: string; offset?: number}): Promise<DiagnosticContent>;
  diagnosticRecord(request: {projectId: string; runId: string; sequence: number; offset?: number}): Promise<DiagnosticContent>;
  agentStatus(): Promise<{available: boolean; version: string; projectDir: string | null; configured: boolean; gui?: GuiPluginState}>;
  guiState(): Promise<GuiPluginState>;
  setGuiPlugin(enabled: boolean): Promise<GuiPluginState>;
  onGuiProgress(callback: (event: {phase: string; tag?: string; cached?: boolean; error?: string}) => void): () => void;
  modelGet(): Promise<ModelProfileStatus>;
  modelSave(request: ModelProfile & {apiKey?: string; clearApiKey?: boolean}): Promise<ModelProfileStatus>;
  chooseProjectDirectory(): Promise<string | null>;
  createProject(request: {directory: string; name: string; domain: string}): Promise<{projects: ProjectBinding[]; activeId: string | null; projectDir: string | null}>;
  projectBindings(): Promise<{projects: ProjectBinding[]; activeId: string | null; projectDir: string | null}>;
  selectProject(id: string): Promise<{projects: ProjectBinding[]; activeId: string | null; projectDir: string | null}>;
  setProjectDomain(id: string, domain: string): Promise<{projects: ProjectBinding[]; activeId: string | null; projectDir: string | null}>;
  setProjectResource(projectId: string, kind: 'skill' | 'mcp', id: string, enabled: boolean): Promise<{projects: ProjectBinding[]; activeId: string | null; projectDir: string | null}>;
  chats(): Promise<{chats: ChatSummary[]; activeId: string | null; sessions: SessionStatus[]}>;
  chatHistory(request: {id: string; before?: string | null}): Promise<ChatHistory>;
  selectChat(id: string): Promise<ChatHistory>;
  deleteChat(id: string): Promise<{chats: ChatSummary[]; activeId: string | null; sessions: SessionStatus[]}>;
  onChatUpdated(callback: () => void): () => void;
  newChat(): Promise<ChatHistory>;
  projectFiles(): Promise<Array<{path: string; name: string; depth: number; directory: boolean}>>;
  readProjectFile(relative: string): Promise<{path: string; name: string; sizeBytes: number; viewer: ViewerArtifact['kind'] | null; content: string | null; truncated: boolean}>;
  openProjectFile(relative: string): Promise<ViewerArtifact>;
  validateImages(request: {projectId: string; images: PromptImage[]}): Promise<PromptImage[]>;
  runAgent(task: string | {task: string; chatId?: string; projectId?: string; images?: PromptImage[]}, chatId?: string): Promise<{started: boolean}>;
  approveAgent(id: string, response: 'approve' | 'approve_for_session' | 'reject', chatId?: string): Promise<void>;
  interruptAgent(chatId?: string): Promise<void>;
  onAgentEvent(callback: (event: AgentEvent) => void): () => void;
}

export interface ProjectBinding {id: string; name: string; path: string; domain?: string | null; disabledSkills?: string[]; disabledMcpServers?: string[]}
export interface GuiPluginState {enabled: boolean; install: 'missing' | 'ready' | string; version: string | null}
export interface DomainOption {id: string; label: string; emoji: string}
export interface ResourceCatalog {skills: Array<{id: string; domain: string; title: string; enabledByDefault: boolean}>; mcpServers: Array<{id: string; domain: string; title: string; enabledByDefault: boolean}>}

export type ResourceMode = 'inherit' | 'enabled' | 'disabled';
export interface ResourceSettingsSnapshot {catalog: ResourceCatalog; global: {skills: string[]; mcpServers: string[]}; overrides: {skills: Record<string, boolean>; mcpServers: Record<string, boolean>}; effective: {skills: string[]; mcpServers: string[]}}

export type AgentEvent = ({chatId?: string; projectId?: string; turnId?: string} & (
  | {type: 'user-images'; images: PromptImage[]}
  | {type: 'input-images'; images: PromptImage[]}
  | {type: 'context-reset'; message: string}
  | {type: 'diagnostic-log'; traceId: string; path: string}
  | {type: 'text'; text: string}
  | {type: 'thinking'; text: string}
  | {type: 'approval'; id: string; description: string; action: string}
  | {type: 'approval-resolved'; id: string; decision: 'approve' | 'approve_for_session' | 'reject' | 'expired'}
  | {type: 'tool'; id: string; name: string; arguments: string}
  | {type: 'tool-result'; id: string; error: boolean; message: string; output: string; outputBytes?: number; outputTruncated?: boolean; imageCount?: number}
  | {type: 'todo'; items: Array<{title: string; status: 'pending' | 'in_progress' | 'done'}>}
  | {type: 'status'; contextUsage: number | null; tokenUsage: {input_other: number; output: number; input_cache_read: number; input_cache_creation: number} | null}
  | {type: 'compaction'; state: 'begin' | 'end'}
  | {type: 'context-metrics'; peakContextUsage: number | null; lastContextUsage: number | null; compactions: number; toolResults: number; peakToolResultBytes: number}
  | {type: 'step'; number: number}
  | {type: 'done'; result: {status: string}}
  | {type: 'error'; message: string}));

export interface PromptImage {id: string; name: string; dataUrl: string; width?: number; height?: number; sizeBytes?: number; sha256?: string}

export interface ModelProfile {provider: 'kimi' | 'openai_legacy'; endpoint: string; model: string; contextSize: number; thinking: boolean; imageInput: boolean; imageInputMode: 'auto' | 'enabled' | 'disabled'}
export interface ModelProfileStatus extends ModelProfile {hasApiKey: boolean; keyPersisted: boolean}

export interface BrokerResult {
  chatId?: string;
  turnId?: string;
  scope: {version: string; domain: string | null; stage: string | null; capabilityIds: string[]; skills: string[]; tools: string[]};
  matches: Array<{id: string; title: string}>;
  contexts: Array<{domain: string; stage: string}>;
  trace: Array<{level: string; event: string; detail: unknown}>;
}

export interface CapabilityDetail {
  capability: string;
  skills: Array<{id: string; summary: string; reference: string}>;
  tools: Array<{id: string; summary: string; schema: Record<string, string>}>;
  verification: string[];
}

declare global {
  interface Window {viewerHost?: ViewerHostApi}
}

export type DiagnosticCategory = 'tools' | 'context' | 'thinking' | 'approvals' | 'run' | 'ui';
export interface DiagnosticRun {runId: string; traceId: string; at: string; sizeBytes: number | null; model: string | null; status: string | null; metrics: {peakContextUsage: number | null; compactions: number | null; toolResults: number | null} | null; error?: string}
export interface DiagnosticRecord {sequence: number; at: string; type: string; event: string | null; category: DiagnosticCategory; summary: string; bytes: number}
export interface DiagnosticPage {records: DiagnosticRecord[]; nextOffset: number | null; total: number; totalRecords: number; counts: Record<DiagnosticCategory, number>; pending: boolean}
export interface DiagnosticContent {text: string; offset: number; nextOffset: number | null; totalBytes: number}

export interface SessionStatus {chatId: string; projectId: string; running: boolean; awaitingApproval: boolean}
export interface ChatSummary {id: string; running?: boolean; awaitingApproval?: boolean; title: string; domain: string; createdAt: string; updatedAt: string; archived: boolean}
export interface ChatTurn {id: string; task: string; broker: BrokerResult | null; status: string; createdAt: string; events: AgentEvent[]}
export interface ChatHistory {executing?: boolean; chat: ChatSummary; turns: ChatTurn[]; hasMore: boolean; before: string | null}

export type DiagnosticView = 'timeline' | 'context' | 'tools';
export interface DiagnosticField {key: string; label: string; open: boolean; bytes: number}
export interface DiagnosticEntry {id: string; kind: string; title: string; at: string; sequences: number[]; summary: string; fields: DiagnosticField[]; stepId?: string | null; contextId?: string; callId?: string; status?: string; durationMs?: number; number?: number; usage?: Record<string, number> | null; contextUsage?: number | null; note?: string}
export interface DiagnosticViewPage {entries: DiagnosticEntry[]; nextOffset: number | null; total: number; totalRecords: number; counts: Record<DiagnosticView, number>}
