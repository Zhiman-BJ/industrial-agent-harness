import type { InstalledDomainPack } from '@industrial-agent-harness/viewer-builtin/api';

export function domainPreparationState(item: InstalledDomainPack): {
  runtimeRepair: boolean;
  runtimeReady: boolean;
  viewerState: InstalledDomainPack['viewerState'];
};
export function viewerDependencyMessage(error: unknown): string | undefined;
