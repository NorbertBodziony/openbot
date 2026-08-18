import { StringDecoder } from "node:string_decoder";
import { isString } from "@openbot/contracts/runtime-values";
import { isRpcMessage, type RpcMessage } from "./protocol";

export class JsonLineDecoder {
  readonly #decoder = new StringDecoder("utf8");
  #buffer = "";

  push(chunk: Uint8Array | string): RpcMessage[] {
    this.#buffer += isString(chunk) ? chunk : this.#decoder.write(Buffer.from(chunk));
    return this.#drainCompleteLines();
  }

  end(chunk?: Uint8Array | string): RpcMessage[] {
    if (chunk) {
      this.#buffer += isString(chunk) ? chunk : this.#decoder.write(Buffer.from(chunk));
    }
    this.#buffer += this.#decoder.end();

    const messages = this.#drainCompleteLines();
    const trailing = this.#buffer.trim();
    this.#buffer = "";

    if (trailing) {
      messages.push(this.#parseLine(trailing));
    }

    return messages;
  }

  #drainCompleteLines(): RpcMessage[] {
    const messages: RpcMessage[] = [];
    let newlineIndex = this.#buffer.indexOf("\n");

    while (newlineIndex >= 0) {
      const line = this.#buffer.slice(0, newlineIndex).trim();
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (line) messages.push(this.#parseLine(line));
      newlineIndex = this.#buffer.indexOf("\n");
    }

    return messages;
  }

  #parseLine(line: string): RpcMessage {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSONL from Codex App Server: ${String(error)}`);
    }

    if (!isRpcMessage(parsed)) {
      throw new Error("Invalid JSON-RPC message from Codex App Server.");
    }

    return parsed;
  }
}
