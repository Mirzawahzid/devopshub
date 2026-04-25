# DevOpsHub — Design Document

**Version:** 1.0.0  
**Authors:** DevOpsHub Engineering Team  
**Date:** April 2026

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture Diagram](#2-architecture-diagram)
3. [Component Descriptions](#3-component-descriptions)
4. [Kubernetes Resource Topology](#4-kubernetes-resource-topology)
5. [Configuration & Secrets Strategy](#5-configuration--secrets-strategy)
6. [Health Probe Design](#6-health-probe-design)
7. [Scaling Strategy](#7-scaling-strategy)
8. [Observability & Monitoring](#8-observability--monitoring)
9. [CI/CD Pipeline](#9-cicd-pipeline)
10. [Security Considerations](#10-security-considerations)
11. [Dependency Map](#11-dependency-map)
12. [Future Improvements](#12-future-improvements)

---

## 1. Project Overview

DevOpsHub is a full-stack Node.js web application that proxies two external APIs:

1. **RapidAPI — AI Nutritional Facts** (`ai-nutritional-facts.p.rapidapi.com`) — Natural-language to nutrition data.
2. **OMDb API** (`www.omdbapi.com`) — Movie metadata and ratings.

It is deployed on Kubernetes with NGINX Ingress, provides JWT-style session authentication, and is instrumented for Prometheus/Grafana monitoring.

### Goals

- Zero-downtime rolling deployments
- High availability: 2 replicas across separate nodes
- Secrets never stored in plaintext in the repository
- Automated deployment via GitHub Actions CI/CD
- Observable via Grafana with meaningful alerting thresholds

---

## 2. Architecture Diagram

```
                         Internet
                            │
                     ┌──────▼──────┐
                     │  HTTPS/443  │
                     │ NGINX Ingress│
                     │  Controller  │
                     └──────┬──────┘
                            │ ClusterIP :80
                     ┌──────▼──────┐
                     │  devopshub  │
                     │    -svc     │
                     │  (Service)  │
                     └──────┬──────┘
                   ┌────────┴────────┐
            ┌──────▼──────┐   ┌──────▼──────┐
            │   Pod 1     │   │   Pod 2     │
            │ Node.js:3000│   │ Node.js:3000│
            │  (Replica 1)│   │  (Replica 2)│
            └──────┬──────┘   └──────┬──────┘
                   └────────┬────────┘
                            │ HTTPS (outbound)
              ┌─────────────┼──────────────┐
       ┌──────▼──────┐             ┌───────▼──────┐
       │  RapidAPI   │             │   OMDb API   │
       │ (Nutrition) │             │   (Movies)   │
       └─────────────┘             └──────────────┘

Legend:
  ──── Internal cluster traffic (ClusterIP)
  ════ External HTTPS traffic
  Namespace: devopshub
```

---

## 3. Component Descriptions

### Express Application (`server.js`)

| Route | Auth Required | Description |
|---|---|---|
| `GET /login.html` | No | Login page static asset |
| `POST /login` | No | Session creation (credential check) |
| `GET /logout` | Yes | Session destruction |
| `GET /movies*` | No | Movie app UI and API (public) |
| `GET /movies/api/search` | No | OMDb search by title |
| `GET /movies/api/ratings` | No | OMDb lookup by IMDb ID |
| `POST /api/nutritional-info` | Yes | RapidAPI proxy |
| `GET /healthz` | No | Kubernetes liveness probe |
| `GET /readyz` | No | Kubernetes readiness probe |
| `GET /*` | Yes | SPA static files |

### Static Assets (`public/`)

Single-page application frontend served by Express static middleware. No build step required.

### Session Management

Express-session with an in-memory store. Session secret loaded from Kubernetes Secret (`SESSION_SECRET`). Cookie TTL: 1 hour.

> **Production note:** Replace the in-memory session store with Redis for multi-replica sticky-session-free deployments.

---

## 4. Kubernetes Resource Topology

```
Namespace: devopshub
├── ConfigMap:  devopshub-config    (PORT, NODE_ENV, LOG_LEVEL, SESSION_MAX_AGE)
├── Secret:     devopshub-secrets   (RAPIDAPI_KEY, OMDB_API_KEY, SESSION_SECRET)
├── Secret:     devopshub-tls       (TLS cert + key for Ingress)
├── Deployment: devopshub-app       (2 replicas, rolling update)
│   └── Pod template
│       ├── Container: devopshub-app (image: devopshub-app:latest)
│       │   ├── envFrom: devopshub-config
│       │   ├── env: secretKeyRef → devopshub-secrets (×3 keys)
│       │   ├── livenessProbe:  GET /healthz every 20s
│       │   ├── readinessProbe: GET /readyz  every 10s
│       │   └── resources: req 100m/128Mi  lim 500m/256Mi
│       └── Volume: emptyDir /tmp (write target for read-only rootFS)
├── Service:    devopshub-svc       (ClusterIP :80 → container :3000)
└── Ingress:    devopshub-ingress   (NGINX, TLS, host devopshub.local)
```

---

## 5. Configuration & Secrets Strategy

### Separation of Concerns

| Category | Storage | Example Keys |
|---|---|---|
| Non-sensitive config | ConfigMap `devopshub-config` | `PORT`, `NODE_ENV` |
| API credentials | Secret `devopshub-secrets` | `RAPIDAPI_KEY`, `OMDB_API_KEY` |
| Session secret | Secret `devopshub-secrets` | `SESSION_SECRET` |
| TLS certificate | Secret `devopshub-tls` | `tls.crt`, `tls.key` |

### Secret Injection Pattern

Secrets are injected as individual environment variables via `secretKeyRef` — not via `envFrom` — so that a missing or renamed key produces a clear error at pod startup rather than a silent empty string.

### Production Recommendations

- Use **Sealed Secrets** (Bitnami) or **External Secrets Operator** with AWS Secrets Manager / HashiCorp Vault.
- Rotate API keys via CI/CD pipeline: `kubectl create secret … --dry-run=client -o yaml | kubectl apply -f -`.
- Never store `secrets.yaml` with real values in version control — the committed file contains `REPLACE_WITH_BASE64_*` placeholders only.

---

## 6. Health Probe Design

### Liveness Probe — `GET /healthz`

```
initialDelaySeconds: 15   # node startup + module loading
periodSeconds:       20   # check frequency
timeoutSeconds:       5   # max response time
failureThreshold:     3   # 3 × 20s = 60s before restart
successThreshold:     1   # standard for liveness
```

**Implementation:** Returns `{status:"alive", uptime:<seconds>}`. No I/O — purely tests that the event loop is running. Kubernetes restarts the container on 3 consecutive failures.

### Readiness Probe — `GET /readyz`

```
initialDelaySeconds:  5   # fast — env vars are available at start
periodSeconds:       10   # more frequent — quicker to re-enter rotation
timeoutSeconds:       3   
failureThreshold:     2   # 2 × 10s = 20s before removed from Service
successThreshold:     2   # require 2 successes to avoid flapping
```

**Implementation:** Checks that `RAPIDAPI_KEY`, `OMDB_API_KEY`, and `SESSION_SECRET` are non-empty. Returns `503` with a list of missing vars if any are absent. Kubernetes removes the pod from Service endpoint slice on failure (no restarts).

### Why Different Probes Matter

| Scenario | Liveness | Readiness |
|---|---|---|
| Process deadlock | Fires → restart | Fires → no traffic |
| Missing secrets | Does not fire | Fires → no traffic |
| Pod startup | Delayed 15s | Delayed 5s |
| Recovery after config fix | Not needed | Re-adds pod automatically |

---

## 7. Scaling Strategy

### Current State: 2 Replicas

Configured in `deployment.yaml` (`spec.replicas: 2`). The Deployment uses:

- **`maxUnavailable: 1`** — Keeps at least 1 pod serving traffic during rollouts.
- **`maxSurge: 1`** — Allows 1 extra pod during the rollout, limiting resource overhead.
- **Pod Anti-Affinity** — `preferredDuringSchedulingIgnoredDuringExecution` on `kubernetes.io/hostname` — encourages scheduling replicas on separate nodes to survive single-node failure.

### Horizontal Pod Autoscaler (HPA) — Recommended Next Step

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: devopshub-hpa
  namespace: devopshub
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: devopshub-app
  minReplicas: 2
  maxReplicas: 8
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60
```

### Session Affinity Note

The current in-memory session store means sessions are not shared between pods. Under multi-replica deployments, a user request routed to a different pod will lose their session. **Resolution:** Replace `express-session` with `connect-redis` backed by a Redis pod, or enable Ingress session-cookie affinity:

```yaml
nginx.ingress.kubernetes.io/affinity: "cookie"
nginx.ingress.kubernetes.io/session-cookie-name: "devopshub-route"
```

---

## 8. Observability & Monitoring

### Grafana Dashboard — 7 Tiles

| # | Tile | Type | Alert Threshold |
|---|---|---|---|
| 1 | HTTP Request Rate | Time series | Yellow 50 req/s, Red 200 req/s |
| 2 | HTTP Error Rate (5xx %) | Gauge | Yellow 1%, Red 5% |
| 3 | Response Latency p50/p95/p99 | Time series | Yellow p95 > 500ms, Red p99 > 1s |
| 4 | Pod CPU Usage | Time series | Yellow 400m, Red 480m |
| 5 | Pod Memory Usage | Time series | Yellow 200Mi, Red 245Mi |
| 6 | Pods Ready / Available | Stat | Red <1, Yellow 1, Green 2 |
| 7 | Node.js Event Loop Lag | Time series | Yellow 100ms, Red 500ms |

### Metric Sources

- **HTTP metrics** (`http_requests_total`, `http_request_duration_seconds_bucket`) — requires `prom-client` npm package with Express middleware.
- **Container metrics** (`container_cpu_usage_seconds_total`, `container_memory_working_set_bytes`) — provided by `kube-state-metrics` + cAdvisor.
- **Pod state** (`kube_deployment_status_replicas_ready`) — provided by `kube-state-metrics`.
- **Node.js runtime** (`nodejs_eventloop_lag_seconds`) — provided by `prom-client` default metrics.

### Prometheus Scrape Config

The Service is annotated for auto-discovery:

```yaml
prometheus.io/scrape: "true"
prometheus.io/port: "3000"
prometheus.io/path: "/metrics"
```

---

## 9. CI/CD Pipeline

### GitHub Actions — `.github/workflows/deploy.yml`

```
Push to main
    │
    ▼
Checkout code
    │
    ▼
Set up Node.js 20 + npm install
    │
    ▼
Prepare SSH key (EC2_SSH_KEY secret)
    │
    ▼
SSH → EC2 instance
    ├── Clone repo (first deploy) / git pull (subsequent)
    ├── npm install --omit=dev
    ├── Write .env (RAPIDAPI_KEY, OMDB_API_KEY from GitHub Secrets)
    └── pm2 restart / start server.js
```

### Kubernetes Deployment Flow (Manual / Future)

```
docker build -t devopshub-app:latest .
docker push <registry>/devopshub-app:latest
kubectl set image deployment/devopshub-app \
  devopshub-app=<registry>/devopshub-app:latest -n devopshub
kubectl rollout status deployment/devopshub-app -n devopshub
```

---

## 10. Security Considerations

| Control | Implementation |
|---|---|
| Secrets management | Kubernetes Secrets (base64); never in plaintext in Git |
| TLS | NGINX Ingress with TLS Secret; HTTP → HTTPS redirect enforced |
| Container access | `runAsNonRoot: true`, `runAsUser: 1000`, `allowPrivilegeEscalation: false` |
| Capabilities | All dropped (`capabilities.drop: [ALL]`) |
| Root filesystem | `readOnlyRootFilesystem: true` (`/tmp` writable via emptyDir) |
| API key exposure | Keys injected as env vars from Secrets — never in ConfigMap or code |
| Session | Session secret from Secret; cookie `maxAge` 1 hour; `saveUninitialized: false` |
| Rate limiting | NGINX Ingress `limit-rps: 20` per IP |
| Authentication | All routes except `/login*` and `/movies*` protected by `requireAuth` middleware |

---

## 11. Dependency Map

```
devopshub-app (container)
├── express@4.18.2         — HTTP server and routing
├── node-fetch@2.7.0       — Outbound API calls (RapidAPI, OMDb)
├── express-session@1.17.3 — Session management
└── dotenv@16.3.1          — .env file loader (dev only; K8s uses env vars)

External APIs
├── ai-nutritional-facts.p.rapidapi.com  — Nutrition data (requires RAPIDAPI_KEY)
└── www.omdbapi.com                      — Movie metadata (requires OMDB_API_KEY)

Kubernetes Dependencies
├── NGINX Ingress Controller  — External traffic routing
├── cert-manager (optional)   — Automated TLS certificate provisioning
├── Prometheus + kube-state-metrics — Metrics collection
└── Grafana                   — Dashboard visualisation
```

---

## 12. Future Improvements

| Priority | Improvement | Rationale |
|---|---|---|
| High | Replace in-memory session store with Redis | Fix session loss across replicas |
| High | Add HorizontalPodAutoscaler | Automatic scale-out under load |
| High | Add `prom-client` to server.js | Enable Grafana Tiles 1, 2, 3, 7 |
| Medium | cert-manager + Let's Encrypt | Automated TLS renewal |
| Medium | Network Policies | Restrict pod-to-pod traffic |
| Medium | Dockerfile + image push to GHCR | Enable K8s-native deployments |
| Low | Structured JSON logging | Machine-readable logs for Loki/ELK |
| Low | Distroless base image | Reduce container attack surface |
