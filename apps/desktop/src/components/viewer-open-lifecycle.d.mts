export type ViewerOpenLifecycle<View> = {
  settled: Promise<void>;
  commit(view: View): void;
  cancel(): void;
};

export function openViewerLifecycle<View>(
  host: {
    open(request: { artifactId: string }): Promise<View>;
    releaseViewerResources?(request: { token: string }): unknown;
  },
  request: { artifactId: string },
  callbacks: {
    onOpened(view: View): void;
    onError(reason: unknown): void;
  },
): ViewerOpenLifecycle<View>;
