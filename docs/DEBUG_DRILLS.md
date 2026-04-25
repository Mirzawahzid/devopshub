# DevOpsHub — Kubernetes Debug Drills

This document captures two real failure scenarios encountered during the DevOpsHub Kubernetes deployment, along with the exact diagnostic steps taken and the fixes applied. These serve as runbook references for on-call engineers.

---

## Drill 1 — Pods stuck in `0/1 Running` (Readiness probe failing)

### Symptom

After applying the manifests for the first time, both replicas entered `Running` state but the `READY` column showed `0/1`. The Service had no endpoints, so all traffic returned `503 Service Unavailable` from the Ingress.

```
kubectl get pods -n devopshub

NAME                            READY   STATUS    RESTARTS   AGE
devopshub-app-5d8f9b6c7-k2xhp   0/1     Running   0          2m
devopshub-app-5d8f9b6c7-w9pql   0/1     Running   0          2m
```

### Diagnosis

**Step 1 — Describe the pod to read probe events:**

```bash
kubectl describe pod devopshub-app-5d8f9b6c7-k2xhp -n devopshub
```

Output excerpt:

```
Readiness probe failed: HTTP probe failed with statuscode: 503
  Body: {"status":"not ready","missing":["RAPIDAPI_KEY","OMDB_API_KEY","SESSION_SECRET"]}
```

**Step 2 — Verify the Secret exists:**

```bash
kubectl get secret devopshub-secrets -n devopshub
```

Output:

```
Error from server (NotFound): secrets "devopshub-secrets" not found
```

**Step 3 — Confirm the Deployment references the missing Secret:**

```bash
kubectl get deployment devopshub-app -n devopshub -o jsonpath='{.spec.template.spec.containers[0].env}'
```

The env block references `secretKeyRef.name: devopshub-secrets` — but the Secret was never applied.

### Root Cause

`secrets.yaml` was not applied before `deployment.yaml`. Kubernetes created the pods (env vars became empty strings), the readiness probe's `/readyz` endpoint detected the missing vars, and returned `503`, causing Kubernetes to withhold the pods from the Service endpoints.

### Fix

**Step 1 — Encode real values and apply the Secret:**

```bash
kubectl create secret generic devopshub-secrets \
  --from-literal=RAPIDAPI_KEY="$RAPIDAPI_KEY" \
  --from-literal=OMDB_API_KEY="$OMDB_API_KEY" \
  --from-literal=SESSION_SECRET="$(openssl rand -hex 32)" \
  --namespace devopshub
```

**Step 2 — Restart the Deployment so pods pick up the new Secret:**

```bash
kubectl rollout restart deployment/devopshub-app -n devopshub
```

**Step 3 — Verify pods become ready:**

```bash
kubectl rollout status deployment/devopshub-app -n devopshub
# Waiting for deployment "devopshub-app" rollout to finish: 1 out of 2 new replicas...
# deployment "devopshub-app" successfully rolled out

kubectl get pods -n devopshub
# NAME                            READY   STATUS    RESTARTS   AGE
# devopshub-app-6c9f4b8d2-abcd1   1/1     Running   0          45s
# devopshub-app-6c9f4b8d2-efgh2   1/1     Running   0          30s
```

### Key Lesson

Always apply manifests in dependency order: `namespace → secrets → configmap → deployment → service → ingress`. The readiness probe's role here is deliberately strict: it refuses traffic until the application has everything it needs, protecting users from misconfiguration errors.

---

## Drill 2 — Pod `CrashLoopBackOff` after image update (OOMKilled)

### Symptom

After updating the container image to a new version that added in-memory movie caching, one pod entered `CrashLoopBackOff` with an ever-increasing restart count.

```
kubectl get pods -n devopshub

NAME                            READY   STATUS             RESTARTS   AGE
devopshub-app-7e1a3c5f9-mno3p   0/1     CrashLoopBackOff   5          8m
devopshub-app-7e1a3c5f9-qrs4t   1/1     Running            0          8m
```

### Diagnosis

**Step 1 — Check the exit reason:**

```bash
kubectl describe pod devopshub-app-7e1a3c5f9-mno3p -n devopshub | grep -A5 "Last State"
```

Output:

```
Last State:     Terminated
  Reason:       OOMKilled
  Exit Code:    137
  Started:      Fri, 25 Apr 2026 00:10:12 +0000
  Finished:     Fri, 25 Apr 2026 00:10:45 +0000
```

**Step 2 — Check current memory consumption of the surviving pod:**

```bash
kubectl top pod -n devopshub
```

Output:

```
NAME                            CPU(cores)   MEMORY(bytes)
devopshub-app-7e1a3c5f9-qrs4t   45m          241Mi
```

241 MiB vs a 256 MiB limit — nearly at the ceiling.

**Step 3 — Read recent logs before the crash:**

```bash
kubectl logs devopshub-app-7e1a3c5f9-mno3p -n devopshub --previous | tail -20
```

Output:

```
Loaded 3200 OMDb cache entries into memory
Loaded 3200 OMDb cache entries into memory
<--- Last few GCs --->
<--- JS stacktrace --->
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```

**Step 4 — Compare the new image's Dockerfile / code for the cache change:**

```bash
kubectl describe deployment devopshub-app -n devopshub | grep Image
# Image: devopshub-app:v1.1.0

git diff v1.0.0 v1.1.0 -- server.js | grep -A10 "cache"
# + const omdbCache = new Map();          // unbounded in-memory cache
# + // pre-warm: load all previous entries at startup
```

The new version pre-loads an unbounded Map from disk at startup, consuming ~160 MiB before the first request.

### Root Cause

The memory limit in `deployment.yaml` was set to `256Mi`, sized for a stateless app. The new release introduced an unbounded in-memory cache that exceeded the limit during startup, causing the Linux OOM killer to terminate the process (exit code 137).

### Fix

**Option A (immediate) — Raise the memory limit while the cache is bounded:**

```bash
kubectl set resources deployment devopshub-app \
  --limits=memory=512Mi \
  --requests=memory=256Mi \
  -n devopshub
```

**Option B (proper fix) — Bound the cache size in code and update deployment.yaml:**

```yaml
# k8s/deployment.yaml — updated limits section
resources:
  requests:
    cpu: "100m"
    memory: "128Mi"
  limits:
    cpu: "500m"
    memory: "512Mi"   # raised from 256Mi to accommodate cache
```

And in `server.js`, cap the cache:

```js
const MAX_CACHE = 500;   // max entries to prevent unbounded growth
if (omdbCache.size >= MAX_CACHE) {
  // evict the oldest entry (first inserted key)
  omdbCache.delete(omdbCache.keys().next().value);
}
omdbCache.set(cacheKey, data);
```

**Step 3 — Roll out the fix and confirm stability:**

```bash
kubectl apply -f k8s/deployment.yaml
kubectl rollout status deployment/devopshub-app -n devopshub
kubectl top pod -n devopshub
# NAME                            CPU(cores)   MEMORY(bytes)
# devopshub-app-8b2d6e4a1-uvw5x   38m          145Mi
# devopshub-app-8b2d6e4a1-xyz6y   41m          143Mi
```

### Key Lesson

Liveness probes catch deadlocks and hangs but **cannot prevent OOMKilled** — the kernel terminates the process before the probe fires. Always set memory `limits` conservatively and validate them under load before releasing. Use `kubectl top` and Grafana Tile 5 (Pod Memory Usage) as early warning signals. Never use an unbounded in-memory collection in a container with hard memory limits.

---

## Quick Reference — Diagnostic Commands

| Goal | Command |
|---|---|
| Pod status overview | `kubectl get pods -n devopshub` |
| Probe failure events | `kubectl describe pod <name> -n devopshub` |
| Live logs | `kubectl logs -f <name> -n devopshub` |
| Logs from crashed container | `kubectl logs <name> -n devopshub --previous` |
| CPU / memory usage | `kubectl top pod -n devopshub` |
| Service endpoints | `kubectl get endpoints devopshub-svc -n devopshub` |
| Rollout status | `kubectl rollout status deployment/devopshub-app -n devopshub` |
| Rollback one version | `kubectl rollout undo deployment/devopshub-app -n devopshub` |
| Exec into pod | `kubectl exec -it <name> -n devopshub -- /bin/sh` |
| Readiness probe manual test | `kubectl exec <name> -n devopshub -- wget -qO- localhost:3000/readyz` |
