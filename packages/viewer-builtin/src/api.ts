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
  kind: 'layout' | 'netlist' | 'waveform';
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

export type OpenedViewer =
  | {kind: 'layout'; artifact: ViewerArtifact; data: LayoutMeta}
  | {kind: 'netlist'; artifact: ViewerArtifact; data: NetlistData}
  | {kind: 'waveform'; artifact: ViewerArtifact; data: WaveformData};

export interface ViewerHostApi {
  open(request: {artifactId: string}): Promise<OpenedViewer>;
  render(request: {token: string; box: number[]; width: number; height: number; visible: string[]; quality: string; theme?: string}): Promise<{png: string; box: number[]}>;
  netlist(request: {token: string; module: string; focus?: string}): Promise<NetlistData>;
  resolve(request: {task: string; artifactKind?: string; domain?: string; stage?: string}): Promise<BrokerResult>;
  domains(): Promise<DomainOption[]>;
  resourceCatalog(): Promise<ResourceCatalog>;
  detail(capabilityId: string): Promise<CapabilityDetail>;
  brokerTrace(): Promise<BrokerResult['trace']>;
  agentStatus(): Promise<{available: boolean; version: string; projectDir: string | null; configured: boolean}>;
  modelGet(): Promise<ModelProfileStatus>;
  modelSave(request: ModelProfile & {apiKey?: string; clearApiKey?: boolean}): Promise<ModelProfileStatus>;
  chooseProjectDirectory(): Promise<string | null>;
  createProject(request: {directory: string; name: string; domain: string}): Promise<{projects: ProjectBinding[]; activeId: string | null; projectDir: string | null}>;
  projectBindings(): Promise<{projects: ProjectBinding[]; activeId: string | null; projectDir: string | null}>;
  selectProject(id: string): Promise<{projects: ProjectBinding[]; activeId: string | null; projectDir: string | null}>;
  setProjectDomain(id: string, domain: string): Promise<{projects: ProjectBinding[]; activeId: string | null; projectDir: string | null}>;
  setProjectResource(projectId: string, kind: 'skill' | 'mcp', id: string, enabled: boolean): Promise<{projects: ProjectBinding[]; activeId: string | null; projectDir: string | null}>;
  newChat(): Promise<void>;
  projectFiles(): Promise<Array<{path: string; name: string; depth: number; directory: boolean}>>;
  readProjectFile(relative: string): Promise<{path: string; name: string; sizeBytes: number; viewer: 'layout' | 'netlist' | 'waveform' | null; content: string | null; truncated: boolean}>;
  openProjectFile(relative: string): Promise<ViewerArtifact>;
  runAgent(task: string): Promise<{started: boolean}>;
  approveAgent(id: string, response: 'approve' | 'approve_for_session' | 'reject'): Promise<void>;
  interruptAgent(): Promise<void>;
  onAgentEvent(callback: (event: AgentEvent) => void): () => void;
}

export interface ProjectBinding {id: string; name: string; path: string; domain?: string | null; disabledSkills?: string[]; disabledMcpServers?: string[]}
export interface DomainOption {id: string; label: string; emoji: string}
export interface ResourceCatalog {skills: Array<{id: string; domain: string; title: string; enabledByDefault: boolean}>; mcpServers: Array<{id: string; domain: string; title: string; enabledByDefault: boolean}>}

export type AgentEvent =
  | {type: 'text'; text: string}
  | {type: 'thinking'; text: string}
  | {type: 'approval'; id: string; description: string; action: string}
  | {type: 'tool'; id: string; name: string; arguments: string}
  | {type: 'tool-result'; id: string; error: boolean; message: string; output: string}
  | {type: 'todo'; items: Array<{title: string; status: 'pending' | 'in_progress' | 'done'}>}
  | {type: 'status'; contextUsage: number | null; tokenUsage: {input_other: number; output: number; input_cache_read: number; input_cache_creation: number} | null}
  | {type: 'compaction'; state: 'begin' | 'end'}
  | {type: 'step'; number: number}
  | {type: 'done'; result: {status: string}}
  | {type: 'error'; message: string};

export interface ModelProfile {provider: 'kimi' | 'openai_legacy'; endpoint: string; model: string; contextSize: number; thinking: boolean}
export interface ModelProfileStatus extends ModelProfile {hasApiKey: boolean; keyPersisted: boolean}

export interface BrokerResult {
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
