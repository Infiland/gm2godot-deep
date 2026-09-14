import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(new URL(".", import.meta.url).pathname, "..");
const providersDir = join(
  root,
  "node_modules",
  "@earendil-works",
  "pi-ai",
  "dist",
  "providers",
);
const authDir =
  process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const authPath = join(authDir, "auth.json");

function authProviders() {
  if (!existsSync(authPath)) return [];
  try {
    const value = JSON.parse(readFileSync(authPath, "utf8"));
    if (!value || typeof value !== "object") return [];
    const entries =
      value.providers && typeof value.providers === "object"
        ? value.providers
        : value;
    return Object.keys(entries).sort();
  } catch {
    return [];
  }
}

function providerFiles() {
  if (!existsSync(providersDir)) return [];
  return readdirSync(providersDir).filter(
    (name) =>
      name.endsWith(".js") || name.endsWith(".mjs") || name.endsWith(".ts"),
  );
}

const configured = new Set(authProviders());
const providers = [];
for (const file of providerFiles()) {
  const id = file.replace(/\.(?:m?js|ts)$/, "");
  try {
    const module = await import(pathToFileURL(join(providersDir, file)).href);
    const factory = Object.entries(module).find(
      ([name, value]) =>
        name.endsWith("Provider") && typeof value === "function",
    )?.[1];
    if (typeof factory !== "function") continue;
    const provider = factory();
    const models =
      typeof provider?.getModels === "function"
        ? await provider.getModels()
        : [];
    providers.push({
      id: provider?.id || id,
      configured: configured.has(provider?.id || id),
      models: Array.isArray(models)
        ? models
            .map((model) => ({ id: model.id, name: model.name }))
            .filter((model) => typeof model.id === "string")
        : [],
    });
  } catch {
    /* an unavailable optional provider is omitted, never guessed */
  }
}
for (const id of configured)
  if (!providers.some((provider) => provider.id === id))
    providers.push({ id, configured: true, models: [] });
providers.sort((a, b) => a.id.localeCompare(b.id));
process.stdout.write(
  JSON.stringify({
    providers,
    authFilePresent: existsSync(authPath),
    network: false,
  }),
);
