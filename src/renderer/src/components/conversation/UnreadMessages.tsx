import { preferredMessageScrollBehavior } from "./MessageNavigation";

export function UnreadMessagesBanner(props: {
  count: number;
  busy?: boolean;
  onJumpToUnread: () => void;
  onMarkRead: () => void;
}) {
  const label = () => `${props.count} new ${props.count === 1 ? "message" : "messages"}`;
  return (
    <div class="unread-messages-banner" role="status" aria-label={label()}>
      <button
        class="unread-messages-jump"
        type="button"
        aria-label={`Jump to ${label()}`}
        onClick={props.onJumpToUnread}
      >
        {label()}
      </button>
      <button class="unread-messages-mark-read" type="button" disabled={props.busy} onClick={props.onMarkRead}>
        {props.busy ? "Marking…" : "Mark as read"}
      </button>
    </div>
  );
}

export function UnreadMessagesDivider(props: { elementRef?: (element: HTMLDivElement) => void }) {
  return (
    <div class="unread-messages-divider" ref={props.elementRef}>
      <hr aria-label="New messages" />
      <span>NEW</span>
      <hr />
    </div>
  );
}

export function scrollToUnreadBoundary(
  scrollElement: HTMLElement,
  boundary: HTMLElement,
  behavior: ScrollBehavior = preferredMessageScrollBehavior(),
): void {
  const top =
    boundary.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top + scrollElement.scrollTop;
  scrollElement.scrollTo({ top: Math.max(0, top), behavior });
}
