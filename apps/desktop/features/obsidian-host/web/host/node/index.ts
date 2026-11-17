// The Node surface of the plugin host. See ../README.md ("Node surface").
export { createNodeRegistry, NODE_MODULE_IDS } from "./registry";
export type { NodeRegistry, NodeRegistryContext } from "./registry";
export { installNodeGlobals, preloadNodeRuntime } from "./runtime";
export type { PreloadOptions } from "./runtime";
export { registerSyncProbePaths, primeSyncFileContents } from "./fs";
export { setOpenExternal } from "./misc";
export { pluginIdFromStack } from "./child-process";
export { getSharedProcess, createProcessShim } from "./process";
export { setNodeIpc, resetNodeRuntimeForTests } from "./state";
export { tauriNodeIpc } from "./ipc";
export type { NodeIpc, NodeOsInfo, ProcEvent, ProcSpawnRequest, FsProbe } from "./ipc";
export { pathModule as pathShim } from "./path";
