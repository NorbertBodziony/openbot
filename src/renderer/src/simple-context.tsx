import { createContext, type ParentProps, useContext } from "solid-js";

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
 * A provider is a plain wrapper: it renders its children immediately and a
 * domain that is still loading says so on its own value, leaving each consumer
 * to decide what to show meanwhile. There is deliberately no readiness option
 * that withholds children - the app gates on data in one place, the `<Show>`
 * ladder in `AppView.tsx`, and a second gating mechanism spread across twenty
 * providers would only make the order in which the screen appears harder to
 * read.
 *
 * Dependencies flow outward-in. A context may read one it is nested inside; it
 * may never read one nested under it, because that is an import cycle and
 * `noImportCycles` rejects it. Commands spanning several domains belong in a
 * leaf context, or take what they need through provider props.
 */
export function createSimpleContext<Value extends object, Props extends object = Record<never, never>>(input: {
  name: string;
  init: (props: Props) => Value;
}) {
  const Context = createContext<Value>(undefined, { name: input.name });

  function provider(props: ParentProps<Props>) {
    const value = input.init(props);
    return <Context value={value}>{props.children}</Context>;
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
