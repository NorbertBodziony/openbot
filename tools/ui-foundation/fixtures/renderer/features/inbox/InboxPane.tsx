// A component that lives beside its domain rather than in components/, which is where the
// renderer is moving. The composite role count walks the whole renderer for exactly this
// reason: anchored to components/ it would have stopped seeing this file and read the
// budget as met. Nothing else here trips a check, so this file moves one number only.
export function InboxPane() {
  return <nav role="menu">Inbox</nav>;
}
