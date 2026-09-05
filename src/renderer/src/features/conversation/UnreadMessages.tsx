import { Button } from "../../components/ui";
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
      <Button
        variant="ghost"
        class="unread-messages-jump"
        type="button"
        aria-label={`Jump to ${label()}`}
        onClick={props.onJumpToUnread}
      >
        {label()}
      </Button>
      <Button
        variant="ghost"
        class="unread-messages-mark-read"
        type="button"
        disabled={props.busy}
        onClick={props.onMarkRead}
      >
        <span class="unread-messages-mark-read-label">{props.busy ? "Marking…" : "Mark as read"}</span>
      </Button>
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

export function unreadMessagesDividerIsVisible(scrollElement: HTMLElement, divider: HTMLElement): boolean {
  if (!divider.isConnected) return false;
  const scrollBounds = scrollElement.getBoundingClientRect();
  const dividerBounds = divider.getBoundingClientRect();
  return dividerBounds.bottom > scrollBounds.top && dividerBounds.top < scrollBounds.bottom;
}
