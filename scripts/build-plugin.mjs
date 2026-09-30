// Builds an installable Expanso Fleet plugin folder for a given MCP server URL,
// and optionally installs it into the personal plugin marketplace.
//
//   node scripts/build-plugin.mjs --mcp-url https://<service>/mcp [--out DIR] [--install]
//
// Without --mcp-url, the URL comes from EXPANSO_FLEET_MCP_URL or from
// .pilot/state.json, which scripts/deploy-pilot.mjs writes. The service URL is
// never committed: it only appears in the generated plugin folder.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const root = resolve(import.meta.dirname, "..");

const { values } = parseArgs({
  options: {
    "mcp-url": { type: "string" },
    out: { type: "string" },
    install: { type: "boolean", default: false },
  },
});

const mcpUrl =
  values["mcp-url"] ?? process.env.EXPANSO_FLEET_MCP_URL ?? (await pilotUrl());

if (!mcpUrl) {
  fail("Pass --mcp-url https://<service>/mcp, or deploy the pilot first.");
}

const parsed = new URL(mcpUrl);

if (parsed.protocol !== "https:" || !parsed.pathname.endsWith("/mcp")) {
  fail("The MCP URL must be an https URL ending in /mcp.");
}

const out = resolve(
  values.out ?? join(root, "dist", "plugin", "expanso-fleet"),
);

await rm(out, { recursive: true, force: true });

await mkdir(out, { recursive: true });

await cp(join(root, "plugin"), out, {
  recursive: true,
  filter: (source) => !source.endsWith("mcp.template.json"),
});

const template = await readFile(
  join(root, "plugin", "mcp.template.json"),
  "utf8",
);

await writeFile(
  join(out, "mcp.json"),
  template.replace("__EXPANSO_FLEET_MCP_URL__", parsed.href),
);

console.log(`Built the Expanso Fleet plugin in ${out}`);

if (values.install) await install(out);

async function install(source) {
  const home = homedir();
  const target = join(home, ".codex", "plugins", "expanso-fleet");
  const marketplacePath = join(home, ".agents", "plugins", "marketplace.json");

  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true });

  const marketplace = existsSync(marketplacePath)
    ? JSON.parse(await readFile(marketplacePath, "utf8"))
    : { name: "personal", interface: { displayName: "Personal" }, plugins: [] };

  const entry = {
    name: "expanso-fleet",
    // Personal marketplace paths resolve from the home directory.
    source: { source: "local", path: "./.codex/plugins/expanso-fleet" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Developer Tools",
  };

  marketplace.plugins = [
    ...(marketplace.plugins ?? []).filter(
      (plugin) => plugin.name !== entry.name,
    ),
    entry,
  ];

  await mkdir(join(home, ".agents", "plugins"), { recursive: true });
  await writeFile(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);

  console.log(`Installed to ${target}`);
  console.log(`Added expanso-fleet to ${marketplacePath}`);
  console.log(
    "Restart the ChatGPT desktop app to see it in the Plugins Directory.",
  );
}

async function pilotUrl() {
  const state = join(root, ".pilot", "state.json");

  if (!existsSync(state)) return undefined;

  const { url } = JSON.parse(await readFile(state, "utf8"));

  return url ? `${url}/mcp` : undefined;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
