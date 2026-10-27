// Cloudflare Worker (single file, paste into the dashboard editor).
// DNS query report for the last 30 days, for every zone in the account,
// uploaded as CSV to an S3-compatible bucket.
//
// Configuration: see README.md and .env.example. Set bindings in
// Workers -> Settings -> Variables and Secrets.

export const DEFAULT_AUTH_USER = "report-dns-query";

const REQUIRED_ENV = [
  "ACCOUNT_ID",
  "CF_API_TOKEN",
  "AUTH_PASS",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "S3_BUCKET",
  "S3_REGION",
  "S3_HOST"
];

// GraphQL rejects overly large zoneTag_in lists ("too many zones requested").
// fetchDnsCounts splits the batch in half and retries when that happens.
const ZONE_BATCH_SIZE = 10;
// Maximum per_page accepted by GET /zones.
const ZONES_PER_PAGE = 50;

const enc = new TextEncoder();

export default {
  async fetch(request, env) {
    const authError = checkAuth(request, env);
    if (authError) return authError;

    try {
      assertConfig(env);
      const { csv, filename } = await buildReport(env);
      await uploadToS3(env, csv, filename);
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`
        }
      });
    } catch (err) {
      console.error("Report failed:", err instanceof Error ? err.message : err);
      return new Response("Technical error", { status: 500 });
    }
  },

  // Cron is configured in the dashboard (Settings -> Triggers -> Cron),
  // for example 0 1 1 * * (01:00 UTC on the 1st of each month).
  // The window is still the last 30 days, not a calendar month.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledReport(env));
  }
};

export async function runScheduledReport(env) {
  try {
    assertConfig(env);
    const { csv, filename } = await buildReport(env);
    await uploadToS3(env, csv, filename);
    console.log(`Report uploaded: ${filename}`);
  } catch (err) {
    console.error("Scheduled report failed:", err instanceof Error ? err.message : err);
    throw err;
  }
}

// ---------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------

export function assertConfig(env) {
  const missing = REQUIRED_ENV.filter((key) => !nonEmptyString(env?.[key]));
  if (missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(", ")}`);
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function authUser(env) {
  const value = env?.AUTH_USER;
  return nonEmptyString(value) ? value.trim() : DEFAULT_AUTH_USER;
}

function s3Host(env) {
  return env.S3_HOST.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

function s3Bucket(env) {
  return env.S3_BUCKET.trim();
}

function s3Region(env) {
  return env.S3_REGION.trim();
}

// ---------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------

export function checkAuth(request, env) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return new Response("Authentication required", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="DNS query report"' }
    });
  }

  try {
    const space = authHeader.indexOf(" ");
    const scheme = space === -1 ? authHeader : authHeader.slice(0, space);
    const encoded = space === -1 ? "" : authHeader.slice(space + 1);
    if (scheme !== "Basic" || !encoded) {
      return new Response("Invalid authentication", { status: 400 });
    }

    const decoded = atob(encoded);
    const colon = decoded.indexOf(":");
    if (colon === -1) {
      return new Response("Invalid authentication", { status: 400 });
    }

    const user = decoded.slice(0, colon);
    const pass = decoded.slice(colon + 1);
    const expectedPass = nonEmptyString(env?.AUTH_PASS) ? env.AUTH_PASS : "";

    const userOk = timingSafeEqualString(user, authUser(env));
    const passOk = timingSafeEqualString(pass, expectedPass);
    if (!userOk || !passOk || !expectedPass) {
      return new Response("Invalid credentials", { status: 403 });
    }
  } catch {
    return new Response("Invalid authentication", { status: 400 });
  }

  return null;
}

function timingSafeEqualString(a, b) {
  const aa = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(aa.length, bb.length);
  let diff = aa.length === bb.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------
// REPORT
// ---------------------------------------------------------------------

export async function buildReport(env) {
  const zones = await listAllZones(env);
  const dateGeq = dateNDaysAgo(30);
  const dateLeq = dateNDaysAgo(0);

  const counts = new Map();
  for (let i = 0; i < zones.length; i += ZONE_BATCH_SIZE) {
    const zoneTags = zones.slice(i, i + ZONE_BATCH_SIZE).map((z) => z.id);
    const batchCounts = await fetchDnsCounts(env, zoneTags, dateGeq, dateLeq);
    for (const [tag, count] of batchCounts) counts.set(tag, count);
  }

  const rows = ["dominio,query_dns_30gg"];
  for (const zone of zones) {
    const count = counts.get(zone.id) ?? 0;
    rows.push(`${csvField(zone.name)},${count}`);
  }

  return {
    csv: rows.join("\n"),
    filename: `dns-report-${dateLeq}.csv`
  };
}

export async function listAllZones(env) {
  const zones = [];
  let page = 1;
  let totalPages = 1;

  do {
    const url =
      `https://api.cloudflare.com/client/v4/zones` +
      `?account.id=${encodeURIComponent(env.ACCOUNT_ID)}` +
      `&per_page=${ZONES_PER_PAGE}&page=${page}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` }
    });

    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(`Zone list failed: HTTP ${res.status}`);
    }

    if (!res.ok || !data.success) {
      throw new Error(`Zone list failed: HTTP ${res.status}`);
    }

    for (const z of data.result ?? []) {
      zones.push({ id: z.id, name: z.name });
    }
    totalPages = data.result_info?.total_pages ?? 1;
    page++;
  } while (page <= totalPages);

  return zones;
}

// One GraphQL request per batch. On "too many zones requested", split and retry.
export async function fetchDnsCounts(env, zoneTags, dateGeq, dateLeq) {
  if (zoneTags.length === 0) return new Map();

  const query = `{
    viewer {
      zones(filter: { zoneTag_in: ${JSON.stringify(zoneTags)} }) {
        zoneTag
        dnsAnalyticsAdaptiveGroups(
          limit: 1,
          filter: { date_geq: "${dateGeq}", date_leq: "${dateLeq}" }
        ) {
          count
        }
      }
    }
  }`;

  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query })
  });

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`GraphQL request failed: HTTP ${res.status}`);
  }

  if (data.errors && data.errors.length > 0) {
    const tooManyZones = data.errors.some((e) =>
      /too many zones/i.test(e.message || "")
    );
    if (tooManyZones && zoneTags.length > 1) {
      const mid = Math.ceil(zoneTags.length / 2);
      const [left, right] = await Promise.all([
        fetchDnsCounts(env, zoneTags.slice(0, mid), dateGeq, dateLeq),
        fetchDnsCounts(env, zoneTags.slice(mid), dateGeq, dateLeq)
      ]);
      return new Map([...left, ...right]);
    }
    // Other GraphQL errors must not be swallowed: that previously produced
    // a CSV of zeros instead of a failure.
    throw new Error("GraphQL request failed");
  }

  if (!res.ok) {
    throw new Error(`GraphQL request failed: HTTP ${res.status}`);
  }

  const result = new Map();
  const zonesResult = data?.data?.viewer?.zones ?? [];
  for (const z of zonesResult) {
    const count = z.dnsAnalyticsAdaptiveGroups?.[0]?.count ?? 0;
    result.set(z.zoneTag, count);
  }
  return result;
}

// ---------------------------------------------------------------------
// S3-COMPATIBLE UPLOAD (AWS SigV4)
// ---------------------------------------------------------------------

export async function uploadToS3(env, csv, filename) {
  const accessKey = env.S3_ACCESS_KEY;
  const secretKey = env.S3_SECRET_KEY;
  const host = s3Host(env);
  const bucket = s3Bucket(env);
  const region = s3Region(env);

  const url = `https://${host}/${bucket}/${filename}`;
  const method = "PUT";

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256(csv);

  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest =
    `${method}\n` +
    `/${bucket}/${filename}\n` +
    `\n` +
    `${canonicalHeaders}\n` +
    `${signedHeaders}\n` +
    `${payloadHash}`;

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;

  const stringToSign =
    `${algorithm}\n` +
    `${amzDate}\n` +
    `${credentialScope}\n` +
    `${await sha256(canonicalRequest)}`;

  const signingKey = await getSignatureKey(secretKey, dateStamp, region, "s3");
  const signature = toHex(await hmac(signingKey, stringToSign));

  const authorization =
    `${algorithm} Credential=${accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "text/csv",
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      Authorization: authorization
    },
    body: csv
  });

  if (!res.ok) {
    throw new Error(`S3 upload failed: HTTP ${res.status}`);
  }
  return true;
}

// ---------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------

export function dateNDaysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function csvField(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(data) {
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(data));
  return toHex(hash);
}

async function hmac(key, msg) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(msg)));
}

async function getSignatureKey(secret, dateStamp, region, service) {
  const kDate = await hmac(enc.encode("AWS4" + secret), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return await hmac(kService, "aws4_request");
}
