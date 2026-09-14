import { sphinxMatches, type SphinxIndex } from "./sphinx.ts";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../util/json.ts";

export type DocumentationEngine = "gamemaker" | "godot";
export interface DocumentationPage {
  schemaVersion: 1;
  url: string;
  title: string;
  engine: DocumentationEngine;
  requestedVersion: string;
  version: string;
  fallback: boolean;
  retrievedAt: string;
  contentHash: string;
  text: string;
  cached?: boolean;
}
const hash = (s: string): string =>
  createHash("sha256").update(s).digest("hex");
export function documentationRoot(
  engine: DocumentationEngine,
  requested: string,
): { url: string; version: string; fallback: boolean } {
  if (engine === "gamemaker")
    return {
      url: "https://manual.gamemaker.io/monthly/en/",
      version: "monthly",
      fallback: requested !== "monthly",
    };
  const match = /^(\d+\.\d+)(?:\.|$)/.exec(requested);
  const version = match?.[1] ?? "stable";
  return {
    url: `https://docs.godotengine.org/en/${version}/`,
    version,
    fallback: version === "stable" && requested !== "stable",
  };
}
function decode(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}
export class DocumentationService {
  private receipts = new Map<string, DocumentationPage>();
  hasCitation(citation: {
    url: string;
    title: string;
    version: string;
    contentHash: string;
    retrievedAt: string;
  }): boolean {
    const page = this.receipts.get(citation.url);
    return (
      !!page &&
      page.title === citation.title &&
      page.version === citation.version &&
      page.contentHash === citation.contentHash &&
      page.retrievedAt === citation.retrievedAt
    );
  }
  readonly cacheDir: string;
  readonly versions: Record<DocumentationEngine, string>;
  readonly fetcher: typeof fetch;
  constructor(
    cacheDir: string,
    versions: Record<DocumentationEngine, string>,
    fetcher: typeof fetch = fetch,
  ) {
    this.cacheDir = cacheDir;
    this.versions = versions;
    this.fetcher = fetcher;
  }
  private validate(engine: DocumentationEngine, url: string): URL {
    const root = documentationRoot(engine, this.versions[engine]);
    const parsed = new URL(url);
    if (
      !parsed.href.startsWith(root.url) ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.hash ||
      parsed.search
    )
      throw new Error(
        "Documentation URL must be in the selected official documentation version",
      );
    return parsed;
  }
  private async download(url: string, signal?: AbortSignal): Promise<string> {
    const response = await this.fetcher(url, {
      redirect: "error",
      signal: signal ?? AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw new Error(`Documentation unavailable (${response.status})`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Documentation response has no body");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 10_000_000)
          throw new Error("Documentation response too large");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  async read(
    engine: DocumentationEngine,
    url: string,
    signal?: AbortSignal,
  ): Promise<DocumentationPage> {
    this.validate(engine, url);
    const file = join(this.cacheDir, `${hash(url)}.json`);
    const cached = (): DocumentationPage | undefined => {
      if (!existsSync(file)) return undefined;
      const page = JSON.parse(readFileSync(file, "utf8")) as DocumentationPage;
      if (
        page.schemaVersion !== 1 ||
        page.url !== url ||
        page.contentHash !== hash(page.text)
      )
        return undefined;
      return { ...page, cached: true };
    };
    const previous = cached();
    if (
      previous &&
      Date.now() - Date.parse(previous.retrievedAt) < 7 * 86_400_000
    ) {
      this.receipts.set(url, previous);
      return previous;
    }
    try {
      const html = await this.download(url, signal);
      const root = documentationRoot(engine, this.versions[engine]);
      const title = decode(
        /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? url,
      );
      const text = decode(
        html
          .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
          .replace(/<\/(p|div|h[1-6]|li|tr|pre)>/gi, "\n")
          .replace(/<[^>]+>/g, " "),
      )
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n/g, "\n")
        .trim();
      const page: DocumentationPage = {
        schemaVersion: 1,
        url,
        title,
        engine,
        requestedVersion: this.versions[engine],
        version: root.version,
        fallback: root.fallback,
        retrievedAt: new Date().toISOString(),
        contentHash: hash(text),
        text,
      };
      writeJsonAtomic(file, page);
      this.receipts.set(url, page);
      return page;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (previous) {
        this.receipts.set(url, previous);
        return previous;
      }
      throw error;
    }
  }
  async search(
    engine: DocumentationEngine,
    query: string,
    signal?: AbortSignal,
  ): Promise<
    { url: string; title: string; version: string; fallback: boolean }[]
  > {
    const root = documentationRoot(engine, this.versions[engine]);
    // The official GameMaker source tree supplies page identities when the manual sitemap is inaccessible.
    const indexUrl =
      engine === "godot"
        ? `${root.url}searchindex.js`
        : "https://api.github.com/repos/YoYoGames/GameMaker-Manual/git/trees/develop?recursive=1";
    const cache = join(this.cacheDir, `${hash(indexUrl)}.index.json`);
    let body: string;
    try {
      const saved = existsSync(cache)
        ? (JSON.parse(readFileSync(cache, "utf8")) as {
            body: string;
            retrievedAt: string;
          })
        : undefined;
      body =
        saved && Date.now() - Date.parse(saved.retrievedAt) < 86_400_000
          ? saved.body
          : await this.download(indexUrl, signal);
      writeJsonAtomic(cache, { body, retrievedAt: new Date().toISOString() });
    } catch (error) {
      if (signal?.aborted || !existsSync(cache)) throw error;
      body = (JSON.parse(readFileSync(cache, "utf8")) as { body: string }).body;
    }
    const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
    if (!terms.length) return [];
    const matches = new Map<string, number>();
    const urls =
      engine === "gamemaker"
        ? (() => {
            const tree = JSON.parse(body) as {
              truncated?: boolean;
              tree?: { path: string; type: string }[];
            };
            if (tree.truncated)
              throw new Error("Official manual tree was incomplete");
            return (tree.tree ?? [])
              .filter(
                (entry) =>
                  entry.type === "blob" &&
                  entry.path.startsWith("Manual/contents/") &&
                  /\.html?$/.test(entry.path),
              )
              .map(
                (entry) =>
                  root.url + entry.path.slice("Manual/contents/".length),
              );
          })()
        : (() => {
            const value = JSON.parse(
              body.replace(/^Search\.setIndex\(/, "").replace(/\);?\s*$/, ""),
            ) as SphinxIndex;
            for (const [name, score] of sphinxMatches(value, query))
              matches.set(`${root.url}${name}.html`, score);
            return (value.docnames ?? []).map(
              (name) => `${root.url}${name}.html`,
            );
          })();
    return urls
      .filter((url) => url.startsWith(root.url))
      .map((url) => ({
        url,
        title: decodeURIComponent(url.split("/").at(-1) ?? "")
          .replace(/\.html?$/, "")
          .replace(/[_-]/g, " "),
        version: root.version,
        fallback: root.fallback,
      }))
      .map((page) => ({
        page,
        score:
          (matches.get(page.url) ?? 0) +
          terms.filter((term) => page.url.toLowerCase().includes(term)).length,
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.page.url.localeCompare(b.page.url))
      .slice(0, 20)
      .map((x) => x.page);
  }
}
