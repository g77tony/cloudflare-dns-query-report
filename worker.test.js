import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, {
  assertConfig,
  buildReport,
  checkAuth,
  csvField,
  dateNDaysAgo,
  DEFAULT_AUTH_USER,
  fetchDnsCounts,
  runScheduledReport
} from "./worker.js";

const ENV = {
  ACCOUNT_ID: "account-test",
  CF_API_TOKEN: "token-test",
  AUTH_PASS: "secret-pass",
  AUTH_USER: "report-dns-query",
  S3_ACCESS_KEY: "AKIAEXAMPLE",
  S3_SECRET_KEY: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  S3_BUCKET: "dns-reports",
  S3_REGION: "eu-south-1",
  S3_HOST: "s3.eu-south-1.example.com"
};

function basicAuth(user, pass) {
  return "Basic " + btoa(`${user}:${pass}`);
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("assertConfig", () => {
  it("accepts a complete environment", () => {
    expect(() => assertConfig(ENV)).not.toThrow();
  });

  it("lists missing required keys", () => {
    expect(() => assertConfig({ ACCOUNT_ID: "x" })).toThrow(
      /Missing required configuration: .*CF_API_TOKEN/
    );
  });

  it("rejects blank values", () => {
    expect(() => assertConfig({ ...ENV, S3_BUCKET: "   " })).toThrow(
      /S3_BUCKET/
    );
  });
});

describe("checkAuth", () => {
  it("returns 401 without an Authorization header", () => {
    const res = checkAuth(new Request("https://worker.test/"), ENV);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toMatch(/Basic/);
  });

  it("returns 400 for a non-Basic scheme", () => {
    const res = checkAuth(
      new Request("https://worker.test/", {
        headers: { Authorization: "Bearer abc" }
      }),
      ENV
    );
    expect(res.status).toBe(400);
  });

  it("returns 403 for the wrong password", () => {
    const res = checkAuth(
      new Request("https://worker.test/", {
        headers: { Authorization: basicAuth(DEFAULT_AUTH_USER, "nope") }
      }),
      ENV
    );
    expect(res.status).toBe(403);
  });

  it("accepts a password that contains a colon", () => {
    const env = { ...ENV, AUTH_PASS: "p:ass:word" };
    const res = checkAuth(
      new Request("https://worker.test/", {
        headers: { Authorization: basicAuth(DEFAULT_AUTH_USER, "p:ass:word") }
      }),
      env
    );
    expect(res).toBeNull();
  });

  it("uses AUTH_USER when set", () => {
    const env = { ...ENV, AUTH_USER: "ops" };
    const wrongUser = checkAuth(
      new Request("https://worker.test/", {
        headers: { Authorization: basicAuth(DEFAULT_AUTH_USER, env.AUTH_PASS) }
      }),
      env
    );
    expect(wrongUser.status).toBe(403);

    const ok = checkAuth(
      new Request("https://worker.test/", {
        headers: { Authorization: basicAuth("ops", env.AUTH_PASS) }
      }),
      env
    );
    expect(ok).toBeNull();
  });
});

describe("csvField", () => {
  it("leaves simple names unchanged", () => {
    expect(csvField("example.com")).toBe("example.com");
  });

  it("quotes names that contain commas", () => {
    expect(csvField("foo,bar.com")).toBe('"foo,bar.com"');
  });
});

describe("buildReport and GraphQL batching", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("builds a CSV and maps missing analytics to 0", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T12:00:00.000Z"));

    fetch.mockImplementation(async (url) => {
      const href = String(url);
      if (href.includes("/client/v4/zones")) {
        return jsonResponse({
          success: true,
          result: [
            { id: "zone-a", name: "a.example" },
            { id: "zone-b", name: "b.example" }
          ],
          result_info: { total_pages: 1 }
        });
      }
      if (href.includes("/graphql")) {
        return jsonResponse({
          data: {
            viewer: {
              zones: [
                {
                  zoneTag: "zone-a",
                  dnsAnalyticsAdaptiveGroups: [{ count: 42 }]
                }
              ]
            }
          }
        });
      }
      throw new Error(`unexpected fetch: ${href}`);
    });

    const { csv, filename } = await buildReport(ENV);
    expect(filename).toBe("dns-report-2026-10-27.csv");
    expect(dateNDaysAgo(30)).toBe("2026-09-27");
    expect(csv).toBe(
      ["dominio,query_dns_30gg", "a.example,42", "b.example,0"].join("\n")
    );
  });

  it("splits a GraphQL batch on too many zones", async () => {
    let graphqlCalls = 0;
    fetch.mockImplementation(async (input, init) => {
      const href = String(input);
      if (href.includes("/graphql")) {
        graphqlCalls += 1;
        const query = JSON.parse(init.body).query;
        const tags = JSON.parse(query.match(/zoneTag_in: (\[[^\]]+\])/)[1]);
        if (tags.length > 1) {
          return jsonResponse({
            errors: [{ message: "too many zones requested" }]
          });
        }
        return jsonResponse({
          data: {
            viewer: {
              zones: [
                {
                  zoneTag: tags[0],
                  dnsAnalyticsAdaptiveGroups: [{ count: 7 }]
                }
              ]
            }
          }
        });
      }
      throw new Error(`unexpected fetch: ${href}`);
    });

    const counts = await fetchDnsCounts(
      ENV,
      ["z1", "z2"],
      "2026-09-27",
      "2026-10-27"
    );
    expect(graphqlCalls).toBe(3);
    expect(counts.get("z1")).toBe(7);
    expect(counts.get("z2")).toBe(7);
  });

  it("does not treat other GraphQL errors as zero counts", async () => {
    fetch.mockResolvedValue(
      jsonResponse({ errors: [{ message: "auth required" }] })
    );
    await expect(
      fetchDnsCounts(ENV, ["z1"], "2026-09-27", "2026-10-27")
    ).rejects.toThrow(/GraphQL request failed/);
  });
});

describe("HTTP fetch handler", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 401 without credentials", async () => {
    const res = await worker.fetch(new Request("https://worker.test/"), ENV);
    expect(res.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns a generic 500 when configuration is missing after auth", async () => {
    const res = await worker.fetch(
      new Request("https://worker.test/", {
        headers: { Authorization: basicAuth(DEFAULT_AUTH_USER, ENV.AUTH_PASS) }
      }),
      { AUTH_PASS: ENV.AUTH_PASS }
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Technical error");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uploads to S3 and returns the CSV", async () => {
    fetch.mockImplementation(async (input, init) => {
      const href = String(input);
      if (href.includes("/client/v4/zones")) {
        return jsonResponse({
          success: true,
          result: [{ id: "zone-a", name: "a.example" }],
          result_info: { total_pages: 1 }
        });
      }
      if (href.includes("/graphql")) {
        return jsonResponse({
          data: {
            viewer: {
              zones: [
                {
                  zoneTag: "zone-a",
                  dnsAnalyticsAdaptiveGroups: [{ count: 9 }]
                }
              ]
            }
          }
        });
      }
      if (init?.method === "PUT") {
        expect(href).toContain("https://s3.eu-south-1.example.com/dns-reports/");
        expect(href).toMatch(/dns-report-\d{4}-\d{2}-\d{2}\.csv$/);
        return new Response("", { status: 200 });
      }
      throw new Error(`unexpected fetch: ${href}`);
    });

    const res = await worker.fetch(
      new Request("https://worker.test/", {
        headers: { Authorization: basicAuth(DEFAULT_AUTH_USER, ENV.AUTH_PASS) }
      }),
      ENV
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/csv/);
    const body = await res.text();
    expect(body).toContain("a.example,9");
    expect(fetch.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(
      true
    );
  });
});

describe("scheduled handler", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads without calling production endpoints (mocked fetch)", async () => {
    fetch.mockImplementation(async (input, init) => {
      const href = String(input);
      if (href.includes("/zones")) {
        return jsonResponse({
          success: true,
          result: [{ id: "zone-a", name: "a.example" }],
          result_info: { total_pages: 1 }
        });
      }
      if (href.includes("/graphql")) {
        return jsonResponse({
          data: { viewer: { zones: [] } }
        });
      }
      if (init?.method === "PUT") return new Response("", { status: 200 });
      throw new Error(`unexpected fetch: ${href}`);
    });

    const pending = [];
    await worker.scheduled({}, ENV, {
      waitUntil(p) {
        pending.push(p);
      }
    });
    await Promise.all(pending);
    expect(fetch.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(
      true
    );
  });

  it("surfaces S3 failures on the scheduled path", async () => {
    fetch.mockImplementation(async (input, init) => {
      const href = String(input);
      if (href.includes("/zones")) {
        return jsonResponse({
          success: true,
          result: [{ id: "zone-a", name: "a.example" }],
          result_info: { total_pages: 1 }
        });
      }
      if (href.includes("/graphql")) {
        return jsonResponse({ data: { viewer: { zones: [] } } });
      }
      if (init?.method === "PUT") return new Response("denied", { status: 403 });
      throw new Error(`unexpected fetch: ${href}`);
    });

    await expect(runScheduledReport(ENV)).rejects.toThrow(/S3 upload failed: HTTP 403/);
  });
});
