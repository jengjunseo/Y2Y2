import { sleep } from "workflow";
import { del } from "@vercel/blob";
import { expireArtifact } from "../relay/core.js";
import { getJob, redis } from "./_relay.js";

export async function expireRelayArtifact(jobId, pathname, expiresAt) {
  "use workflow";
  await sleep(new Date(Number(expiresAt)));
  await deleteRelayArtifactStep(jobId, pathname, Number(expiresAt));
}

export async function deleteRelayArtifactStep(jobId, pathname, expiresAt) {
  "use step";
  await expireArtifact({
    expiresAt,
    deleteBlob: async () => {
      await del(pathname).catch((error) => {
        if (!/not found|404/i.test(String(error?.message || error))) throw error;
      });
    },
    markExpired: async () => {
      const job = await getJob(jobId);
      if (!job) return;
      await redis(["HSET", `y2y2:job:${jobId}`, "status", "expired", "stage", "expired", "updatedAt", String(Date.now())]);
      await redis(["EXPIRE", `y2y2:job:${jobId}`, "86400"]);
    },
  });
}
