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

/**
 * Returns the single uploaded file's name and bytes from a multipart/form-data
 * body. Playwright hands back the raw body, and the probe must be shown to have
 * sent the bytes unaltered, so the part is parsed rather than trusted.
 */
function readSinglePart(body, contentType) {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
  expect(boundary).toBeTruthy();
  const headerEnd = body.indexOf("\r\n\r\n");
  const name = /filename="([^"]*)"/.exec(body.subarray(0, headerEnd).toString("utf8"))?.[1];
  expect(name).toBeTruthy();
  return { name, bytes: body.subarray(headerEnd + 4, body.lastIndexOf(`\r\n--${boundary}--`)) };
}

/**
 * Serves the write and metadata tests from a small in-memory tree, so that the
 * listings answer what the preceding calls actually did rather than a fixed
 * script. deletefolder refuses a folder with contents, as the real one does,
 * which is what makes the ordering of the metadata test meaningful.
 */
async function mockWriteApi(page, { folderCreated = true, uploads, deletes } = {}) {
  const probeFolderId = 4242;
  const folders = new Map([[probeFolderId, { name: "podium-write-probe", parent: 0 }]]);
  const files = new Map();
  let nextFolderId = 5151;
  let nextFileId = 777;

  const json = (route, payload) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ result: 0, ...payload }),
  });
  const params = route => new URL(route.request().url()).searchParams;

  await page.route("https://api.pcloud.com/getdigest**", route =>
    json(route, { digest: "mock-digest", expires: new Date(Date.now() + 30000).toUTCString() }));
  // Playwright uses the route registered last, and "createfolder**" matches
  // createfolderifnotexists too, so the narrower method is registered after it.
  // "deletefolder**" and deletefolderrecursive are ordered for the same reason.
  await page.route("https://api.pcloud.com/createfolder**", route => {
    const folderid = nextFolderId++;
    folders.set(folderid, { name: params(route).get("name"), parent: Number(params(route).get("folderid")) });
    json(route, { metadata: { folderid, name: folders.get(folderid).name } });
  });
  await page.route("https://api.pcloud.com/createfolderifnotexists**", route =>
    json(route, { created: folderCreated, metadata: { folderid: probeFolderId } }));
  await page.route("https://api.pcloud.com/listfolder**", route => {
    const parent = Number(params(route).get("folderid"));
    const contents = [
      ...[...folders].filter(([, folder]) => folder.parent === parent)
        .map(([folderid, folder]) => ({ isfolder: true, folderid, name: folder.name })),
      ...[...files].filter(([, file]) => file.parent === parent)
        .map(([fileid, file]) => ({ isfolder: false, fileid, name: file.name, size: file.bytes.length })),
    ];
    json(route, { metadata: { folderid: parent, contents } });
  });
  await page.route("https://api.pcloud.com/renamefolder**", route => {
    folders.get(Number(params(route).get("folderid"))).name = params(route).get("toname");
    json(route, {});
  });
  await page.route("https://api.pcloud.com/renamefile**", route => {
    files.get(Number(params(route).get("fileid"))).name = params(route).get("toname");
    json(route, {});
  });
  await page.route("https://api.pcloud.com/uploadfile**", route => {
    const request = route.request();
    const contentType = request.headers()["content-type"] || "";
    uploads?.push({ method: request.method(), contentType });
    // Stand in for the preflight api.pcloud.com never allows.
    if (request.method() !== "POST" || !contentType.startsWith("multipart/form-data"))
      return route.abort("failed");
    const part = readSinglePart(request.postDataBuffer(), contentType);
    const fileid = nextFileId++;
    files.set(fileid, { name: part.name, parent: Number(params(route).get("folderid")), bytes: part.bytes });
    json(route, { metadata: [{ fileid, name: part.name, size: part.bytes.length }] });
  });
  await page.route("https://api.pcloud.com/getzip**", route => {
    const file = files.get(Number(params(route).get("fileids")));
    route.fulfill({ contentType: "application/zip", body: buildZip(file.name, file.bytes) });
  });
  await page.route("https://api.pcloud.com/deletefile**", route => {
    deletes?.push("deletefile");
    files.delete(Number(params(route).get("fileid")));
    json(route, {});
  });
  await page.route("https://api.pcloud.com/deletefolder**", route => {
    deletes?.push("deletefolder");
    const folderid = Number(params(route).get("folderid"));
    if ([...folders.values()].some(folder => folder.parent === folderid) ||
        [...files.values()].some(file => file.parent === folderid))
      return json(route, { result: 2006, error: "Folder is not empty." });
    folders.delete(folderid);
    json(route, {});
  });
  await page.route("https://api.pcloud.com/deletefolderrecursive**", route => {
    deletes?.push("deletefolderrecursive");
    json(route, {});
  });
}

/** Fills the credentials the write test re-reads from the form on every run. */
async function startWriteTest(page) {
  await page.goto("/pcloud-web/probe.html");
  await page.fill("#email", "probe@example.test");
  await page.fill("#password", "mock-password");
  await page.click("#testWrite");
}

test("the probe writes a file back and verifies the round trip byte for byte", async ({ page }) => {
  const errors = [];
  const uploads = [];
  const deletes = [];
  page.on("pageerror", error => errors.push(error.message));

  await mockWriteApi(page, { uploads, deletes });
  await startWriteTest(page);

  // The preflighted PUT must be reported and must not stop the multipart test.
  await expect(page.locator("#diagnostics li.failure"))
    .toHaveText([/PREFLIGHTED PUT UPLOAD FAIL:/]);
  await expect(page.locator("#diagnostics li.success")).toContainText([
    /Created \/podium-write-probe/,
    /multipart uploadfile stored \d+ bytes as fileid 777/,
    /the round trip is byte-exact: \d+ bytes written and read back/,
  ]);

  // The cleanup runs after everything else, so wait for it before looking at
  // what the whole run did. The folder was created here, so it is removed whole.
  await expect(page.locator("#diagnostics li").last())
    .toHaveText(/Deleted \/podium-write-probe and everything this test put in it\./);

  // The second POST is the metadata test's throwaway file in the subfolder.
  expect(uploads.map(upload => upload.method)).toEqual(["PUT", "POST", "POST"]);
  expect(uploads[0].contentType).toBe("application/octet-stream");
  expect(uploads[1].contentType).toMatch(/^multipart\/form-data; boundary=/);
  expect(uploads[2].contentType).toMatch(/^multipart\/form-data; boundary=/);
  // The metadata test removes its own file and folder before the cleanup runs,
  // and deletefolder must come after deletefile or the real one would refuse.
  expect(deletes).toEqual(["deletefile", "deletefolder", "deletefolderrecursive"]);
  // The password must not survive the test in the form.
  expect(await page.inputValue("#password")).toBe("");
  expect(errors).toEqual([]);
});

test("the probe exercises every metadata method Podium calls", async ({ page }) => {
  const methods = [];
  await mockWriteApi(page);
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.hostname === "api.pcloud.com") methods.push(url.pathname.slice(1));
  });

  await startWriteTest(page);

  await expect(page.locator("#diagnostics li.success")).toContainText([
    /all five untested metadata methods work with per-request digest authentication/,
  ]);
  await expect(page.locator("#diagnostics li.failure"))
    .toHaveText([/PREFLIGHTED PUT UPLOAD FAIL:/]);
  // Every method PCloudSrc calls must have been reached, getfilelink aside: it
  // is the one being replaced by getzip.
  expect(new Set(methods)).toEqual(new Set([
    "getdigest", "createfolderifnotexists", "uploadfile", "getzip",
    "createfolder", "listfolder", "renamefolder", "renamefile",
    "deletefile", "deletefolder", "deletefolderrecursive",
  ]));
});

test("the probe leaves a pre-existing folder in place and deletes only its own file", async ({ page }) => {
  const deletes = [];
  await mockWriteApi(page, { folderCreated: false, deletes });
  await startWriteTest(page);

  await expect(page.locator("#diagnostics li.success"))
    .toContainText([/\/podium-write-probe already existed/]);
  await expect(page.locator("#diagnostics li")).toContainText([/Deleted the probe file \(fileid 777\)/]);
  // The first two are the metadata test's own; only the last is the cleanup,
  // which must not touch the folder it did not create.
  expect(deletes).toEqual(["deletefile", "deletefolder", "deletefile"]);
});

test("the probe reuses one digest across requests and reports the window", async ({ page }) => {
  const digests = [];
  await mockWriteApi(page);
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === "/getdigest") digests.push(url.href);
  });

  await page.goto("/pcloud-web/probe.html");
  await page.fill("#email", "probe@example.test");
  await page.fill("#password", "mock-password");
  await page.click("#testDigestReuse");

  await expect(page.locator("#diagnostics li.success").last())
    .toHaveText(/one digest served 3 listfolder calls in \d+ ms, against \d+ ms for 3 calls each signed with its own digest \([\d.]+x\)\. The digest window is [\d.]+ s\./);
  // One digest for the reused pass, then one per call for the comparison.
  expect(digests).toHaveLength(4);
  expect(await page.inputValue("#password")).toBe("");
});

test("the probe rejects an out-of-range probe size before calling pCloud", async ({ page }) => {
  const calls = [];
  await mockWriteApi(page);
  page.on("request", request => {
    if (request.url().startsWith("https://api.pcloud.com/")) calls.push(request.url());
  });

  await page.goto("/pcloud-web/probe.html");
  await page.fill("#email", "probe@example.test");
  await page.fill("#password", "mock-password");
  await page.fill("#writeSize", "0");
  await page.click("#testWrite");

  await expect(page.locator("#diagnostics li.failure"))
    .toHaveText([/WRITE FAIL: Enter a probe size between 1 and 65536 KiB\./]);
  expect(calls).toEqual([]);
  // A rejected size must not consume the password either.
  expect(await page.inputValue("#password")).toBe("mock-password");
});

test("the probe reports a corrupted round trip as a failure", async ({ page }) => {
  await mockWriteApi(page);
  // Answer the read-back with a file of the right length but the wrong bytes.
  await page.route("https://api.pcloud.com/getzip**", route => route.fulfill({
    contentType: "application/zip",
    body: buildZip("podium-write-probe.pdf", Buffer.concat([
      Buffer.from("%PDF-1.4\n% Podium pCloud write probe\n"),
      Buffer.alloc(32 << 10),
      Buffer.from("\n%%EOF\n"),
    ])),
  }));

  await startWriteTest(page);

  await expect(page.locator("#diagnostics li.failure")).toContainText([
    /PREFLIGHTED PUT UPLOAD FAIL:/,
    /WRITE FAIL: The round trip returned the right number of bytes, but they differ\./,
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
