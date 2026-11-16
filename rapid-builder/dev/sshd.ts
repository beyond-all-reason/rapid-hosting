// Fake GitHub SSH server. It serves the git repositories on disk to one deploy
// key, and has its own host key.
//
// It runs unprivileged, so clients can log in only as the user running it.

import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { userInfo } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const SSHD = "/usr/sbin/sshd";

export const sshdMissing = () =>
	!existsSync(SSHD) && `${SSHD} is not available, run \`npm run test:e2e\` to get it`;

export type FakeSshd = Awaited<ReturnType<typeof startSshd>>;

/** Generates a passphrase-less ed25519 key pair at file and file.pub. */
export function sshKeygen(file: string): void {
	execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", file]);
}

export async function startSshd(dir: string) {
	await mkdir(dir, { recursive: true });
	const hostKey = path.join(dir, "host_key");
	/** The deploy key the server accepts. */
	const keyFile = path.join(dir, "deploy_key");
	sshKeygen(hostKey);
	sshKeygen(keyFile);
	const authorizedKeys = path.join(dir, "authorized_keys");
	await writeFile(authorizedKeys, `restrict ${await readFile(`${keyFile}.pub`, "utf8")}`);
	const config = path.join(dir, "sshd_config");
	await writeFile(
		config,
		`HostKey "${hostKey}"
AuthorizedKeysFile "${authorizedKeys}"
AuthenticationMethods publickey
UsePAM no
StrictModes no
`,
	);

	// sshd can't listen on port 0, so it would need a free port picked in
	// advance, which another process could take before sshd binds it. Instead
	// we listen on port 0 ourselves and hand each connection to its own
	// `sshd -i`, which speaks SSH over the socket it gets as stdin and stdout.
	/** sshd's own log, e.g. its "Accepted publickey" lines. */
	const log: string[] = [];
	const server = createServer((socket) => {
		const proc = spawn(SSHD, ["-i", "-e", "-f", config], { stdio: [socket, socket, "pipe"] });
		createInterface({ input: proc.stderr }).on("line", (line) => log.push(line));
		proc.once("exit", () => socket.destroy());
	}).listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as AddressInfo;

	/** known_hosts that trusts only this server's host key. */
	const knownHostsFile = path.join(dir, "known_hosts");
	const hostPub = (await readFile(`${hostKey}.pub`, "utf8")).trim();
	await writeFile(knownHostsFile, `[127.0.0.1]:${port} ${hostPub}\n`);

	return {
		/** "ssh" for a repo config: it logs in to this server and trusts only it. */
		ssh: { keyFile, knownHostsFile },
		log,
		/** SSH URL of the repository at repoDir. */
		url: (repoDir: string) => `ssh://${userInfo().username}@127.0.0.1:${port}${repoDir}`,
		close: () => void server.close(),
	};
}
