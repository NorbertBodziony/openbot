import { Button } from "../ui";

export function preferredMessageScrollBehavior(): ScrollBehavior {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

export function scrollToLatestMessage(scrollElement: HTMLElement): void {
  scrollElement.scrollTo({
    top: scrollElement.scrollHeight,
    behavior: preferredMessageScrollBehavior(),
  });
}

export function ScrollToLatestButton(props: { onClick: () => void }) {
  return (
    <Button type="button" class="scroll-to-latest-button" aria-label="Scroll to latest message" onClick={props.onClick}>
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M12 4v14m-6-6 6 6 6-6" />
      </svg>
    </Button>
  );
}
