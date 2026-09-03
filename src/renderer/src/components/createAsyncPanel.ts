import { createStore } from "solid-js";

interface AsyncPanel {
  /** The key of the one action in flight, or `null`. A list load is `loading`, not an action. */
  busy: string | null;
  error: string | null;
  loading: boolean;
}

/**
 * The three fields every remote-backed panel carries: the list load, the one action in flight, and
 * the message the last failure left behind. They are one record because a panel is in exactly one
 * of these situations at a time - three signals let it be loading, busy and errored at once - and
 * because `run` writes `error` on every call, which a caller would otherwise have to remember.
 *
 * `describeError` turns a rejection into the message the panel shows, so the domain keeps its own
 * wording. Read through the returned store; write through the named mutations.
 */
export function createAsyncPanel(describeError: (cause: unknown) => string) {
  const [panel, setPanel] = createStore<AsyncPanel>({ busy: null, error: null, loading: false });

  function setBusy(key: string | null): void {
    setPanel((state) => {
      state.busy = key;
    });
  }

  function setError(message: string | null): void {
    setPanel((state) => {
      state.error = message;
    });
  }

  function setLoading(loading: boolean): void {
    setPanel((state) => {
      state.loading = loading;
    });
  }

  /**
   * Clears the error, awaits `work`, and reports a rejection as the panel's error rather than
   * letting it escape. `undefined` is the failure result, so a caller applies what it got only
   * when it got something.
   */
  async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
    setError(null);
    try {
      return await work();
    } catch (cause) {
      setError(describeError(cause));
      return undefined;
    }
  }

  return { panel, run, setBusy, setError, setLoading };
}
