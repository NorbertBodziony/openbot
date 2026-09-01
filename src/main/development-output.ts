interface ErrorStream {
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
  off(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
}

export function guardDevelopmentOutput(streams: ErrorStream[], onOutputClosed: () => void): () => void {
  let outputClosed = false;
  const handleError = (error: NodeJS.ErrnoException) => {
    if (error.code !== "EIO" && error.code !== "EPIPE") throw error;
    if (outputClosed) return;
    outputClosed = true;
    onOutputClosed();
  };
  for (const stream of streams) stream.on("error", handleError);
  return () => {
    for (const stream of streams) stream.off("error", handleError);
  };
}
