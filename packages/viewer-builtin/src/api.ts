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
  resolve(request: {domain: string; stage: string; task: string}): Promise<BrokerResult>;
  detail(capabilityId: string): Promise<CapabilityDetail>;
  brokerTrace(): Promise<BrokerResult['trace']>;
  agentStatus(): Promise<{available: boolean; version: string; projectDir: string | null}>;
  chooseProject(): Promise<string | null>;
  projectFiles(): Promise<Array<{path: string; name: string; depth: number; directory: boolean}>>;
  openProjectFile(relative: string): Promise<ViewerArtifact>;
  runAgent(task: string): Promise<{started: boolean}>;
  approveAgent(id: string, response: 'approve' | 'approve_for_session' | 'reject'): Promise<void>;
  interruptAgent(): Promise<void>;
  onAgentEvent(callback: (event: AgentEvent) => void): () => void;
}

export type AgentEvent =
  | {type: 'text'; text: string}
  | {type: 'approval'; id: string; description: string; action: string}
  | {type: 'tool'; name: string}
  | {type: 'tool-result'; error: boolean; message: string}
  | {type: 'step'; number: number}
  | {type: 'done'; result: {status: string}}
  | {type: 'error'; message: string};

export interface BrokerResult {
  scope: {version: string; domain: string; stage: string; capabilityIds: string[]; skills: string[]; tools: string[]};
  matches: Array<{id: string; title: string}>;
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
