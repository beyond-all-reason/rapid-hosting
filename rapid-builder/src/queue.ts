import * as metrics from "./metrics.ts";

export class QueueFullError extends Error {}

interface Queue {
	/** Resolves when the last build in the queue finishes. */
	tail: Promise<void>;
	/** Number of builds in the chain, head included. */
	active: number;
}

/** Serializes builds per repo, with a bound on how many may wait. */
export class ReposQueue {
	#maxWaiting: number;
	#queues = new Map<string, Queue>();

	constructor(maxWaiting: number) {
		this.#maxWaiting = maxWaiting;
	}

	/**
	 * Runs fn once every earlier build of the repo finished.
	 *
	 * Rejects with QueueFullError, before taking a slot, when too many builds are
	 * already waiting.
	 */
	async run<T>(repoName: string, fn: () => Promise<T>): Promise<T> {
		if (this.isFull(repoName)) throw new QueueFullError();
		const queue = this.#queues.get(repoName) ?? {
			tail: Promise.resolve(),
			active: 0,
		};
		this.#queues.set(repoName, queue);

		queue.active++;
		this.#report(repoName, queue);
		const endWait = metrics.queueWait.startTimer({ repo: repoName });
		const result = queue.tail.then(() => {
			endWait();
			return fn();
		});
		// `leave` runs always on both outcomes and ignores the result
		// so next promise in chain always starts.
		const leave = () => {
			queue.active--;
			this.#report(repoName, queue);
		};
		queue.tail = result.then(leave, leave);
		return await result;
	}

	isFull(repoName: string): boolean {
		return (this.#queues.get(repoName)?.active ?? 0) > this.#maxWaiting;
	}

	#report(repoName: string, entry: Queue): void {
		metrics.queuedBuilds.set({ repo: repoName, state: "running" }, Math.min(entry.active, 1));
		metrics.queuedBuilds.set(
			{ repo: repoName, state: "waiting" },
			Math.max(entry.active - 1, 0),
		);
	}
}
