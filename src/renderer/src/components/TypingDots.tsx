export function TypingDots(props: { class?: string }) {
  return (
    <span class={props.class ?? "typing-dots"} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
