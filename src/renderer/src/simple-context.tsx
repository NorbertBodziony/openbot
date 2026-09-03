import { createContext, createMemo, type ParentProps, Show, useContext } from "solid-js";

/**
 * One domain of renderer state, packaged as a provider and a reader.
 *
 * `init` runs once per provider mount and returns the domain's state and
 * actions. Consumers reach it through `use()`, which throws outside the
 * provider rather than handing back a silent `undefined`.
 *
 * Solid's `useContext` already throws on a missing provider, and its docs say a
 * wrapper that re-throws is unnecessary for that reason. It is necessary here:
 * the built-in message is "Context must either be created with a default value
 * or a value must be provided before accessing it" - one sentence shared by
 * every domain, raised from the single `use` frame they all share, so it names
 * neither the context nor anything to search for. Handing back `undefined`
 * instead is not available either; `getContext` throws on any undefined value,
 * default included. So `use` catches and re-throws under the domain's name,
 * keeping Solid's own diagnosis as the `cause`.
 *
 * Passing `ready` gates the provider: it withholds its children until the
 * predicate holds, so everything below can read loaded state without a null
 * check at every use. Two consequences worth knowing before adding one:
 *
 * - A gate must depend on *data*, never on the view tree. `App.test.tsx` and
 *   `App.read-state.test.tsx` render providers with no view at all, and a gate
 *   that waits for something rendered would deadlock them.
 * - Dependencies flow outward-in. A context may read one it is nested inside;
 *   it may never read one nested under it, because that is an import cycle and
 *   `noImportCycles` rejects it. Commands spanning several domains belong in a
 *   leaf context, or take what they need through provider props.
 *
 * A domain whose load the rest of the app should not wait on omits `ready` and
 * returns its own readiness accessor on the value instead, leaving consumers to
 * decide what to show meanwhile. Readiness is an input here rather than a
 * property of the value because the two forms are mutually exclusive: below a
 * gate `ready` is true by construction, so a gated context that also exposed it
 * would only invite dead checks.
 */
export function createSimpleContext<Value extends object, Props extends object = Record<never, never>>(input: {
  name: string;
  init: (props: Props) => Value;
  ready?: (value: Value) => boolean;
}) {
  const Context = createContext<Value>(undefined, { name: input.name });

  function provider(props: ParentProps<Props>) {
    const value = input.init(props);
    const isReady = input.ready;
    if (!isReady) return <Context value={value}>{props.children}</Context>;
    const ready = createMemo(() => isReady(value));
    return (
      <Show when={ready()}>
        <Context value={value}>{props.children}</Context>
      </Show>
    );
  }

  function use(): Value {
    try {
      return useContext(Context);
    } catch (cause) {
      throw new Error(`${input.name} is unavailable outside its provider.`, { cause });
    }
  }

  return { provider, use };
}
