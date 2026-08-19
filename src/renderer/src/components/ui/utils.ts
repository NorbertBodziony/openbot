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
