import { type Logger, pino } from "pino";
import { z } from "zod";

const env = z
	.object({
		LOG_LEVEL: z
			.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
			.default("info"),
	})
	.parse(process.env);

/**
 * Writes one JSON object per line to stdout.
 *
 * Level names and ISO timestamps instead of pino's numeric levels and epoch
 * millis, so logs stays readable without a pretty printer.
 */
export const logger = pino({
	level: env.LOG_LEVEL,
	timestamp: pino.stdTimeFunctions.isoTime,
	formatters: { level: (label) => ({ level: label }) },
	// Drops pino's pid and hostname: we run one process per container, the
	// collector already knows which one it reads.
	base: undefined,
});

export type { Logger };
