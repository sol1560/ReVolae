const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
const appRoot = __dirname;
const repoRoot = path.resolve(appRoot, "../..");
const config = getDefaultConfig(appRoot);
config.watchFolders = [repoRoot];
config.resolver.nodeModulesPaths = [path.join(appRoot, "node_modules"), path.join(repoRoot, "node_modules")];
config.resolver.unstable_enablePackageExports = true;
const defaultResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = defaultResolve || context.resolveRequest;
  try {
    return resolve(context, moduleName, platform);
  } catch (error) {
    if (moduleName.startsWith(".") && moduleName.endsWith(".js")) return resolve(context, moduleName.slice(0, -3) + ".ts", platform);
    throw error;
  }
};
module.exports = config;
