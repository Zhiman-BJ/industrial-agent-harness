// ProjectBinding is the persisted directory/domain identity. Execution location
// belongs to RemoteSettings; only UI snapshots project it onto a display object.
function projectRegistryOptions(project, remoteSettings) {
  return {
    projectDir: project?.path,
    remote: Boolean(
      project?.path &&
        project?.domain &&
        remoteSettings.project(project.path, project.domain).location === 'remote',
    ),
  };
}
module.exports = { projectRegistryOptions };
