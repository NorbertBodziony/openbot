/**
 * Telling the team server whether the user is composing.
 *
 * It sits in its own module because two owners with different lifetimes need it:
 * the conversation domain, which is scoped to one server, and the conversation
 * controller in `app-providers.tsx`, which is not. Neither can import the other,
 * and the call carries no cached state - it is one fire-and-forget IPC.
 */
export function notifyTeamTyping(botId: string, typing: boolean): void {
  void window.openbot.servers.setTyping({ botId: typing ? botId : null, typing }).catch(() => {
    // Typing state is optional and must not interrupt message composition.
  });
}
