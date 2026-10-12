// Compatibility IPC rejects every vendor-software preparation request.
function domainRepairHandler({ manager, isManaged }) {
  return async (_event, request) => {
    if (!isManaged() || typeof request?.domain !== 'string') throw Error('Invalid Domain repair.');
    if (!manager.list().some(item => item.domain === request.domain))
      throw Error('Domain is not installed.');
    throw Error(
      'Install missing software from its official source, then detect and save its location.',
    );
  };
}
module.exports = { domainRepairHandler };
