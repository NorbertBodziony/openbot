// Drop the optional -duration group and this stops matching: after `transition` comes a
// hyphen, not the colon the pattern needs. Nothing else absorbs it, so it gets a file.
export const InlineTransitionDuration = () => <div style={{ "transition-duration": "200ms" }} />;
