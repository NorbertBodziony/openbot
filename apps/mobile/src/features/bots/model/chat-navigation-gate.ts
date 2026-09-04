// AppleZoom reveals tappable bot rows before its native return transition ends.
// Navigating during that window can lose the first tap when reopening the same chat,
// so retain it until transitionEnd and route focus have both settled (in either order).
export function createChatNavigationGate() {
  let transitioning = false;
  let pending: { navigate: () => void; isFocused: () => boolean } | null = null;

  function flush() {
    if (transitioning || !pending?.isFocused()) return;
    const { navigate } = pending;
    pending = null;
    navigate();
  }

  return {
    request(navigate: () => void, isFocused: () => boolean) {
      // Nested navigators may already be focused without emitting an initial focus
      // event. Tracking focus in a boolean initially set to false blocked every tap
      // on first load. Read isFocused() on each flush; focus events only retry a
      // pending tap when focus arrives after transitionEnd.
      pending = { navigate, isFocused };
      flush();
    },
    start() {
      transitioning = true;
    },
    finish() {
      transitioning = false;
      flush();
    },
    focus() {
      flush();
    },
    blur() {
      pending = null;
    },
    cancel() {
      transitioning = false;
      pending = null;
    },
  };
}
