# Cloudflare DNS query report Worker

A single-file [Cloudflare Worker](https://developers.cloudflare.com/workers/) that counts DNS queries for the last 30 days on **every zone** in a Cloudflare account, writes a CSV, and uploads it to an **S3-compatible** bucket (Wasabi, AWS S3, Cloudflare R2, MinIO, and similar).

Paste `worker.js` into the Workers dashboard editor. There is no runtime npm dependency.

## Features

- Lists all zones in the account (paginated).
- Queries Cloudflare GraphQL Analytics (`dnsAnalyticsAdaptiveGroups` / `count`) in batches of 10 zones, splitting automatically if GraphQL returns `too many zones requested`.
- Builds a CSV with one row per zone. Zones with no analytics data are recorded as `0` (they are not silently dropped).
- Uploads the file with AWS Signature Version 4 (implemented with the Web Crypto API).
- HTTP Basic Auth on the Worker URL: generating the report **also** uploads the CSV and returns it as a download.
- Cron handler for unattended runs (schedule is configured in the dashboard, not in this file).

## Prerequisites

- A Cloudflare account with zones you are allowed to read.
- A Cloudflare API token (see [Environment variables](#environment-variables)).
- An S3-compatible bucket that already exists, plus an access key that can `PutObject` on that bucket.
- Permission to create a Worker and set encrypted secrets.

## Install and deploy

1. Create a Worker in the Cloudflare dashboard.
2. Replace the default script with the contents of [`worker.js`](worker.js).
3. Set the variables and secrets listed below (**Settings → Variables and Secrets**).
4. Optional: add a Cron Trigger (**Settings → Triggers → Cron**), for example `0 1 1 * *` (01:00 UTC on the first day of each month).
5. Save and deploy.

The Worker remains a single file so you can keep using the dashboard editor. If you prefer the Wrangler CLI, you can point a `wrangler.toml` at `worker.js` yourself; this repository does not require Wrangler.

## Configuration

Bindings are read from the Worker environment. Never put real credentials in `worker.js` or in git.

Copy [`.env.example`](.env.example) as a local checklist only (the dashboard does not load `.env` files).

### Environment variables

| Name | Required | Secret | Description |
|---|---|---|---|
| `ACCOUNT_ID` | yes | no | Cloudflare account ID. |
| `CF_API_TOKEN` | yes | yes | Token that can **list zones** and **read DNS analytics** for every zone in the account (`Zone.Zone:Read` and `Zone.Analytics:Read`). |
| `AUTH_PASS` | yes | yes | HTTP Basic Auth password for the Worker URL. |
| `AUTH_USER` | no | no | HTTP Basic Auth username. Default: `report-dns-query`. |
| `S3_ACCESS_KEY` | yes | yes | Access key for the S3-compatible API. |
| `S3_SECRET_KEY` | yes | yes | Secret key for the S3-compatible API. |
| `S3_BUCKET` | yes | no | Destination bucket name. |
| `S3_REGION` | yes | no | Region string used in SigV4 (for example `eu-south-1`). |
| `S3_HOST` | yes | no | Endpoint host **without** `https://` (for example `s3.eu-south-1.wasabisys.com`). |

Missing or empty required values cause the run to fail with a clear log message. HTTP clients receive a generic `500` body so secrets and account details are not echoed in responses.

## Usage

### Manual HTTP run

```bash
curl -u 'report-dns-query:YOUR_PASSWORD' -OJ "https://YOUR-WORKER.example.workers.dev/"
```

On success the Worker:

1. Builds the 30-day report.
2. Uploads `dns-report-YYYY-MM-DD.csv` to `s3://S3_BUCKET/`.
3. Returns the same CSV as a file download.

A second request on the same UTC date overwrites the object of that name.

### Cron

The `scheduled` handler runs the same generate-and-upload path (no HTTP download). Configure the expression in the dashboard. **The report window is always the last 30 days**, even if the cron fires once a month. A monthly trigger is only a schedule, not a calendar-month metric.

## Input and output

There is no request body. The Worker uses the Cloudflare account from `ACCOUNT_ID` and the current UTC date.

CSV columns (kept for compatibility with existing consumers):

```text
dominio,query_dns_30gg
example.com,12345
another.example,0
```

- `dominio` is the zone name from the Cloudflare API.
- `query_dns_30gg` is the query count from `date_geq` (30 days ago) through `date_leq` (today), UTC calendar dates.
- Domain names that contain commas or quotes are CSV-escaped.

Object key: `dns-report-YYYY-MM-DD.csv` where the date is today (UTC).

## Error handling

| Situation | HTTP | Notes |
|---|---|---|
| Missing `Authorization` | 401 | `WWW-Authenticate: Basic` |
| Malformed Basic Auth | 400 | |
| Wrong username or password | 403 | |
| Missing config, Cloudflare API error, GraphQL error, S3 error | 500 | Body is `Technical error`. Details go to Worker logs only. |

GraphQL errors other than `too many zones` are **not** treated as zero counts. That failure mode previously produced a CSV full of zeros.

Cron failures are logged and the scheduled run is marked failed.

## Troubleshooting

**401 / 403** — Check `AUTH_USER` (default `report-dns-query`) and `AUTH_PASS`. Use HTTPS; Basic Auth sends the password on every request.

**500 and logs say `Missing required configuration`** — A required binding is absent or blank. Names are case-sensitive.

**500 and logs say `Zone list failed`** — Token cannot list zones, `ACCOUNT_ID` is wrong, or the API returned an error. The token needs zone read on the whole account, not a single zone.

**500 and logs say `GraphQL request failed`** — Token is missing `Zone.Analytics:Read`, or the Analytics API rejected the query. Confirm the token covers every zone.

**500 and logs say `S3 upload failed: HTTP …`** — Signing region/host mismatch, wrong keys, missing bucket, or the key cannot `PutObject`. `S3_HOST` must be a hostname, not a full URL.

**CSV is all zeros but the request succeeded** — Each zone was listed and GraphQL returned no `dnsAnalyticsAdaptiveGroups` row (or `count` 0). If GraphQL had failed, the Worker would have returned 500 instead of zeros.

## Security

- Store `CF_API_TOKEN`, `AUTH_PASS`, and S3 keys as **encrypted secrets**, not plaintext variables.
- Give the Cloudflare token the minimum permissions above; do not use the global API key.
- The Worker URL is a full report generator. Treat Basic Auth as a shared secret and rotate it if it leaks. Prefer keeping the URL unlisted.
- HTTP responses and client-visible errors do not include tokens, passwords, or S3 XML bodies.
- This project is meant to be cloned without any customer account IDs, bucket names, or zone IDs.

## Limitations

- Counts follow Cloudflare’s DNS analytics dataset and date filters, not raw packet captures.
- The 30-day window is rolling from “today” UTC, not a calendar month.
- Path-style `PUT https://S3_HOST/S3_BUCKET/filename` is used. Some S3 setups expect virtual-hosted-style URLs; if uploads fail with 301/404, check how your provider expects the host.
- There is no retry/backoff beyond GraphQL zone-batch splitting.
- The Worker lists **all** zones in the account; there is no include/exclude list.

## Tests

Tests mock `fetch`. They never call Cloudflare, S3, or any production system.

```bash
npm install
npm test
```

## License

[MIT](LICENSE) © g77tony
