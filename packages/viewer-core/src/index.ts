/** Stable identities supplied by the artifact registry, never renderer file paths. */
export interface ViewerArtifactRef {
  projectId: string;
  artifactId: string;
  artifactType: string;
  contentHash: string;
  source: {kind: 'state'; stateId: string} | {kind: 'run'; runId: string};
}

export type ViewerMode = 'embedded' | 'artifact-preview' | 'external-app';
export type ViewerPlatform = 'linux' | 'darwin' | 'win32';

/** Discovery metadata. Availability is checked on the current host at open time. */
export interface ViewerDescriptor {
  id: string;
  artifactTypes: readonly string[];
  modes: readonly ViewerMode[];
  platforms: readonly ViewerPlatform[];
  companionTypes?: readonly string[];
  maxInputBytes?: number;
}

export interface ViewerOpenRequest {
  viewerId: string;
  mode: ViewerMode;
  artifact: ViewerArtifactRef;
  companions?: readonly ViewerArtifactRef[];
  options?: Readonly<Record<string, string | number | boolean>>;
}

export type ViewerStatus =
  | 'loading'
  | 'rendered'
  | 'launched'
  | 'unavailable'
  | 'unsupported'
  | 'missing-companion'
  | 'resource-limit'
  | 'render-failed'
  | 'launch-failed';

/** Display-only provenance. Never an Action result or Verification result. */
export interface ViewerDisplayProvenance {
  sourceArtifacts: readonly ViewerArtifactRef[];
  rendererId: string;
  rendererVersion: string;
  optionsHash: string;
  outputHash?: string;
}

export interface ViewerOpenResult {
  status: ViewerStatus;
  provenance?: ViewerDisplayProvenance;
  displayHandle?: string;
  error?: string;
}
