import startHandler from "@tanstack/solid-start/server-entry";
import { createWorkerHandler } from "./server/worker-handler";

export default createWorkerHandler(startHandler.fetch);
