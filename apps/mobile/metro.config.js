const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");
const { withUniwindConfig } = require("uniwind/metro");

const config = getDefaultConfig(__dirname);
const nativeModuleShims = new Map([
  ["@solidjs/web", path.resolve(__dirname, "src/shims/solidjs-web.ts")],
  ["solid-js", path.resolve(__dirname, "src/shims/solid-js.ts")],
]);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const shim = nativeModuleShims.get(moduleName);
  if (shim) return { filePath: shim, type: "sourceFile" };
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = withUniwindConfig(config, {
  cssEntryFile: "./global.css",
  dtsFile: "./src/uniwind-types.d.ts",
});
