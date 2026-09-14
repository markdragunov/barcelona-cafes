/**
 * Shared helpers for long-running admin jobs (collect / coffee / index).
 * Job status stays in process memory; a JSONL history file survives restarts
 * without a production schema change.
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "./config.js";

export function pushJobLog(job, entry) {
  if (!job) return;
  job.logs = job.logs || [];
  job.logs.push({ at: new Date().toISOString(), ...entry });
  if (job.logs.length > 500) {
    job.logs = job.logs.slice(-400);
  }
}

export function finishJob(job, { error = null, result } = {}) {
  if (!job) return;
  job.running = false;
  job.finishedAt = new Date().toISOString();
  if (error) {
    job.error = typeof error === "string" ? error : error.message || String(error);
  }
  if (result !== undefined) job.result = result;
}

/** Send 202, then run the job off the request so a later throw cannot hang the handler. */
export function acceptAndRun(res, body, work) {
  res.status(202).json(body);
  setImmediate(() => {
    Promise.resolve()
      .then(work)
      .catch((err) => {
        console.error(
          JSON.stringify({
            msg: "background_job_unhandled",
            error: err?.message || String(err),
          })
        );
      });
  });
}

export async function persistJobRecord(name, snapshot) {
  try {
    const dir = getDataDir();
    await mkdir(dir, { recursive: true });
    const line = JSON.stringify({
      name,
      running: snapshot?.running ?? false,
      startedAt: snapshot?.startedAt ?? null,
      finishedAt: snapshot?.finishedAt ?? null,
      error: snapshot?.error ?? null,
      result: snapshot?.result ?? null,
      at: new Date().toISOString(),
    });
    await appendFile(path.join(dir, "jobs.jsonl"), `${line}\n`);
  } catch (err) {
    console.error(
      JSON.stringify({
        msg: "job_persist_failed",
        error: err?.message || String(err),
      })
    );
  }
}
