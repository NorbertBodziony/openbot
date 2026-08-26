import type { JSX } from "@solidjs/web";
import { omit } from "solid-js";
import { cx } from "./utils";

export interface MessageGroupProps extends JSX.HTMLAttributes<HTMLDivElement> {}

export function MessageGroup(props: MessageGroupProps): JSX.Element {
  const others = omit(props, "class");
  return <div data-slot="message-group" class={cx("ui-message-group", props.class)} {...others} />;
}

export interface MessageProps extends JSX.HTMLAttributes<HTMLDivElement> {
  align?: "start" | "end";
}

export function Message(props: MessageProps): JSX.Element {
  const others = omit(props, "align", "class");
  return (
    <div data-slot="message" data-align={props.align ?? "start"} class={cx("ui-message", props.class)} {...others} />
  );
}

export interface MessageAvatarProps extends JSX.HTMLAttributes<HTMLDivElement> {}

export function MessageAvatar(props: MessageAvatarProps): JSX.Element {
  const others = omit(props, "class");
  return <div data-slot="message-avatar" class={cx("ui-message-avatar", props.class)} {...others} />;
}

export interface MessageContentProps extends JSX.HTMLAttributes<HTMLDivElement> {}

export function MessageContent(props: MessageContentProps): JSX.Element {
  const others = omit(props, "class");
  return <div data-slot="message-content" class={cx("ui-message-content", props.class)} {...others} />;
}

export interface MessageHeaderProps extends JSX.HTMLAttributes<HTMLDivElement> {}

export function MessageHeader(props: MessageHeaderProps): JSX.Element {
  const others = omit(props, "class");
  return <div data-slot="message-header" class={cx("ui-message-header", props.class)} {...others} />;
}

export interface MessageFooterProps extends JSX.HTMLAttributes<HTMLDivElement> {}

export function MessageFooter(props: MessageFooterProps): JSX.Element {
  const others = omit(props, "class");
  return <div data-slot="message-footer" class={cx("ui-message-footer", props.class)} {...others} />;
}
