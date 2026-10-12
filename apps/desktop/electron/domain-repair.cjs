// The legacy IPC must never infer that every runtime asset in a v2 Pack should
// be prepared. V2 preparation requires an explicitly chosen environment profile.
function domainRepairHandler({ manager, isManaged, repairLegacy }) {
  return async (event, request) => {
    if (!isManaged() || typeof request?.domain !== 'string') throw Error('Invalid Domain repair.');
    const bundle = manager.list().find(item => item.domain === request.domain);
    if (!bundle) throw Error('Domain is not installed.');
    if (Array.isArray(bundle.executionProfiles))
      throw Error(
        'Choose an execution profile in Execution environments. Use Detect environment to check it or Prepare managed environment explicitly.',
      );
    return repairLegacy(event, request);
  };
}
module.exports = { domainRepairHandler };
