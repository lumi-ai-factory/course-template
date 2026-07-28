import { load as parseYaml } from "js-yaml";

/**
 * Split a markdown string into its YAML frontmatter and body.
 *
 * Replaces `gray-matter`, which pulled Node's `Buffer`/`fs` into the browser
 * bundle. Our content only uses a leading `---` fenced YAML block, so a small
 * pure-JS parser handles it without any Node polyfills.
 */
function parseFrontmatter(raw: string): { data: Record<string, unknown>; content: string } {
  // Strip a leading BOM, then match an opening `---` fence at the very start.
  const text = raw.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { data: {}, content: text };
  const parsed = parseYaml(match[1]);
  const data = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  return { data, content: text.slice(match[0].length) };
}

/**
 * Let authors size a collapsible title with normal markdown:
 *   <summary>### Exercise 1</summary>
 *
 * Markdown is not parsed inside a raw HTML line, so the heading is lifted onto
 * a block of its own (the blank lines end and restart the surrounding HTML
 * block, and rehype-raw stitches the pieces back together). It then behaves
 * like every other heading: real heading size, a slug id, a copy-link icon,
 * and an entry in the table of contents. Lines inside fenced code blocks are
 * left alone, so documenting the syntax in a code fence still shows it as
 * written.
 */
function expandSummaryHeadings(body: string): string {
  if (!body.includes("<summary")) return body;
  const out: string[] = [];
  let fence = "";
  for (const line of body.split("\n")) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = "";
      out.push(line);
      continue;
    }
    if (fence) {
      out.push(line);
      continue;
    }
    const m = line.match(
      /^([ \t]*)(<summary(?:\s[^>]*)?>)[ \t]*(#{1,6}[ \t]+.+?)[ \t]*(<\/summary>[ \t]*)$/i,
    );
    out.push(m ? `${m[1]}${m[2]}\n\n${m[1]}${m[3]}\n\n${m[1]}${m[4]}` : line);
  }
  return out.join("\n");
}

export interface PageFrontmatter {
  title: string;
  nav_order?: number;
  parent?: string;
  /** Accepted for Just the Docs-style front matter, but not required — nesting
   * is driven entirely by the children's `parent` fields. */
  has_children?: boolean;
  /** Optional meta description. When omitted, one is derived from the body. */
  description?: string;
}

export interface Page {
  /** URL slug — "" for index, otherwise filename without extension. */
  slug: string;
  /** Filesystem-style path used for "edit on GitHub". */
  path: string;
  frontmatter: PageFrontmatter;
  body: string;
}

const rawModules = import.meta.glob("/content/**/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function fileToSlug(filePath: string): string {
  // "/content/index.md" -> ""
  // "/content/chapter1.md" -> "chapter1"
  // "/content/sub/page.md" -> "sub/page"
  const rel = filePath.replace(/^\/content\//, "").replace(/\.md$/, "");
  return rel === "index" ? "" : rel;
}

export const pages: Page[] = Object.entries(rawModules)
  .map(([filePath, raw]) => {
    const parsed = parseFrontmatter(raw);
    return {
      slug: fileToSlug(filePath),
      path: filePath.replace(/^\//, ""),
      frontmatter: parsed.data as unknown as PageFrontmatter,
      body: expandSummaryHeadings(parsed.content),
    };
  })
  .sort((a, b) => (a.frontmatter.nav_order ?? 999) - (b.frontmatter.nav_order ?? 999));

/**
 * Warn about front-matter mistakes that the nav would otherwise swallow
 * silently: pages are linked to their parent by exact title, so a typo in
 * `parent` or a duplicated title rearranges the sidebar with no error. Runs
 * once on load, so warnings show up in the browser console during
 * `bun run dev` and in the CI build log when the site is prerendered.
 */
function warnAboutContentMistakes(all: Page[]) {
  const byTitle = new Map<string, Page>();
  for (const page of all) {
    const title = page.frontmatter.title;
    if (!title) {
      console.warn(`[content] ${page.path}: missing "title" in front matter.`);
      continue;
    }
    const other = byTitle.get(title);
    if (other) {
      console.warn(
        `[content] ${page.path} and ${other.path} share the title "${title}". Titles must be unique: they are how "parent" fields and breadcrumbs identify pages.`,
      );
    } else {
      byTitle.set(title, page);
    }
  }
  for (const page of all) {
    const parent = page.frontmatter.parent;
    if (!parent) continue;
    if (parent === page.frontmatter.title) {
      console.warn(
        `[content] ${page.path}: "parent" points at the page itself and is ignored.`,
      );
    } else if (!byTitle.has(parent)) {
      console.warn(
        `[content] ${page.path}: parent "${parent}" does not match any page title, so the page shows at the top level of the sidebar. Check it against the target page's "title".`,
      );
    }
  }
}

warnAboutContentMistakes(pages);

export function findPage(slug: string): Page | undefined {
  return pages.find((p) => p.slug === slug);
}

/**
 * Strip the inline markdown that would otherwise leak into plain text taken
 * from a body: images, links, inline code, emphasis, and glossary markers.
 * Used for meta descriptions and for the derived site title.
 */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links -> text
    .replace(/`([^`]*)`/g, "$1") // inline code
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    // Glossary markers: a "%" directly after a letter ends a `Term%` marker.
    // Percentages ("40%") follow digits, so they survive. `\%` escapes to "%".
    .replace(/(?<=\p{L})%/gu, "")
    .replace(/\\%/g, "%")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * First heading of a markdown body as plain text, or "" when there is none.
 * Headings inside fenced code blocks are skipped, so documenting markdown in a
 * code fence never wins. This is how the site gets its name: the `#` heading at
 * the top of `content/index.md` is the site title, so an author renames their
 * whole site by editing one heading they were writing anyway.
 */
export function firstHeading(body: string): string {
  let fence = "";
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    const marker = line.match(/^(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = "";
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/);
    if (heading) return stripInlineMarkdown(heading[1]);
  }
  return "";
}

/**
 * Produce a meta description for a page. Uses the front-matter `description`
 * when an author set one, otherwise auto-derives it from the first real
 * paragraph of the markdown body — so creators never have to write one.
 */
export function getPageDescription(page: Page, maxLen = 155): string {
  const fm = page.frontmatter.description?.trim();
  if (fm) return fm;

  const lines = page.body.split(/\r?\n/);
  const paragraph: string[] = [];
  let inFence = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // Skip headings, callout markers, blockquotes, list markers, images,
    // tables, html, and front-matter fences.
    if (
      line === "" ||
      line === "---" ||
      /^#{1,6}\s/.test(line) ||
      /^>\s*\[!/.test(line) ||
      /^[-*+]\s/.test(line) ||
      /^\d+\.\s/.test(line) ||
      /^\|/.test(line) ||
      /^!\[/.test(line) ||
      /^<\w/.test(line)
    ) {
      if (paragraph.length) break; // paragraph already collected
      continue;
    }
    if (line.startsWith(">")) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(line);
  }

  const text = stripInlineMarkdown(paragraph.join(" "));

  if (!text) return "";
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  return `${(lastSpace > 40 ? truncated.slice(0, lastSpace) : truncated).trimEnd()}…`;
}

/** Linear list of pages in sidebar order — used for prev/next navigation. */
export function flattenNavOrder(): Page[] {
  const tree = buildNavTree();
  const out: Page[] = [];
  const walk = (nodes: NavNode[]) => {
    for (const n of nodes) {
      out.push(n.page);
      walk(n.children);
    }
  };
  walk(tree);
  return out;
}

export interface PrevNext {
  prev?: Page;
  next?: Page;
}

export function getPrevNext(slug: string): PrevNext {
  const flat = flattenNavOrder();
  const idx = flat.findIndex((p) => p.slug === slug);
  if (idx === -1) return {};
  return {
    prev: idx > 0 ? flat[idx - 1] : undefined,
    next: idx < flat.length - 1 ? flat[idx + 1] : undefined,
  };
}

/** Build "Home › Chapter › Page" trail from front-matter parent links. */
export function getBreadcrumbs(slug: string): Page[] {
  const page = findPage(slug);
  if (!page) return [];
  const trail: Page[] = [page];
  let current = page;
  const byTitle = new Map(pages.map((p) => [p.frontmatter.title, p]));
  while (current.frontmatter.parent) {
    const parent = byTitle.get(current.frontmatter.parent);
    if (!parent || trail.includes(parent)) break;
    trail.unshift(parent);
    current = parent;
  }
  // Always start from Home unless we're already on it.
  const home = findPage("");
  if (home && trail[0].slug !== "") trail.unshift(home);
  return trail;
}

export interface NavNode {
  page: Page;
  children: NavNode[];
}

export function buildNavTree(): NavNode[] {
  const byTitle = new Map<string, NavNode>();
  const roots: NavNode[] = [];

  for (const page of pages) {
    // The glossary is a reference appendix, not part of the reading flow: it
    // gets a pinned link in the sidebar footer instead of a nav entry, and is
    // skipped by prev/next navigation (which flattens this tree).
    if (page.slug === "glossary") continue;
    const node: NavNode = { page, children: [] };
    byTitle.set(page.frontmatter.title, node);
  }

  // True when linking `node` under `parentTitle` would make the node its own
  // ancestor (self-parent or a longer `parent` loop) — that node becomes a
  // root instead, since a cycle would recurse forever when the tree is walked.
  const wouldCycle = (node: NavNode, parentTitle: string): boolean => {
    const seen = new Set<string>();
    let title: string | undefined = parentTitle;
    while (title !== undefined && !seen.has(title)) {
      if (title === node.page.frontmatter.title) return true;
      seen.add(title);
      title = byTitle.get(title)?.page.frontmatter.parent;
    }
    return false;
  };

  for (const node of byTitle.values()) {
    const parentTitle = node.page.frontmatter.parent;
    if (parentTitle && byTitle.has(parentTitle) && !wouldCycle(node, parentTitle)) {
      byTitle.get(parentTitle)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortChildren = (nodes: NavNode[]) => {
    nodes.sort(
      (a, b) => (a.page.frontmatter.nav_order ?? 999) - (b.page.frontmatter.nav_order ?? 999),
    );
    nodes.forEach((n) => sortChildren(n.children));
  };
  sortChildren(roots);

  return roots;
}
