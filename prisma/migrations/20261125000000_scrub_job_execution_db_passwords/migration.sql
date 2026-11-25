-- Scrub plaintext dbPassword values from historical JobExecution payloads (#108).
-- Uses PostgreSQL JSONB path removal because Prisma updateMany cannot delete nested JSON keys.
UPDATE "job_executions"
SET "payload" = "payload" #- '{cyberpanel,dbPassword}'
WHERE "payload" IS NOT NULL
  AND ("payload" #>> '{cyberpanel,dbPassword}') IS NOT NULL;
