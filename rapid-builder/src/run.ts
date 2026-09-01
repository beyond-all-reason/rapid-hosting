import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { text } from "node:stream/consumers";

/** Sink for a build transcript, one line at a time. */
export type Log = (line: string) => void;

export interface RunOptions {
	cwd?: string;
	env?: Record<string, string>;
	/** Sink for the command line and merged output; without it stdout is captured. */
	log?: Log;
	/** Throws when command doesn't return 0, default: true */
	check?: boolean;
	/** Written to stdin. */
	input?: string;
	/** Default: 60m */
	timeout?: number;
}

/** Runs a command, streaming its output to a log or capturing stdout. */
export async function run(
	command: string,
	args: string[],
	opts: RunOptions = {},
): Promise<{ exitCode: number; stdout: string }> {
	opts.log?.(`$ ${command} ${args.join(" ")}`);
	const proc = spawn(command, args, {
		cwd: opts.cwd,
		env: {
			...process.env,
			// Doesn't make sense to repeat those envs in all callers for our use case.
			GIT_TERMINAL_PROMPT: "0",
			LC_ALL: "C",
			...opts.env,
		},
		stdio: ["pipe", "pipe", "pipe"],
		// Own group, so a timeout kills grandchildren too: they inherit the pipes,
		// and "close" waits for the last of them.
		detached: true,
	});

	// Not spawn's timeout option: it kills only the child, and its timer stays
	// armed when the command never starts, holding the event loop open.
	const kill = (signal: NodeJS.Signals) => {
		try {
			// negative pid means kill the whole group
			if (proc.pid) process.kill(-proc.pid, signal);
		} catch {
			// already gone
		}
	};
	let escalation: NodeJS.Timeout | undefined;
	const timer = setTimeout(
		() => {
			kill("SIGTERM");
			escalation = setTimeout(() => kill("SIGKILL"), 30 * 1000);
		},
		opts.timeout ?? 60 * 60 * 1000,
	);

	// Failing to write to stdin is non-critical and we need to swallow it
	// to avoid getting uncaught exception.
	proc.stdin.on("error", () => {});
	proc.stdin.end(opts.input);

	if (opts.log) {
		createInterface({ input: proc.stdout }).on("line", opts.log);
		createInterface({ input: proc.stderr }).on("line", opts.log);
	}
	const [, stdout, stderr] = await Promise.all([
		once(proc, "close"),
		opts.log ? "" : text(proc.stdout),
		opts.log ? "" : text(proc.stderr),
	]).finally(() => {
		clearTimeout(timer);
		clearTimeout(escalation);
	});
	if ((opts.check ?? true) && proc.exitCode !== 0) {
		const stderrText = stderr.trim();
		const tail = stderrText ? `: ${stderrText.slice(-500)}` : "";
		throw new Error(`${command} exited with ${proc.exitCode ?? proc.signalCode}${tail}`);
	}
	return { exitCode: proc.exitCode ?? -1, stdout };
}
