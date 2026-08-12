import type { BotAvatarShape } from "../../../shared/ipc";

const SILHOUETTES: Record<BotAvatarShape, string> = {
  blob: "M49 4C72 3 92 19 96 43C101 70 82 93 55 97C28 100 5 82 4 56C3 31 23 7 49 4Z",
  pebble: "M50 7C75 7 94 24 94 50S76 94 50 94 6 77 6 51 25 7 50 7Z",
  squircle: "M25 6H75C87 6 94 13 94 25V75C94 87 87 94 75 94H25C13 94 6 87 6 75V25C6 13 13 6 25 6Z",
  tablet: "M31 4H69C84 4 92 13 92 28V72C92 87 84 96 69 96H31C16 96 8 87 8 72V28C8 13 16 4 31 4Z",
  wedge: "M46 9C48 5 52 5 54 9L94 79C97 85 94 91 88 93C66 99 34 99 12 93C6 91 3 85 6 79L46 9Z",
  hex: "M26 5H74L96 27V73L74 95H26L4 73V27L26 5Z",
  cloud:
    "M23 33C29 17 47 10 62 18C77 15 91 26 91 42C101 54 96 72 84 78C79 92 61 97 49 89C34 97 16 89 14 74C1 66 2 47 15 40C16 37 19 35 23 33Z",
  teardrop: "M50 3C58 18 82 35 91 56C101 80 84 96 50 96S-1 80 9 56C18 35 42 18 50 3Z",
};

export function AgentMark(props: { shape?: BotAvatarShape }) {
  return (
    <svg aria-hidden="true" class="agent-mark" viewBox="0 0 100 100">
      <path class="agent-mark__head" d={SILHOUETTES[props.shape ?? "blob"]} />
      <path class="agent-mark__face" d="M34 31c4 4 6 8 7 13M58 28c4 4 6 8 7 13" />
    </svg>
  );
}
