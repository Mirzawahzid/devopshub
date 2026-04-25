# DevOpsHub — User Manual

**Version:** 1.0.0  
**Audience:** End users of the DevOpsHub web application

---

## Table of Contents

1. [Overview](#1-overview)
2. [Accessing the Application](#2-accessing-the-application)
3. [Logging In and Out](#3-logging-in-and-out)
4. [AI Nutritional Facts Viewer](#4-ai-nutritional-facts-viewer)
5. [Movie Search and Ratings](#5-movie-search-and-ratings)
6. [Troubleshooting](#6-troubleshooting)

---

## 1. Overview

DevOpsHub is a multi-feature web application providing:

- **AI-powered Nutritional Facts** — Enter any food or meal description and receive an instant nutrition breakdown (calories, macros, vitamins, minerals) powered by a cloud AI model.
- **Movie Search & Ratings** — Search movies by title or IMDb ID to retrieve cast information, plot summaries, and aggregated ratings from multiple sources (IMDb, Rotten Tomatoes, Metacritic).

The application runs on Node.js behind a secure HTTPS endpoint and is deployed on Kubernetes for high availability.

---

## 2. Accessing the Application

| Environment | URL |
|---|---|
| Local Kubernetes | `https://devopshub.local` |
| Production | Configured by your administrator |

> **First-time local setup:** Add `127.0.0.1 devopshub.local` to your hosts file (`C:\Windows\System32\drivers\etc\hosts` on Windows, `/etc/hosts` on Linux/macOS). You may see a browser security warning for the self-signed TLS certificate — click **Advanced → Proceed** to continue.

---

## 3. Logging In and Out

### Logging In

1. Navigate to the application URL.
2. You will be redirected to the **Login** page automatically if not authenticated.
3. Enter the credentials provided by your administrator.
4. Click **Login**.
5. On success you are redirected to the main dashboard.

> Sessions expire after **1 hour** of inactivity. You will be redirected to the Login page when your session expires.

### Logging Out

- Click the **Logout** link in the navigation bar (top right).
- Your session is immediately invalidated and you are redirected to the Login page.

> Closing the browser tab does **not** log you out. Always use the Logout button on shared or public computers.

---

## 4. AI Nutritional Facts Viewer

### How to Use

1. Log in (see Section 3).
2. On the main dashboard, locate the **Nutritional Facts** panel.
3. Type a food or meal description in the input box — be as specific as you like:
   - `"100g grilled salmon"` 
   - `"Large McDonald's Big Mac with fries"`
   - `"Bowl of oatmeal with blueberries and honey"`
4. Click **Get Nutrition** (or press **Enter**).
5. The results panel displays:
   - **Calories** (kcal)
   - **Macronutrients** — Protein, Fat, Carbohydrates, Fibre
   - **Micronutrients** — Key vitamins and minerals when available

### Tips

- More specific descriptions produce more accurate results (e.g., include quantity and preparation method).
- The AI model occasionally returns partial data for very unusual foods — try rephrasing.
- Results are estimates based on AI inference; they are not a substitute for medical nutrition advice.

### Error Messages

| Message | Meaning | Action |
|---|---|---|
| *"input field is required"* | Empty search box | Type a food description and retry |
| *"The nutrition AI is temporarily unavailable"* | Upstream API error | Wait 30 seconds and retry |
| *"API error 429"* | Rate limit hit | Wait 1 minute and retry |

---

## 5. Movie Search and Ratings

The Movie section is publicly accessible — **no login required**.

### Search by Title

1. Navigate to `https://devopshub.local/movies`.
2. Type a movie title in the **Search by Title** box (e.g., `"The Shawshank Redemption"`).
3. Click **Search**.
4. The result displays:
   - Movie poster, title, year, genre, director
   - Plot summary
   - Aggregated ratings: IMDb score, Rotten Tomatoes %, Metacritic score

### Search by IMDb ID

1. In the **Search by IMDb ID** box enter an IMDb ID (format: `tt` followed by digits, e.g., `tt0111161`).
2. Click **Lookup**.
3. The same result card is displayed.

### Error Messages

| Message | Meaning | Action |
|---|---|---|
| *"Movie not found"* | Title/ID not in OMDb | Check spelling or try the IMDb ID |
| *"Valid IMDb ID required"* | Wrong ID format | Ensure ID starts with `tt` followed by digits |
| *"Failed to reach OMDb API"* | Upstream API unavailable | Wait and retry |

---

## 6. Troubleshooting

### I am redirected to Login on every page

Your session cookie may be blocked. Ensure:
- Third-party cookies are not blocked in your browser for this domain.
- You are using HTTPS (not HTTP).

### The page shows "503 Service Unavailable"

The Kubernetes pods may be restarting or not yet ready. Contact your administrator. See [DEBUG_DRILLS.md](DEBUG_DRILLS.md) for resolution steps.

### Nutritional Facts returns no data

The RapidAPI key may have expired or the quota may be exhausted. Contact your administrator.

### Movie search returns stale results

The OMDb API is a live database; results reflect the current OMDb content. There is no client-side caching — a page refresh fetches fresh data.
