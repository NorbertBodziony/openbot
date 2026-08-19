import { Button, ChevronDown, ChevronUp, Input, Search, X } from "../ui";

interface ChatSearchProps {
  query: string;
  current: number;
  total: number;
  inputRef: (element: HTMLInputElement) => void;
  onQueryChange: (query: string) => void;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
}

export function ChatSearch(props: ChatSearchProps) {
  const position = () => (props.total > 0 ? `${props.current + 1}/${props.total}` : "0/0");

  return (
    // biome-ignore lint/a11y/noRedundantRoles: Testing Library and older accessibility layers need the explicit landmark role.
    <search class="chat-search" role="search" aria-label="Search conversation">
      <Search class="chat-search-icon" aria-hidden="true" />
      <Input
        ref={props.inputRef}
        class="chat-search-input"
        type="search"
        value={props.query}
        aria-label="Search messages"
        autocomplete="off"
        autocapitalize="none"
        spellcheck={false}
        onInput={(event) => props.onQueryChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            props.onClose();
            return;
          }
          if (event.key !== "Enter") return;
          event.preventDefault();
          event.shiftKey ? props.onPrevious() : props.onNext();
        }}
      />
      <span class="chat-search-position" aria-live="polite" aria-atomic="true">
        {position()}
      </span>
      <span class="chat-search-separator" aria-hidden="true" />
      <Button
        type="button"
        variant="ghost"
        size="xs"
        class="chat-search-button"
        aria-label="Previous match"
        disabled={props.total === 0}
        onClick={props.onPrevious}
      >
        <ChevronUp aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        class="chat-search-button"
        aria-label="Next match"
        disabled={props.total === 0}
        onClick={props.onNext}
      >
        <ChevronDown aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        class="chat-search-button chat-search-close"
        aria-label="Close conversation search"
        onClick={props.onClose}
      >
        <X aria-hidden="true" />
      </Button>
    </search>
  );
}
