import GithubSlugger from "github-slugger";

export interface TocItem {
  depth: 2 | 3;
  text: string;
  id: string;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

/** Text content of a raw HTML heading, so its slug matches what rehype-slug
 *  computes from the rendered element. */
function htmlHeadingText(inner: string): string {
  return inner
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m])
    .trim();
}

/** Extract H2 / H3 headings from a markdown body, skipping fenced code blocks.
 *  Raw HTML headings count too, which is how a `<details>` block gets a title
 *  that behaves like a real heading (`<summary><h3>…</h3></summary>`).
 *  Slugs match rehype-slug (which uses github-slugger). */
export function extractToc(body: string): TocItem[] {
  const slugger = new GithubSlugger();
  const lines = body.split("\n");
  const out: TocItem[] = [];
  let inFence = false;
  let fenceMarker = "";

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    const fence = line.match(/^(`{3,}|~{3,})/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1][0];
      } else if (line.startsWith(fenceMarker)) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    const m = line.match(/^(#{2,3})\s+(.+?)\s*#*\s*$/);
    const html = m ? null : line.match(/<h([23])\b[^>]*>([\s\S]*?)<\/h\1\s*>/i);
    if (!m && !html) continue;
    const depth = (m ? m[1].length : Number(html![1])) as 2 | 3;
    // Inline markdown is only parsed in a markdown heading; a raw HTML heading
    // renders its text as written, so only its tags need stripping.
    const cleaned = m
      ? m[2]
          .replace(/`([^`]+)`/g, "$1")
          .replace(/\*\*([^*]+)\*\*/g, "$1")
          .replace(/\*([^*]+)\*/g, "$1")
          .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      : htmlHeadingText(html![2]);
    // Glossary markers are preprocessed in both cases, so drop them either way.
    const text = cleaned
      .replace(/(?<![\s\d\\])%/g, "") // Remove glossary % markers
      .replace(/\\%/g, "%"); // Unescape literal \%
    out.push({ depth, text, id: slugger.slug(text) });
  }

  return out;
}
