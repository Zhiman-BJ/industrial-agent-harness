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
  source: 'reference fixture' | 'user selected file';
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
  list(): Promise<ViewerArtifact[]>;
  choose(): Promise<ViewerArtifact | null>;
  open(request: {artifactId: string}): Promise<OpenedViewer>;
  render(request: {token: string; box: number[]; width: number; height: number; visible: string[]; quality: string; theme?: string}): Promise<{png: string; box: number[]}>;
  netlist(request: {token: string; module: string; focus?: string}): Promise<NetlistData>;
  resolve(request: {task: string; artifactKind?: string; domain?: string; stage?: string}): Promise<BrokerResult>;
  detail(capabilityId: string): Promise<CapabilityDetail>;
  brokerTrace(): Promise<BrokerResult['trace']>;
  agentStatus(): Promise<{available: boolean; version: string; projectDir: string | null; configured: boolean}>;
  modelGet(): Promise<ModelProfileStatus>;
  modelSave(request: ModelProfile & {apiKey?: string; clearApiKey?: boolean}): Promise<ModelProfileStatus>;
  chooseProject(): Promise<string | null>;
  projectBindings(): Promise<{projects: Array<{id: string; name: string; path: string}>; activeId: string | null; projectDir: string | null}>;
  selectProject(id: string): Promise<{projects: Array<{id: string; name: string; path: string}>; activeId: string | null; projectDir: string | null}>;
  newChat(): Promise<void>;
  projectFiles(): Promise<Array<{path: string; name: string; depth: number; directory: boolean}>>;
  readProjectFile(relative: string): Promise<{path: string; name: string; sizeBytes: number; viewer: 'layout' | 'netlist' | 'waveform' | null; content: string | null; truncated: boolean}>;
  openProjectFile(relative: string): Promise<ViewerArtifact>;
  runAgent(task: string): Promise<{started: boolean}>;
  approveAgent(id: string, response: 'approve' | 'approve_for_session' | 'reject'): Promise<void>;
  interruptAgent(): Promise<void>;
  onAgentEvent(callback: (event: AgentEvent) => void): () => void;
}

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
