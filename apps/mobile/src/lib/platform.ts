export const platform = process.env.EXPO_OS ?? "unknown";

export const isIOS = platform === "ios";
export const isAndroid = platform === "android";
export const isWeb = platform === "web";
