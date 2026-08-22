import { For } from "solid-js";
import "./landing-preview-people.css";

export interface LandingPreviewPeopleProps {
  selectedPersonId: string;
}

const PEOPLE_CONVERSATIONS = {
  "member-alice": {
    name: "Alice",
    initials: "AL",
    color: "var(--openbot-preview-person-alice)",
    messages: [
      ["them", "I tightened the launch note and removed the unsupported review-time claim."],
      ["you", "Perfect. Keep the verified setup metric and send the final copy to Launch."],
      ["them", "Done. The final wording is in release-note.md and Launch has the handoff."],
    ],
  },
  "member-maya": {
    name: "Maya",
    initials: "MA",
    color: "var(--openbot-preview-person-maya)",
    messages: [
      ["you", "Can you confirm support coverage for the release window?"],
      ["them", "Yes. I have the first two hours, and the EU handoff starts at 14:00 UTC."],
      ["you", "Great. I added both owners to the rollout checklist."],
    ],
  },
  "member-jon": {
    name: "Jon",
    initials: "JO",
    color: "var(--openbot-preview-person-jon)",
    messages: [
      ["them", "The rollback drill passed on staging. Recovery took four minutes."],
      ["you", "Nice. Any open risk before Builder closes the checklist?"],
      ["them", "Only the analytics alert. It is non-blocking and documented."],
    ],
  },
} as const;

type PersonId = keyof typeof PEOPLE_CONVERSATIONS;

function isPersonId(value: string): value is PersonId {
  return value in PEOPLE_CONVERSATIONS;
}

export function LandingPreviewPeople(props: LandingPreviewPeopleProps) {
  const conversation = () =>
    PEOPLE_CONVERSATIONS[isPersonId(props.selectedPersonId) ? props.selectedPersonId : "member-alice"];

  return (
    <main class="landing-demo-conversation landing-demo-direct" aria-label={`${conversation().name} conversation`}>
      <header class="landing-demo-conversation-header landing-demo-direct-header">
        <span class="landing-demo-person-avatar" style={{ "--person-hue": conversation().color }} aria-hidden="true">
          {conversation().initials}
        </span>
        <span>
          <strong>{conversation().name}</strong>
          <small>Online</small>
        </span>
        <span class="landing-demo-header-icons" aria-hidden="true">
          ⌁　▣
        </span>
      </header>
      <div class="landing-demo-direct-messages">
        <For each={conversation().messages}>
          {(message) => (
            <article class={`landing-demo-direct-message${message[0] === "you" ? " is-yours" : ""}`}>
              {message[1]}
            </article>
          )}
        </For>
      </div>
      <footer class="landing-demo-composer" aria-hidden="true">
        <span>Message {conversation().name}</span>
        <span>＋　◉</span>
      </footer>
    </main>
  );
}
