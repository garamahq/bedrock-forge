import type { JobsOptions, Queue } from "bullmq";

export async function removeBullScheduler(
  queue: Queue,
  schedulerId: string,
): Promise<void> {
  if (typeof queue.removeJobScheduler === "function") {
    await queue.removeJobScheduler(schedulerId);
  }

  // Clean up any legacy repeatable registrations that bullmq@5.81.5 stores without `id`
  if (typeof queue.getJobSchedulers === "function") {
    const schedulers = await queue.getJobSchedulers();
    for (const sched of schedulers) {
      if (sched?.id === schedulerId || sched?.key === schedulerId) {
        const keyToRemove = sched.key ?? sched.id;
        if (keyToRemove && typeof queue.removeJobScheduler === "function") {
          await queue.removeJobScheduler(keyToRemove);
        }
      }
    }
  }

  if (typeof queue.getRepeatableJobs === "function") {
    const repeatableJobs = await queue.getRepeatableJobs();
    for (const rj of repeatableJobs) {
      if (rj.id === schedulerId || rj.key?.includes(schedulerId)) {
        await queue.removeRepeatableByKey(rj.key);
      }
    }
  }
}

export async function syncBullScheduler<T extends Record<string, unknown>>(opts: {
  queue: Queue;
  schedulerId: string;
  enabled: boolean;
  pattern: string;
  jobName: string;
  data: T;
  jobOpts?: JobsOptions;
}): Promise<void> {
  const { queue, schedulerId, enabled, pattern, jobName, data, jobOpts } = opts;
  await removeBullScheduler(queue, schedulerId);
  if (!enabled) return;

  await queue.upsertJobScheduler(
    schedulerId,
    { pattern },
    {
      name: jobName,
      data,
      opts: jobOpts,
    },
  );
}
