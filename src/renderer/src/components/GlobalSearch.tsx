import { expandChatTagReferences } from "@openbot/contracts/chat-tag-references";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import type { AgentMessage, AgentProfile } from "../data";
import { AgentAvatar } from "../features/agents/AgentAvatar";
import { Combobox, Dialog, Input, Kbd, Search, Tabs } from "./ui";

type SearchTab = "all" | "messages" | "agents";

type GlobalSearchResult =
  | { kind: "agent"; agent: AgentProfile }
  | { kind: "message"; agent: AgentProfile; message: AgentMessage };

interface GlobalSearchProps {
  open: boolean;
  agents: AgentProfile[];
  onSearchMessages?: (query: string) => Promise<Array<{ agentId: string; message: AgentMessage }>>;
  onOpenChange: (open: boolean) => void;
  onSelectAgent: (agentId: string) => void;
  onSelectMessage: (agentId: string, messageId: string) => void;
}

const SEARCH_RESULT_LIMIT = 100;

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function isSearchTab(value: string): value is SearchTab {
  return value === "all" || value === "messages" || value === "agents";
}

function messagePreview(message: AgentMessage): string {
  return expandChatTagReferences(message.body).trim().replace(/\s+/g, " ");
}

function resultKey(result: GlobalSearchResult): string {
  return result.kind === "agent" ? `agent:${result.agent.id}` : `message:${result.agent.id}:${result.message.id}`;
}

function resultLabel(result: GlobalSearchResult): string {
  return result.kind === "agent" ? result.agent.name : messagePreview(result.message);
}

function resultSearchText(result: GlobalSearchResult): string {
  if (result.kind === "agent") {
    return normalized(`${result.agent.name} ${result.agent.title} ${result.agent.description} ${result.agent.preview}`);
  }
  return normalized(
    `${messagePreview(result.message)} ${result.agent.name} ${result.agent.title} ${result.agent.description}`,
  );
}

function resultDescription(result: GlobalSearchResult): string {
  if (result.kind === "agent") return result.agent.title || result.agent.preview;
  const direction = result.message.author === "you" ? `You to ${result.agent.name}` : `${result.agent.name} to you`;
  return `${direction} · ${result.message.time}`;
}

export function GlobalSearch(props: GlobalSearchProps) {
  const [tab, setTab] = createSignal<SearchTab>("all");
  const [query, setQuery] = createSignal("");
  const [messageResults, setMessageResults] = createSignal<GlobalSearchResult[]>([]);
  let input: HTMLInputElement | undefined;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let searchRequest = 0;

  const agentResults = createMemo<GlobalSearchResult[]>(() => props.agents.map((agent) => ({ kind: "agent", agent })));
  const results = createMemo(() => {
    const value = normalized(query());
    const category = tab();
    const candidates =
      category === "agents"
        ? agentResults()
        : category === "messages"
          ? messageResults()
          : value
            ? [...agentResults(), ...messageResults()]
            : agentResults();
    if (!value) return candidates.slice(0, SEARCH_RESULT_LIMIT);
    return candidates.filter((result) => resultSearchText(result).includes(value)).slice(0, SEARCH_RESULT_LIMIT);
  });

  createEffect(
    () => props.open,
    (open) => {
      if (!open) return;
      setTab("all");
      setQuery("");
      requestAnimationFrame(() => input?.focus());
    },
  );

  createEffect(
    () => ({ open: props.open, query: query(), tab: tab() }),
    ({ open, query, tab }) => {
      if (searchTimer) clearTimeout(searchTimer);
      const request = ++searchRequest;
      const value = normalized(query);
      if (!open || !value || tab === "agents") {
        setMessageResults([]);
        return;
      }
      const searchMessages = props.onSearchMessages;
      if (!searchMessages) return;
      searchTimer = setTimeout(() => {
        void searchMessages(value)
          .then((items) => {
            if (request !== searchRequest) return;
            setMessageResults(
              items.flatMap(({ agentId, message }) => {
                const agent = props.agents.find((candidate) => candidate.id === agentId);
                return agent && message.kind !== "thinking" && messagePreview(message)
                  ? [{ kind: "message" as const, agent, message }]
                  : [];
              }),
            );
          })
          .catch(() => {
            if (request === searchRequest) setMessageResults([]);
          });
      }, 150);
    },
  );

  onCleanup(() => {
    if (searchTimer) clearTimeout(searchTimer);
  });

  function activate(result: GlobalSearchResult | null | undefined): void {
    if (!result) return;
    props.onOpenChange(false);
    if (result.kind === "agent") props.onSelectAgent(result.agent.id);
    else props.onSelectMessage(result.agent.id, result.message.id);
  }

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="global-search-overlay" />
        <Dialog.Content class="global-search-dialog" aria-describedby={undefined}>
          <Dialog.Title class="sr-only">Search OpenBot</Dialog.Title>
          <Combobox.Root<GlobalSearchResult>
            options={results()}
            open={true}
            modal={false}
            triggerMode="input"
            closeOnSelection={false}
            shouldFocusWrap={true}
            allowsEmptyCollection={true}
            noResetInputOnBlur={true}
            onInputChange={setQuery}
            defaultFilter={() => true}
            optionValue={resultKey}
            optionTextValue={resultSearchText}
            optionLabel={resultLabel}
            onChange={activate}
            itemComponent={(itemProps) => {
              const result = itemProps.item.rawValue;
              const index = () => results().findIndex((candidate) => resultKey(candidate) === resultKey(result));
              return (
                <Combobox.Item item={itemProps.item} class="global-search-result">
                  <AgentAvatar agent={result.agent} motion="hover" class="global-search-avatar" />
                  <span class="global-search-result-copy">
                    <Combobox.ItemLabel>
                      <span class="global-search-result-title">{resultLabel(result)}</span>
                    </Combobox.ItemLabel>
                    <span class="global-search-result-description">{resultDescription(result)}</span>
                  </span>
                  <span class="global-search-result-shortcut" aria-hidden="true">
                    <Show
                      when={index() >= 0 && index() < 9}
                      fallback={<span>{result.kind === "agent" ? "Agent" : "Message"}</span>}
                    >
                      <Kbd>⌘</Kbd>
                      <Kbd>{index() + 1}</Kbd>
                    </Show>
                  </span>
                </Combobox.Item>
              );
            }}
          >
            <Combobox.Control class="global-search-control">
              <Search aria-hidden="true" />
              <Combobox.Input
                as={Input}
                ref={(element) => (input = element)}
                class="global-search-input"
                aria-label="Search OpenBot"
                placeholder="Search"
                autocomplete="off"
                autocapitalize="none"
                spellcheck={false}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.isComposing && !input?.getAttribute("aria-activedescendant")) {
                    const firstResult = results()[0];
                    if (!firstResult) return;
                    event.preventDefault();
                    activate(firstResult);
                    return;
                  }
                  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
                  const index = Number(event.key) - 1;
                  if (!Number.isInteger(index) || index < 0 || index > 8) return;
                  const result = results()[index];
                  if (!result) return;
                  event.preventDefault();
                  activate(result);
                }}
              />
            </Combobox.Control>

            <Tabs.Root
              value={tab()}
              onChange={(value) => {
                if (isSearchTab(value)) setTab(value);
              }}
              class="global-search-tabs"
            >
              <Tabs.List aria-label="Filter results">
                <Tabs.Trigger value="all">All</Tabs.Trigger>
                <Tabs.Trigger value="messages">Messages</Tabs.Trigger>
                <Tabs.Trigger value="agents">Agents</Tabs.Trigger>
              </Tabs.List>
            </Tabs.Root>

            <Combobox.Content class="global-search-results">
              <Combobox.Listbox aria-label="Results" />
              <Show when={results().length === 0}>
                <div class="global-search-empty">No matching messages or agents</div>
              </Show>
            </Combobox.Content>
          </Combobox.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
