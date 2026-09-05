import type { ChatSearchMatch } from "../chat-search";
import { clearChatSearchHighlights } from "../chat-search";
import type { ConversationProps } from "../conversation-types";

export interface SearchStoreDeps {
  props: ConversationProps;
  chatSearchOpen: () => boolean;
  setChatSearchOpen: (open: boolean) => void;
  setChatSearchQuery: (query: string) => void;
  chatSearchMatches: () => ChatSearchMatch[];
  setChatSearchMatches: (matches: ChatSearchMatch[]) => void;
  chatSearchMessageIds: () => string[];
  setChatSearchMessageIds: (ids: string[]) => void;
  setChatSearchTotal: (total: number) => void;
  setActiveChatSearchIndex: (update: number | ((current: number) => number)) => void;
}

export function createSearchStore(deps: SearchStoreDeps) {
  let chatSearchInput: HTMLInputElement | undefined;
  let chatSearchReturnFocus: HTMLElement | undefined;

  function openChatSearch(): void {
    if (!deps.chatSearchOpen() && document.activeElement instanceof HTMLElement) {
      chatSearchReturnFocus = document.activeElement;
    }
    deps.setChatSearchOpen(true);
    requestAnimationFrame(() => {
      chatSearchInput?.focus();
      chatSearchInput?.select();
    });
  }

  function closeChatSearch(restoreFocus = true): void {
    deps.setChatSearchOpen(false);
    deps.setChatSearchQuery("");
    deps.setChatSearchMatches([]);
    deps.setChatSearchMessageIds([]);
    deps.setChatSearchTotal(0);
    deps.setActiveChatSearchIndex(-1);
    clearChatSearchHighlights();
    const returnFocus = chatSearchReturnFocus;
    if (restoreFocus && returnFocus?.isConnected) {
      requestAnimationFrame(() => returnFocus.focus());
    }
    chatSearchReturnFocus = undefined;
  }

  function moveChatSearch(direction: 1 | -1): void {
    const remoteIds = deps.chatSearchMessageIds();
    const total = deps.props.onSearchMessages ? remoteIds.length : deps.chatSearchMatches().length;
    if (total === 0) return;
    deps.setActiveChatSearchIndex((current) => {
      const next = (current + direction + total) % total;
      if (deps.props.onSearchMessages) {
        const messageId = remoteIds[next];
        if (messageId) void deps.props.onOpenSearchMessage?.(messageId);
      }
      return next;
    });
  }

  function handleChatSearchShortcut(event: KeyboardEvent): void {
    const primaryModifier = event.metaKey || event.ctrlKey;
    const key = event.key.toLocaleLowerCase();
    if (primaryModifier && !event.altKey && !event.shiftKey && key === "f") {
      event.preventDefault();
      event.stopPropagation();
      openChatSearch();
      return;
    }
    if (!deps.chatSearchOpen() || !primaryModifier || event.altKey || key !== "g") return;
    event.preventDefault();
    event.stopPropagation();
    moveChatSearch(event.shiftKey ? -1 : 1);
  }

  const setChatSearchInputElement = (element: HTMLInputElement) => {
    chatSearchInput = element;
  };

  return {
    openChatSearch,
    closeChatSearch,
    moveChatSearch,
    handleChatSearchShortcut,
    setChatSearchInputElement,
    getChatSearchInput: () => chatSearchInput,
    getChatSearchReturnFocus: () => chatSearchReturnFocus,
  };
}

export type SearchStore = ReturnType<typeof createSearchStore>;
