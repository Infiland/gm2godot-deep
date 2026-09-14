import type { OpenCodeModel } from "../agents/external/opencode.ts";
export const ZEN_PRICING_URL = "https://opencode.ai/docs/zen/";
export interface ZenPricing {
  name: string;
  prices: readonly string[];
}
const text = (s: string): string =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .trim();
/** Parse only the official pricing table, never marketing prose or model ids containing 'free'. */
export function parseZenPricing(html: string): ZenPricing[] {
  const section = html
    .split(/<h2[^>]+id="pricing"[^>]*>/)[1]
    ?.split(/<h2[\s>]/)[0];
  if (!section) return [];
  const table = /<table[^>]*>([\s\S]*?)<\/table>/.exec(section)?.[1] ?? "";
  const headers = [...table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) =>
    text(m[1] ?? ""),
  );
  if (headers.join("|") !== "Model|Input|Output|Cached Read|Cached Write")
    return [];
  return [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((m) =>
      [...m[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) =>
        text(c[1] ?? ""),
      ),
    )
    .filter((c) => c.length === 5)
    .map((c) => ({ name: c[0]!, prices: c.slice(1) }));
}
export async function verifyZenCatalog(
  models: readonly OpenCodeModel[],
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<OpenCodeModel[]> {
  const response = await fetcher(ZEN_PRICING_URL, {
    redirect: "error",
    signal,
  });
  if (!response.ok)
    throw new Error("Official Zen pricing is unavailable; free mode paused");
  const html = await response.text();
  if (html.length > 2_000_000)
    throw new Error("Official Zen pricing page exceeded size limit");
  const published = parseZenPricing(html);
  return models
    .filter((model) => {
      const row = published.find(
        (p) => p.name.toLowerCase() === model.name.toLowerCase(),
      );
      if (!row) return false;
      // A dash explicitly marks inapplicable cache pricing, never missing input/output pricing.
      return row.prices.every(
        (price, i) =>
          price.toLowerCase() === "free" ||
          /^\$?0(?:\.0+)?$/.test(price) ||
          (i >= 2 && price === "-"),
      );
    })
    .map((model) => ({
      ...model,
      pricingVerifiedAt: new Date().toISOString(),
      pricingSource: ZEN_PRICING_URL,
    }));
}
