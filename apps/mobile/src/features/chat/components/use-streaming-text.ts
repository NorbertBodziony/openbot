import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "react-native-reanimated";

const WORD_GAP_MS = 60;
const WORD_WITH_SEPARATOR = /^(?:\s*(?:(?:#{1,6}|[-+*>]|\d+[.)])\s+)?\S+\s+)/u;

export function useStreamingText(body: string, streaming: boolean, enabled: boolean) {
  const reducedMotion = useReducedMotion();
  const [display, setDisplay] = useState(() => ({
    body: streaming && enabled && !reducedMotion ? "" : body,
    animateTail: false,
  }));
  const visible = useRef(display.body);
  const target = useRef({ body, streaming });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);

  useEffect(() => {
    target.current = { body, streaming };
    const cancel = () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
    if (!enabled || reducedMotion || !body.startsWith(visible.current) || !streaming) {
      cancel();
      visible.current = body;
      setDisplay((current) => (current.body === body && !current.animateTail ? current : { body, animateTail: false }));
      return;
    }
    const reveal = () => {
      timer.current = null;
      const remaining = target.current.body.slice(visible.current.length);
      if (!remaining) {
        return;
      }
      const word = remaining.match(WORD_WITH_SEPARATOR)?.[0];
      if (!word && target.current.streaming) return;
      visible.current += word ?? remaining;
      setDisplay({ body: visible.current, animateTail: true });
      if (visible.current !== target.current.body) timer.current = setTimeout(reveal, WORD_GAP_MS);
    };
    if (body !== visible.current && timer.current === null) timer.current = setTimeout(reveal, WORD_GAP_MS);
  }, [body, enabled, reducedMotion, streaming]);

  // Completed responses must be available in this render, before effect cleanup runs.
  return !streaming || !enabled || reducedMotion ? { body, animateTail: false } : display;
}
