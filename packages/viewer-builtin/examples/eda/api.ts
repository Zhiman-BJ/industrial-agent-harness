// Minimal host contract extracted from the Silicon Lens viewer integration.
// The new desktop Viewer Host will replace replayApi with artifact-bound calls.
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

interface ExampleViewerApi {
  render(request: {token: string; box: number[]; width: number; height: number; visible: string[]; quality: string; theme?: string}): Promise<{png: string; box: number[]}>;
  netlist(request: {token: string; module: string; focus?: string}): Promise<NetlistData>;
}

declare global {
  interface Window {
    replayApi?: ExampleViewerApi;
  }
}
