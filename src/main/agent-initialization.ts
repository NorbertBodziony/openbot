export class AgentInitializationGate {
  readonly #initialize: () => Promise<void>;
  #pending: Promise<void> | null = null;

  constructor(initialize: () => Promise<void>) {
    this.#initialize = initialize;
  }

  start(): Promise<void> {
    if (!this.#pending) {
      this.#pending = this.#initialize().catch((error) => {
        this.#pending = null;
        throw error;
      });
    }
    return this.#pending;
  }
}
