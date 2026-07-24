// Stand-in for a workspace-built architecture blueprint package. The
// integration test symlinks this folder into node_modules/@sheriff-test/
// so that `sheriff verify --verbose` can prove the config import
// provenance points at the workspace build, not at node_modules.
module.exports.blueprintDepRules = {
  '*': '*',
  root: '*',
};
