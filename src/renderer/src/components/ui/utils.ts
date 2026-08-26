import type { JSX } from "@solidjs/web";

type ClassValue = JSX.HTMLAttributes<HTMLElement>["class"] | false | null | undefined;

export function cx(...values: ClassValue[]): string {
  return values
    .flatMap((value): string[] => {
      if (!value || value === true) return [];
      if (Array.isArray(value)) return [cx(...value)];
      if (Object.prototype.toString.call(value) === "[object Object]") {
        return Object.entries(value)
          .filter(([, enabled]) => enabled)
          .map(([className]) => className);
      }
      return [String(value)];
    })
    .join(" ");
}

export function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const visibleLength = maxLength - 1;
  const startLength = Math.ceil((visibleLength * 2) / 3);
  const endLength = visibleLength - startLength;
  return `${value.slice(0, startLength)}…${value.slice(-endLength)}`;
}
