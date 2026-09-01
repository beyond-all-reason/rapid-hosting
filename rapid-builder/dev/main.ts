// Runs a sandbox so compose can point the real service at it.
//
// Basically dev/sandbox.ts on fixed ports and in a directory
//
// compose mounts BASE_CONFIG at /base-config.json, or /dev/null for none.

import { readFile } from "node:fs/promises";
import { type BaseConfig, startSandbox } from "./sandbox.ts";

const raw = await readFile("/base-config.json", "utf8");
const baseConfig: BaseConfig | undefined = raw.trim() ? JSON.parse(raw) : undefined;

const sandbox = await startSandbox({
	dir: "/sandbox",
	originDir: "/origin",
	baseConfig,
	publicHost: process.env.SANDBOX_PUBLIC_HOST ?? "127.0.0.1",
	bindHost: "0.0.0.0",
	ports: { storage: 8443, edge: 8081, oidc: 8444 },
});

console.log("Sandbox up.");
if (sandbox.bunny) {
	console.log(`  storage  ${sandbox.bunny.config.storageUrl}`);
	console.log(`  cdn      ${sandbox.bunny.config.baseUrl}`);
	console.log(`  api      ${sandbox.bunny.config.apiUrl}`);
} else {
	console.log("  bunny    the real one your config names");
}
if (sandbox.oidc) console.log(`  issuer   ${sandbox.oidc.issuer}`);
console.log("Environment for the service:");
for (const [name, value] of Object.entries(sandbox.env)) console.log(`  ${name}=${value}`);

// When both fakes are off there is no server left to keep the event loop
// running, and compose stops as soon as this exits. A timer holds the process
// open until a signal ends it.
const alive = setInterval(() => {}, 1 << 30);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.once(signal, () => {
		clearInterval(alive);
		sandbox.close();
		process.exit(0);
	});
}
