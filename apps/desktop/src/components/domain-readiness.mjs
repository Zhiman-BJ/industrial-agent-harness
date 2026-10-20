// Keep the two installed-domain surfaces on the same display/action policy.
// Native runtime prerequisites and read-only viewer dependencies are independent.
export function domainPreparationState(item) {
  const viewerState = item.viewerAssets?.length
    ? item.viewerAssets.every(asset => asset.ready)
      ? 'ready'
      : 'needs-preparation'
    : item.viewerState;
  return {
    runtimeRepair: ['ready', 'needs-preparation'].includes(item.runtimeState),
    runtimeReady: item.runtimeState === 'ready',
    viewerState,
  };
}

const dependencyMessages = [
  'Layout viewer needs preparation. Open Settings → Domains, then choose Prepare / repair viewers.',
  'KLAYOUT_PYTHON cannot run the required KLayout Python modules. Correct the override and reopen the layout.',
];

// Electron decorates rejected IPC errors. Recover the known message key so the
// renderer can translate it without translating arbitrary diagnostic output.
export function viewerDependencyMessage(error) {
  return dependencyMessages.find(message => String(error).includes(message));
}
