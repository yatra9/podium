const { test, expect } = require("@playwright/test");
const zlib = require("node:zlib");

// The pCloud web capability probe is run by hand against a real account, so
// these tests only cover the parts that can go wrong silently: the chunked
// descriptor read, the JSON-on-failure envelope, and the requirement that no
// request carries an Authorization header. api.pcloud.com omits
// Access-Control-Allow-Headers from its preflight response, so an Authorization
// header would be rejected from a web origin.

const pdf = Buffer.from(`%PDF-1.7\n${"mock pCloud score ".repeat(64)}\n%%EOF\n`);

/** Serves the descriptor API, splitting file_pread into short chunks. */
async function mockDescriptorApi(page, { chunkBytes = 97, requests } = {}) {
  await page.route("https://api.pcloud.com/listfolder**", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      result: 0,
      metadata: {
        contents: [{ isfolder: false, fileid: 99, name: "Etude.pdf", size: pdf.length }],
      },
    }),
  }));
  await page.route("https://api.pcloud.com/file_open**", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ result: 0, fd: 7 }),
  }));
  await page.route("https://api.pcloud.com/file_size**", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ result: 0, size: pdf.length, offset: 0 }),
  }));
  await page.route("https://api.pcloud.com/file_close**", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ result: 0 }),
  }));
  // getzip rejects access_token, so the probe exchanges it for a session token.
  await page.route("https://api.pcloud.com/userinfo**", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ result: 0, auth: "mock-session-token" }),
  }));
  await page.route("https://api.pcloud.com/file_pread**", route => {
    const url = new URL(route.request().url());
    requests?.push(url);
    const offset = Number(url.searchParams.get("offset"));
    const count = Number(url.searchParams.get("count"));
    // A real file_pread may return fewer bytes than requested.
    const end = Math.min(offset + Math.min(count, chunkBytes), pdf.length);
    route.fulfill({
      contentType: "application/octet-stream",
      body: pdf.subarray(offset, end),
    });
  });
}

/** Authenticates the probe with a pasted OAuth token and lists the root. */
async function listRootWithToken(page) {
  await page.goto("/pcloud-web/probe.html");
  await page.fill("#accessToken", "mock-access-token");
  await page.click("#useAccessToken");
  await page.click("#listRoot");
  await expect(page.locator("#diagnostics li.success")).toContainText([
    /Using the pasted OAuth access token/,
    /found 1 root PDF file/,
  ]);
}

test("the probe reassembles a PDF from chunked file_pread responses", async ({ page }) => {
  const errors = [];
  const requests = [];
  const authorized = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (request.headers().authorization) authorized.push(request.url());
  });

  await mockDescriptorApi(page, { requests });
  await listRootWithToken(page);
  await page.click("text=Test file_pread download");

  await expect(page.locator("#diagnostics li").last())
    .toHaveText(new RegExp(`file_pread read ${pdf.length} PDF bytes in \\d+ request\\(s\\)`));
  await expect(page.locator("#diagnostics li.failure")).toHaveCount(0);

  // Every chunk must be requested, and the token must travel as a parameter.
  expect(requests.length).toBeGreaterThan(1);
  expect(requests[0].searchParams.get("access_token")).toBe("mock-access-token");
  expect(authorized).toEqual([]);
  expect(errors).toEqual([]);
});

test("the probe reports a JSON error envelope from file_pread as a failure", async ({ page }) => {
  await mockDescriptorApi(page);
  // file_pread answers with raw bytes on success and JSON on failure.
  await page.route("https://api.pcloud.com/file_pread**", route => route.fulfill({
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({ result: 1007, error: "Invalid or closed file descriptor." }),
  }));

  await listRootWithToken(page);
  await page.click("text=Test file_pread download");

  await expect(page.locator("#diagnostics li.failure")).toHaveText([
    /DESCRIPTOR READ FAIL: file_pread failed: Invalid or closed file descriptor\. \(result 1007\)/,
  ]);
});

/**
 * Builds a single-member archive. The probe reads sizes from the central
 * directory, so the local header deliberately leaves its own size fields zero
 * and sets the data-descriptor flag, the way a streaming server writes them.
 */
function buildZip(name, contents, { method = 8, streamed = true } = {}) {
  const nameBytes = Buffer.from(name, "utf8");
  const body = method === 8 ? zlib.deflateRawSync(contents) : contents;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(streamed ? 0x08 : 0, 6);
  local.writeUInt16LE(method, 8);
  if (!streamed) {
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(contents.length, 22);
  }
  local.writeUInt16LE(nameBytes.length, 26);

  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50, 0);
  directory.writeUInt16LE(20, 4);
  directory.writeUInt16LE(20, 6);
  directory.writeUInt16LE(method, 10);
  directory.writeUInt32LE(body.length, 20);
  directory.writeUInt32LE(contents.length, 24);
  directory.writeUInt16LE(nameBytes.length, 28);
  directory.writeUInt32LE(0, 42);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length + nameBytes.length, 12);
  end.writeUInt32LE(local.length + nameBytes.length + body.length, 16);

  return Buffer.concat([local, nameBytes, body, directory, nameBytes, end]);
}

test("the probe extracts a deflated getzip archive", async ({ page }) => {
  const errors = [];
  const zipRequests = [];
  page.on("pageerror", error => errors.push(error.message));

  await mockDescriptorApi(page);
  await page.route("https://api.pcloud.com/getzip**", route => {
    zipRequests.push(new URL(route.request().url()));
    route.fulfill({ contentType: "application/zip", body: buildZip("Etude.pdf", pdf) });
  });

  await listRootWithToken(page);
  await page.click("text=Test getzip download");

  // The OAuth token must have been exchanged before getzip is called.
  await expect.poll(() => zipRequests.length).toBe(1);
  expect(zipRequests[0].searchParams.get("auth")).toBe("mock-session-token");
  expect(zipRequests[0].searchParams.get("access_token")).toBeNull();

  await expect(page.locator("#diagnostics li").last())
    .toHaveText(new RegExp(`"Etude\\.pdf" extracted to ${pdf.length} PDF bytes \\(method 8\\)`));
  await expect(page.locator("#diagnostics li.failure")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the probe extracts a stored getzip archive", async ({ page }) => {
  await mockDescriptorApi(page);
  await page.route("https://api.pcloud.com/getzip**", route => route.fulfill({
    contentType: "application/zip",
    body: buildZip("Etude.pdf", pdf, { method: 0, streamed: false }),
  }));

  await listRootWithToken(page);
  await page.click("text=Test getzip download");

  await expect(page.locator("#diagnostics li").last())
    .toHaveText(new RegExp(`extracted to ${pdf.length} PDF bytes \\(method 0\\)`));
});

test("the probe reports a getzip JSON error envelope as a failure", async ({ page }) => {
  await mockDescriptorApi(page);
  await page.route("https://api.pcloud.com/getzip**", route => route.fulfill({
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({ result: 2003, error: "Access denied. You do not have permissions to perform this operation." }),
  }));

  await listRootWithToken(page);
  await page.click("text=Test getzip download");

  await expect(page.locator("#diagnostics li.failure")).toHaveText([
    /ZIP READ FAIL: getzip failed: Access denied\. You do not have permissions to perform this operation\. \(result 2003\)/,
  ]);
});

test("the probe reports a content host without CORS as a failure", async ({ page }) => {
  await mockDescriptorApi(page);
  await page.route("https://api.pcloud.com/getfilelink**", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ result: 0, hosts: ["content.pcloud.com"], path: "/mock/Etude.pdf" }),
  }));
  // Stands in for a content host answering without Access-Control-Allow-Origin.
  await page.route("https://content.pcloud.com/**", route => route.abort("failed"));

  await listRootWithToken(page);
  await page.click("text=Test getfilelink download");

  await expect(page.locator("#diagnostics li.failure")).toHaveText([/WEB DOWNLOAD FAIL:/]);
});
