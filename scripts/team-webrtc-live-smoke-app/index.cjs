const { app } = require("electron");

void import("../team-webrtc-live-smoke.mjs").catch((error) => {
  console.error(error);
  app.exit(1);
});
