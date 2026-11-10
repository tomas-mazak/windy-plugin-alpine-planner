// Folding work on the main thread, in time slices, so dragging the window and panning stay smooth. All sources share
// one queue, lowest step index first: every tile shows its first step soon. A job runs until it's done or the slice
// deadline passes (a corrected tile-step is split by rows) and is then resumed in the next slice.

const SLICE_MS = 8;

// Returns true when done, false to be resumed.
export type FoldJob = (deadline: number) => boolean;

const queue: { step: number; run: FoldJob; spentMs: number }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

export type FoldQueueStats = { queued: number; lastJobMs: number | null; maxJobMs: number; maxSliceMs: number };
const stats: FoldQueueStats = { queued: 0, lastJobMs: null, maxJobMs: 0, maxSliceMs: 0 };

export function queueFold(step: number, run: FoldJob): void {
    const i = queue.findIndex(job => job.step > step);
    queue.splice(i < 0 ? queue.length : i, 0, { step, run, spentMs: 0 });
    timer ??= setTimeout(runSlice, 0);
}

function runSlice(): void {
    timer = null;
    const start = performance.now();
    const deadline = start + SLICE_MS;
    while (queue.length > 0 && performance.now() < deadline) {
        const job = queue[0];
        const t0 = performance.now();
        const done = job.run(deadline);
        job.spentMs += performance.now() - t0;
        if (done) {
            queue.shift();
            stats.lastJobMs = job.spentMs;
            stats.maxJobMs = Math.max(stats.maxJobMs, job.spentMs);
        }
    }
    stats.maxSliceMs = Math.max(stats.maxSliceMs, performance.now() - start);
    if (queue.length > 0) {
        timer = setTimeout(runSlice, 0);
    }
}

export const foldQueueStats = (): FoldQueueStats => ({ ...stats, queued: queue.length });
