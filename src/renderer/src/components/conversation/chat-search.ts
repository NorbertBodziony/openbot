const RESULTS_HIGHLIGHT = "openbot-chat-search-results";
const CURRENT_HIGHLIGHT = "openbot-chat-search-current";

export interface ChatSearchMatch {
  range: Range;
  message: HTMLElement;
}

interface TextSegment {
  node: Text;
  start: number;
  end: number;
}

function highlightRegistry(): HighlightRegistry | undefined {
  return globalThis.CSS?.highlights;
}

export function clearChatSearchHighlights(): void {
  const registry = highlightRegistry();
  registry?.delete(RESULTS_HIGHLIGHT);
  registry?.delete(CURRENT_HIGHLIGHT);
}

export function renderChatSearchHighlights(matches: ChatSearchMatch[], currentIndex: number): void {
  const registry = highlightRegistry();
  if (!registry) return;
  registry.delete(RESULTS_HIGHLIGHT);
  registry.delete(CURRENT_HIGHLIGHT);
  if (matches.length === 0) return;

  const results = new Highlight(...matches.map((match) => match.range));
  results.priority = 1;
  registry.set(RESULTS_HIGHLIGHT, results);

  const current = matches[currentIndex];
  if (!current) return;
  const active = new Highlight(current.range);
  active.priority = 2;
  registry.set(CURRENT_HIGHLIGHT, active);
}

export function findChatSearchMatches(root: HTMLElement, query: string): ChatSearchMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];

  const matches: ChatSearchMatch[] = [];
  for (const message of root.querySelectorAll<HTMLElement>("[data-chat-search-message]")) {
    const segments: TextSegment[] = [];
    let text = "";
    const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!(node instanceof Text) || !node.data) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || parent.closest('[aria-hidden="true"], .sr-only, .message-actions')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let node = walker.nextNode();
    while (node) {
      if (!(node instanceof Text)) {
        node = walker.nextNode();
        continue;
      }
      const textNode = node;
      const start = text.length;
      text += textNode.data;
      segments.push({ node: textNode, start, end: text.length });
      node = walker.nextNode();
    }

    const searchableText = text.toLocaleLowerCase();
    let offset = 0;
    while (offset <= searchableText.length - needle.length) {
      const matchStart = searchableText.indexOf(needle, offset);
      if (matchStart === -1) break;
      const matchEnd = matchStart + needle.length;
      const startSegment = segments.find((segment) => matchStart >= segment.start && matchStart < segment.end);
      const endSegment = segments.find((segment) => matchEnd > segment.start && matchEnd <= segment.end);
      if (startSegment && endSegment) {
        const range = document.createRange();
        range.setStart(startSegment.node, matchStart - startSegment.start);
        range.setEnd(endSegment.node, matchEnd - endSegment.start);
        matches.push({ range, message });
      }
      offset = matchEnd;
    }
  }
  return matches;
}
