// Prints a valid token for service in sandbox.
//
// Arguments are "<name>=<value>" claims, see docs/sandbox.md.

const query = new URLSearchParams();
for (const arg of process.argv.slice(2)) {
	const at = arg.indexOf("=");
	if (at < 0) {
		console.error(`Arguments are <name>=<value> claims, got ${arg}`);
		process.exit(1);
	}
	query.set(arg.slice(0, at), arg.slice(at + 1));
}

const issuerUrl = process.env.ISSUER_URL ?? "http://127.0.0.1:8444";
const res = await fetch(`${issuerUrl}/token?${query}`);
if (!res.ok) {
	console.error(`${issuerUrl} answered ${res.status}: ${await res.text()}`);
	process.exit(1);
}
process.stdout.write((await res.text()).trim());
