# Runbook: Degraded Health / Service Unavailable

**Alert**: `GET /health` returns 503 or `GET /health/details` shows
`"status": "degraded"`

---

## Triage Steps

### 1. Check component status

```bash
curl -s https://<forge_host>/health | jq .
# Expected: {"status":"ok"}
# If degraded, call /health/details with admin JWT for details
```

### 2. Database down

Symptoms: `components.db.status == "error"` in `/health/details`

```bash
docker compose logs postgres --tail 50
docker compose ps postgres
# Restart if unhealthy:
docker compose restart postgres
# Check disk space (most common cause):
df -h /var/lib/docker
```

### 3. Redis down

Symptoms: `components.redis.status == "error"` in `/health/details`

```bash
docker compose logs redis --tail 50
docker compose restart redis
```

### 4. Queue depth spike

Symptoms: `queues.backups.waiting > 100` or `queues.security.failed > 0`

```bash
# Check worker logs
docker compose logs forge --tail 100 | grep -i "worker\|error\|fail"
# Restart worker (graceful — 30s stop_grace_period)
docker compose restart forge
```

### 5. Memory pressure

Symptoms: `memory.heap_used_mb` close to `memory.heap_total_mb` in
`/health/details`

```bash
docker compose stats forge --no-stream
# Increase NODE_OPTIONS max-old-space-size in docker-compose.yml if needed
# Current cap: 768 MB (NODE_OPTIONS: '--max-old-space-size=768')
```

## Monitor alert verification

An uptime monitor retries a failed HTTP probe after five seconds. If a monitor
was down, recovery requires two consecutive successful probes, five seconds
apart, before the `monitor.up` transition is recorded. This avoids treating one
transient response as recovery.

When an alert looks false:

1. Open **Monitors -> the monitor** and compare the latest rows in its response
   history table, including probe times and HTTP status codes.
2. Open **Activity** and inspect the monitor job execution log for messages
   about the retry or recovery confirmation.
3. Check DNS and reachability from the Forge worker's network path. A local
   browser test can use a different route to the site.
4. If the probes disagree or the problem repeats, keep the monitor enabled and
   record the timestamps and statuses for investigation; do not infer recovery
   from a single successful request.

---

## Escalation

If the service does not recover within 10 minutes after restarting affected
components:

1. Take a heap dump: `docker compose exec forge kill -USR2 1`
2. Collect logs: `docker compose logs forge > /tmp/forge-$(date +%s).log`
3. File an incident issue with logs attached
