import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "react-native-reanimated";

const WORD_GAP_MS = 60;
const WORD_WITH_SEPARATOR = /^(?:\s*(?:(?:#{1,6}|[-+*>]|\d+[.)])\s+)?\S+\s+)/u;

export function useStreamingText(body: string, streaming: boolean, animateInitial: boolean, enabled: boolean) {
  const reducedMotion = useReducedMotion();
  const [display, setDisplay] = useState(() => ({
    body: animateInitial && enabled && !reducedMotion ? "" : body,
    animateTail: false,
  }));
  const visible = useRef(display.body);
  const target = useRef({ body, streaming });
  const smoothing = useRef(streaming || animateInitial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);

  useEffect(() => {
    target.current = { body, streaming };
    if (streaming) smoothing.current = true;
    const cancel = () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
    if (!enabled || reducedMotion || !body.startsWith(visible.current) || (!streaming && !smoothing.current)) {
      cancel();
      visible.current = body;
      smoothing.current = false;
      setDisplay((current) => (current.body === body && !current.animateTail ? current : { body, animateTail: false }));
      return;
    }
    const reveal = () => {
      timer.current = null;
      const remaining = target.current.body.slice(visible.current.length);
      if (!remaining) {
        if (!target.current.streaming) smoothing.current = false;
        return;
      }
      const word = remaining.match(WORD_WITH_SEPARATOR)?.[0];
      if (!word && target.current.streaming) return;
      visible.current += word ?? remaining;
      setDisplay({ body: visible.current, animateTail: true });
      if (visible.current !== target.current.body) timer.current = setTimeout(reveal, WORD_GAP_MS);
      else if (!target.current.streaming) smoothing.current = false;
    };
    if (body !== visible.current && timer.current === null) timer.current = setTimeout(reveal, WORD_GAP_MS);
    else if (!streaming && body === visible.current) smoothing.current = false;
  }, [body, enabled, reducedMotion, streaming]);

  return display;
}
