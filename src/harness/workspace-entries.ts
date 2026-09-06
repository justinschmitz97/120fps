// The workspace answers live beside module resolution, in project/; this file keeps the name
// the harness imports them by. Preflight and the compiler options read the same five functions.
export {
  declaredRuntimeEntries,
  declaresRuntimeEntry,
  isWorkspaceSibling,
  resolveWorkspaceSourceEntry,
  workspaceSubpathSourceEntries,
} from "../project/index.js";
