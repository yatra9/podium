const allowedApiHosts = new Set(["api.pcloud.com", "eapi.pcloud.com"]);
// Descriptor reads are chunked because file_pread caps the bytes it returns per
// request. A short chunk is normal and is not an error.
const readChunkBytes = 1 << 20;
// The write test works in its own folder so that cleaning up can never touch
// anything else, and its payload is random so that comparing the round trip
// proves the bytes survived rather than that two headers happen to match.
// A few tens of kilobytes answer the CORS question but measure nothing: the
// whole request is round-trip latency. Saving an annotated score uploads
// megabytes, so the size is selectable and the deployed-origin run should use a
// realistic one.
const writeProbeFolder = "podium-write-probe";
const writeProbeFile = "podium-write-probe.pdf";
const writeProbeMaxKiB = 64 << 10;
// tokenParam is "auth" for a direct-login token and "access_token" for OAuth.
const state = { authToken: null, tokenParam: "auth", apiHost: null };
const elements = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map(element => [element.id, element])
);

// A localhost pass proves less than a deployed-origin pass, because pCloud has
// treated the two differently, so every success says which one it was.
const onLocalhost = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

function pass(message) {
  const prefix = onLocalhost ? "LOCALHOST PASS" : "DEPLOYED ORIGIN PASS";
  const caveat = onLocalhost ? " A deployed-origin test is still required." : "";
  diagnostic(`${prefix}: ${message}${caveat}`, "success");
}

function diagnostic(message, status = "") {
  const item = document.createElement("li");
  item.textContent = message;
  if (status) item.className = status;
  elements.diagnostics.append(item);
}

async function sha1Hex(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function responseJson(response, operation) {
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`${operation} returned unreadable data: ${error.message}`);
  }
  if (!response.ok || payload.result !== 0) {
    throw new Error(`${operation} failed: ${payload.error || response.status} (result ${payload.result ?? "n/a"})`);
  }
  return payload;
}

function pcloudUrl(method, params) {
  if (!state.authToken || !state.apiHost) throw new Error("Log in first.");
  const url = new URL(`https://${state.apiHost}/${method}`);
  url.searchParams.set(state.tokenParam, state.authToken);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url;
}

async function pcloudJson(method, params = {}) {
  return responseJson(await fetch(pcloudUrl(method, params)), method);
}

/**
 * Calls an API method that answers with raw bytes on success and with a JSON
 * envelope on failure. No request header is set beyond the browser defaults, so
 * the request stays CORS-simple and triggers no preflight. That matters because
 * api.pcloud.com does not return Access-Control-Allow-Headers.
 */
async function responseBytes(response, method) {
  if (!response.ok) throw new Error(`${method} failed with HTTP ${response.status}.`);
  const buffer = await response.arrayBuffer();
  if ((response.headers.get("content-type") || "").includes("json")) {
    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(buffer));
    } catch (error) {
      throw new Error(`${method} returned unreadable data: ${error.message}`);
    }
    throw new Error(`${method} failed: ${payload.error || response.status} (result ${payload.result ?? "n/a"})`);
  }
  return new Uint8Array(buffer);
}

async function pcloudBytes(method, params = {}) {
  return responseBytes(await fetch(pcloudUrl(method, params)), method);
}

/** The per-request digest equivalent of pcloudBytes. */
async function directBytes(apiHost, email, password, method, params = {}) {
  const credentials = await directCredentials(apiHost, email, password);
  const url = new URL(`https://${apiHost}/${method}`);
  for (const [name, value] of Object.entries({ ...params, ...credentials })) url.searchParams.set(name, value);
  return responseBytes(await fetch(url), method);
}

async function directCredentials(apiHost, email, password) {
  const digestPayload = await responseJson(await fetch(`https://${apiHost}/getdigest`), "getdigest");
  const usernameHash = await sha1Hex(email);
  const material = new TextEncoder().encode(password + usernameHash + digestPayload.digest);
  return {
    username: email,
    digest: digestPayload.digest,
    passworddigest: await sha1Hex(material),
  };
}

/**
 * The per-request digest equivalent of pcloudJson. Options are passed through so
 * the write tests can choose the method and body, which is the whole point of
 * those tests: the upload's Content-Type decides whether the request is
 * preflighted, and api.pcloud.com answers OPTIONS without an
 * Access-Control-Allow-Headers field.
 */
async function directJson(apiHost, email, password, method, params = {}, options = {}) {
  const credentials = await directCredentials(apiHost, email, password);
  const url = new URL(`https://${apiHost}/${method}`);
  for (const [name, value] of Object.entries({ ...params, ...credentials })) url.searchParams.set(name, value);
  return responseJson(await fetch(url, options), method);
}

async function runTokenlessCapabilityTest(apiHost, email, password) {
  diagnostic("Falling back to per-request digest authentication for listfolder...");
  const listing = await directJson(apiHost, email, password, "listfolder", { folderid: "0" });
  const pdf = (listing.metadata?.contents || []).find(
    entry => !entry.isfolder && entry.name?.toLowerCase().endsWith(".pdf")
  );
  if (!pdf) throw new Error("Direct listfolder succeeded, but no PDF exists in the pCloud root folder.");
  diagnostic(`Direct listfolder succeeded; testing ${pdf.name}...`, "success");

  // getzip is a single request, so unlike the descriptor API it does not need a
  // session that outlives one call. This is the only remaining combination:
  // getzip refuses an OAuth token, and this account issues no session token.
  try {
    diagnostic("Calling getzip with per-request digest authentication...");
    const started = performance.now();
    const archive = await directBytes(apiHost, email, password, "getzip", { fileids: String(pdf.fileid) });
    const received = performance.now();
    const entry = await extractPdfFromZip(archive);
    const rate = (archive.length / 1024 / ((received - started) / 1000)).toFixed(0);
    pass(
      `digest getzip returned ${archive.length} bytes in ${(received - started).toFixed(0)} ms ` +
      `(${rate} KiB/s), and "${entry.name}" extracted to ${entry.bytes.length} PDF bytes (method ${entry.method}), ` +
      `with no content host involved.`
    );
  } catch (error) {
    diagnostic(`DIGEST ZIP READ FAIL: ${error.message}`, "failure");
  }

  // Kept for comparison: this is the path that forced pCloud support into the
  // browser extension, and it is expected to fail from a web origin.
  try {
    const link = await directJson(apiHost, email, password, "getfilelink", {
      fileid: String(pdf.fileid),
      contenttype: "application/pdf",
    });
    if (!link.hosts?.length || !link.path) throw new Error("getfilelink returned no host or path.");
    diagnostic(`Direct getfilelink succeeded; fetching ${link.hosts[0]}...`);
    const response = await fetch(`https://${link.hosts[0]}${link.path}`);
    if (!response.ok) throw new Error(`Content download failed with HTTP ${response.status}.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const signature = new TextDecoder("ascii").decode(bytes.subarray(0, 5));
    if (signature !== "%PDF-") throw new Error(`Received ${bytes.length} bytes without a PDF signature.`);
    pass(`digest getfilelink downloaded ${bytes.length} PDF bytes.`);
  } catch (error) {
    diagnostic(`DIGEST CONTENT HOST FAIL: ${error.message}`, "failure");
  }

  // Per-request digest authentication starts a new session every call, so a
  // descriptor from file_open would not survive until file_pread.
  diagnostic("Skipping the descriptor API: it needs a session that outlives one request, and file_open is closed to API clients anyway.");
}

async function directLogin() {
  const apiHost = elements.region.value;
  const email = elements.email.value.trim().toLowerCase();
  const password = elements.password.value;
  if (!allowedApiHosts.has(apiHost)) throw new Error("Select a valid pCloud region.");
  if (!email || !password) throw new Error("Enter the pCloud email and password.");

  diagnostic(`Calling https://${apiHost}/getdigest from ${location.origin}...`);
  const digestPayload = await responseJson(await fetch(`https://${apiHost}/getdigest`), "getdigest");
  const usernameHash = await sha1Hex(email);
  const material = new TextEncoder().encode(password + usernameHash + digestPayload.digest);
  elements.password.value = "";
  const passwordDigest = await sha1Hex(material);

  const loginUrl = new URL(`https://${apiHost}/userinfo`);
  loginUrl.searchParams.set("getauth", "1");
  // No logout=1 here. It invalidates the token the same request asks for with
  // getauth=1, and an earlier run of this probe concluded that the account
  // issues no token when in fact it was being discarded on the way out.
  loginUrl.searchParams.set("username", email);
  loginUrl.searchParams.set("digest", digestPayload.digest);
  loginUrl.searchParams.set("passworddigest", passwordDigest);
  loginUrl.searchParams.set("authexpire", "3600");
  diagnostic("Digest created; password field cleared. Calling userinfo...");
  const loginPayload = await responseJson(await fetch(loginUrl), "userinfo");
  if (!loginPayload.auth) {
    diagnostic("userinfo authenticated the account but returned no auth token; token issuance appears disabled for direct login.");
    await runTokenlessCapabilityTest(apiHost, email, password);
    return;
  }

  state.authToken = loginPayload.auth;
  state.tokenParam = "auth";
  state.apiHost = apiHost;
  elements.listRoot.disabled = false;
  diagnostic("Direct login succeeded; the session auth token is memory-only. getzip can now be tested.", "success");
}

async function listRoot() {
  elements.files.replaceChildren();
  const payload = await pcloudJson("listfolder", { folderid: "0" });
  const pdfs = (payload.metadata?.contents || []).filter(
    entry => !entry.isfolder && entry.name?.toLowerCase().endsWith(".pdf")
  );
  diagnostic(`listfolder succeeded; found ${pdfs.length} root PDF file(s).`, "success");
  for (const file of pdfs) {
    const row = document.createElement("div");
    row.className = "file";
    const label = document.createElement("span");
    label.textContent = `${file.name} (${file.size ?? "unknown"} bytes)`;
    const linkButton = document.createElement("button");
    linkButton.textContent = "Test getfilelink download";
    linkButton.addEventListener("click", () => testDownload(file, linkButton));
    const readButton = document.createElement("button");
    readButton.textContent = "Test file_pread download";
    readButton.addEventListener("click", () => testDescriptorRead(file, readButton));
    const zipButton = document.createElement("button");
    zipButton.textContent = "Test getzip download";
    zipButton.addEventListener("click", () => testZipRead(file, zipButton));
    row.append(label, linkButton, readButton, zipButton);
    elements.files.append(row);
  }
  if (!pdfs.length) elements.files.textContent = "Upload a PDF to the pCloud root folder, then list again.";
}

async function testDownload(file, button) {
  button.disabled = true;
  try {
    diagnostic(`Calling getfilelink for ${file.name}...`);
    const link = await pcloudJson("getfilelink", {
      fileid: String(file.fileid),
      contenttype: "application/pdf",
    });
    if (!link.hosts?.length || !link.path) throw new Error("getfilelink returned no host or path.");
    diagnostic(`getfilelink succeeded; fetching ${link.hosts[0]}...`, "success");
    const response = await fetch(`https://${link.hosts[0]}${link.path}`);
    if (!response.ok) throw new Error(`Content download failed with HTTP ${response.status}.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const signature = new TextDecoder("ascii").decode(bytes.subarray(0, 5));
    if (signature !== "%PDF-") throw new Error(`Received ${bytes.length} bytes without a PDF signature.`);
    pass(`getfilelink downloaded ${bytes.length} PDF bytes.`);
  } catch (error) {
    diagnostic(`WEB DOWNLOAD FAIL: ${error.message}`, "failure");
  } finally {
    button.disabled = false;
  }
}

/**
 * Reads a file through the descriptor API, which answers from api.pcloud.com
 * itself. getfilelink instead hands back a content host (CloudHTTPd and
 * CacheHTTPd) that sends no Access-Control-Allow-Origin, which is why Podium's
 * pCloud support is currently confined to the browser extension, where
 * host_permissions bypass CORS. If this path passes from a deployed origin, a
 * plain web app or PWA can read pCloud files without an extension.
 */
async function testDescriptorRead(file, button) {
  button.disabled = true;
  let fd = null;
  try {
    diagnostic(`Calling file_open for ${file.name}...`);
    // flags 0 requests read-only access.
    const opened = await pcloudJson("file_open", { flags: "0", fileid: String(file.fileid) });
    if (opened.fd === undefined) throw new Error("file_open returned no descriptor.");
    fd = opened.fd;

    const sized = await pcloudJson("file_size", { fd: String(fd) });
    const size = Number(sized.size);
    if (!Number.isFinite(size) || size <= 0) throw new Error(`file_size returned ${sized.size}.`);
    diagnostic(`file_open and file_size succeeded; reading ${size} bytes in ${readChunkBytes}-byte chunks...`, "success");

    const bytes = new Uint8Array(size);
    const started = performance.now();
    let offset = 0;
    let requests = 0;
    while (offset < size) {
      const chunk = await pcloudBytes("file_pread", {
        fd: String(fd),
        offset: String(offset),
        count: String(Math.min(readChunkBytes, size - offset)),
      });
      requests += 1;
      // A zero-length chunk before the end would loop forever.
      if (!chunk.length) throw new Error(`file_pread returned no bytes at offset ${offset}.`);
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const elapsed = performance.now() - started;

    const signature = new TextDecoder("ascii").decode(bytes.subarray(0, 5));
    if (signature !== "%PDF-") throw new Error(`Read ${offset} bytes without a PDF signature.`);
    const rate = (offset / 1024 / (elapsed / 1000)).toFixed(0);
    pass(
      `file_pread read ${offset} PDF bytes in ${requests} request(s), ` +
      `${elapsed.toFixed(0)} ms (${rate} KiB/s), with no content host involved.`
    );
  } catch (error) {
    diagnostic(`DESCRIPTOR READ FAIL: ${error.message}`, "failure");
  } finally {
    if (fd !== null) {
      // Leaked descriptors expire with the session, but close them anyway.
      try {
        await pcloudJson("file_close", { fd: String(fd) });
      } catch (error) {
        diagnostic(`file_close failed: ${error.message}`);
      }
    }
    button.disabled = false;
  }
}

/**
 * Trades an OAuth access token for a session auth token.
 *
 * The JSON methods accept either credential, but getzip rejects access_token
 * with "Log in required", so the content methods appear to recognise only the
 * session token. Both are memory-only here.
 */
async function ensureSessionAuthToken() {
  if (state.tokenParam === "auth") return;
  diagnostic("getzip needs a session token; calling userinfo?getauth=1 to exchange the OAuth token...");
  const payload = await pcloudJson("userinfo", { getauth: "1" });
  if (payload.auth) {
    state.authToken = payload.auth;
    state.tokenParam = "auth";
    diagnostic("Session auth token obtained; it stays in memory only.", "success");
    return;
  }
  // Last resort: some methods accept an OAuth token in the auth parameter even
  // though the exchange is refused. Let getzip answer the question.
  diagnostic("userinfo returned no auth token for this OAuth token. Retrying getzip with the OAuth token in the auth parameter...");
  state.tokenParam = "auth";
}

/**
 * Locates the end-of-central-directory record, which pCloud writes last when it
 * streams an archive. The central directory is the only place where the entry
 * sizes are reliable: a streamed local header may defer them to a data
 * descriptor and leave its own size fields zero.
 */
function findEndOfCentralDirectory(view) {
  const limit = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let offset = view.byteLength - 22; offset >= limit; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new Error("The archive has no end-of-central-directory record.");
}

/** Returns the first archive member as { name, method, bytes }. */
function readFirstZipEntry(archive) {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const end = findEndOfCentralDirectory(view);
  if (!view.getUint16(end + 10, true)) throw new Error("The archive is empty.");
  const directory = view.getUint32(end + 16, true);
  if (view.getUint32(directory, true) !== 0x02014b50)
    throw new Error("The central directory is malformed.");

  const method = view.getUint16(directory + 10, true);
  const compressedSize = view.getUint32(directory + 20, true);
  const nameLength = view.getUint16(directory + 28, true);
  const local = view.getUint32(directory + 42, true);
  if (compressedSize === 0xffffffff || local === 0xffffffff)
    throw new Error("The archive uses Zip64 fields this probe does not read.");
  if (view.getUint32(local, true) !== 0x04034b50)
    throw new Error("The local file header is malformed.");

  // The local header's own name and extra fields may differ in length from the
  // central directory's, so the data offset must come from the local header.
  const data = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  return {
    name: new TextDecoder().decode(archive.subarray(directory + 46, directory + 46 + nameLength)),
    method,
    bytes: archive.subarray(data, data + compressedSize),
  };
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Extracts the archive's first member and verifies that it is a PDF. */
async function extractPdfFromZip(archive) {
  if (archive[0] !== 0x50 || archive[1] !== 0x4b)
    throw new Error(`getzip returned ${archive.length} bytes without a zip signature.`);
  const entry = readFirstZipEntry(archive);
  if (entry.method !== 0 && entry.method !== 8)
    throw new Error(`The archive uses compression method ${entry.method}, which this probe does not read.`);
  const bytes = entry.method === 8 ? await inflateRaw(entry.bytes) : entry.bytes;
  const signature = new TextDecoder("ascii").decode(bytes.subarray(0, 5));
  if (signature !== "%PDF-")
    throw new Error(`Extracted ${bytes.length} bytes of "${entry.name}" without a PDF signature.`);
  return { ...entry, bytes };
}

/**
 * Reads a file as a single-member archive. getzip returns the archive bytes
 * from api.pcloud.com, whereas getziplink and getfilelink hand back a content
 * host that sends no Access-Control-Allow-Origin. file_open, which would be the
 * direct way to read bytes, answers 2003 even unauthenticated, so the
 * descriptor API is closed to API clients. That leaves this path as the only
 * known way for a web origin to read pCloud file contents.
 */
async function testZipRead(file, button) {
  button.disabled = true;
  try {
    await ensureSessionAuthToken();
    diagnostic(`Calling getzip for ${file.name}...`);
    const started = performance.now();
    const archive = await pcloudBytes("getzip", { fileids: String(file.fileid) });
    const received = performance.now();
    const entry = await extractPdfFromZip(archive);
    const elapsed = performance.now() - started;
    const rate = (archive.length / 1024 / ((received - started) / 1000)).toFixed(0);
    pass(
      `getzip returned ${archive.length} bytes in ${(received - started).toFixed(0)} ms ` +
      `(${rate} KiB/s), and "${entry.name}" extracted to ${entry.bytes.length} PDF bytes ` +
      `(method ${entry.method}) in ${elapsed.toFixed(0)} ms total, with no content host involved.`
    );
  } catch (error) {
    diagnostic(`ZIP READ FAIL: ${error.message}`, "failure");
  } finally {
    button.disabled = false;
  }
}

/** A PDF whose body is random, so a round trip can be compared exactly. */
function makeWriteProbeBytes(bodyBytes) {
  const header = new TextEncoder().encode("%PDF-1.4\n% Podium pCloud write probe\n");
  const trailer = new TextEncoder().encode("\n%%EOF\n");
  const body = new Uint8Array(bodyBytes);
  // getRandomValues refuses more than 65536 bytes at a time.
  for (let offset = 0; offset < body.length; offset += 1 << 14)
    crypto.getRandomValues(body.subarray(offset, Math.min(offset + (1 << 14), body.length)));
  const bytes = new Uint8Array(header.length + body.length + trailer.length);
  bytes.set(header, 0);
  bytes.set(body, header.length);
  bytes.set(trailer, header.length + body.length);
  return bytes;
}

/**
 * Removes whatever the write test created. The folder is deleted recursively
 * only when this run created it: if it already existed, it is the user's folder
 * and only the files this run uploaded may be removed.
 */
async function cleanUpWriteProbe(apiHost, email, password, folder, fileIds) {
  if (folder?.created) {
    try {
      await directJson(apiHost, email, password, "deletefolderrecursive", { folderid: String(folder.id) });
      diagnostic(`Deleted /${writeProbeFolder} and everything this test put in it.`);
      return;
    } catch (error) {
      diagnostic(`Could not delete /${writeProbeFolder}: ${error.message}. Remove it by hand.`, "failure");
    }
  }
  for (const fileId of fileIds) {
    try {
      await directJson(apiHost, email, password, "deletefile", { fileid: String(fileId) });
      diagnostic(`Deleted the probe file (fileid ${fileId}).`);
    } catch (error) {
      diagnostic(`Could not delete fileid ${fileId}: ${error.message}. Remove it by hand.`, "failure");
    }
  }
}

/**
 * Answers whether a web origin can write a file back to pCloud.
 *
 * Reading was the question that forced pCloud support into the extension, but
 * writing was never actually tested from a web origin, and Podium's current
 * upload cannot work there: PCloudSrc.putFileSrc sends PUT with
 * "Content-Type: application/octet-stream", which is not a CORS-safelisted
 * value, so the request is preflighted. api.pcloud.com answers OPTIONS with
 * Access-Control-Allow-Origin and Access-Control-Allow-Methods but no
 * Access-Control-Allow-Headers, so the Content-Type is never allowed.
 *
 * multipart/form-data is one of the three safelisted Content-Type values, so a
 * POST built from a FormData is a simple request and is never preflighted. This
 * test runs both so the comparison is recorded rather than assumed, then reads
 * the file back with getzip and compares every byte. Writing result 0 means
 * nothing to a score annotator if the annotations do not survive the trip.
 */
async function testWrite(button) {
  button.disabled = true;
  const apiHost = elements.region.value;
  const email = elements.email.value.trim().toLowerCase();
  const password = elements.password.value;
  let folder = null;
  const fileIds = [];
  try {
    if (!allowedApiHosts.has(apiHost)) throw new Error("Select a valid pCloud region.");
    if (!email || !password)
      throw new Error("Re-enter the email and password: the password is never kept between tests.");
    const sizeKiB = Number(elements.writeSize.value);
    if (!Number.isInteger(sizeKiB) || sizeKiB < 1 || sizeKiB > writeProbeMaxKiB)
      throw new Error(`Enter a probe size between 1 and ${writeProbeMaxKiB} KiB.`);
    elements.password.value = "";

    const payload = makeWriteProbeBytes(sizeKiB << 10);
    diagnostic(`Creating /${writeProbeFolder} for a ${payload.length}-byte probe file...`);
    const created = await directJson(apiHost, email, password, "createfolderifnotexists",
      { folderid: "0", name: writeProbeFolder });
    if (created.metadata?.folderid === undefined)
      throw new Error("createfolderifnotexists returned no folder id.");
    folder = { id: created.metadata.folderid, created: Boolean(created.created) };
    diagnostic(
      folder.created
        ? `Created /${writeProbeFolder} (folderid ${folder.id}); it will be deleted at the end.`
        : `/${writeProbeFolder} already existed (folderid ${folder.id}); only the files this test uploads will be deleted.`,
      "success"
    );

    // Podium's current upload path, expected to fail from a web origin.
    try {
      diagnostic("Uploading with PUT and Content-Type: application/octet-stream (Podium's current code)...");
      const put = await directJson(apiHost, email, password, "uploadfile",
        { folderid: String(folder.id), filename: `put-${writeProbeFile}`, nopartial: 1 },
        { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: payload });
      for (const entry of put.metadata || []) fileIds.push(entry.fileid);
      diagnostic("The preflighted PUT upload succeeded, so Podium's current code needs no change.", "success");
    } catch (error) {
      diagnostic(`PREFLIGHTED PUT UPLOAD FAIL: ${error.message}`, "failure");
    }

    // The candidate that needs no preflight.
    const form = new FormData();
    form.append("file", new Blob([payload], { type: "application/pdf" }), writeProbeFile);
    diagnostic("Uploading with POST and multipart/form-data, which needs no preflight...");
    const started = performance.now();
    const uploaded = await directJson(apiHost, email, password, "uploadfile",
      { folderid: String(folder.id), nopartial: 1 }, { method: "POST", body: form });
    const elapsed = performance.now() - started;
    const stored = uploaded.metadata?.[0];
    if (stored?.fileid === undefined) throw new Error("uploadfile returned no file id.");
    fileIds.push(stored.fileid);
    if (Number(stored.size) !== payload.length)
      throw new Error(`uploadfile stored ${stored.size} bytes instead of ${payload.length}.`);
    const rate = (payload.length / 1024 / (elapsed / 1000)).toFixed(0);
    pass(`multipart uploadfile stored ${payload.length} bytes as fileid ${stored.fileid} ` +
      `in ${elapsed.toFixed(0)} ms (${rate} KiB/s).`);

    diagnostic("Reading the file back with getzip to compare the bytes...");
    const archive = await directBytes(apiHost, email, password, "getzip", { fileids: String(stored.fileid) });
    const entry = await extractPdfFromZip(archive);
    if (entry.bytes.length !== payload.length)
      throw new Error(`The round trip returned ${entry.bytes.length} bytes instead of ${payload.length}.`);
    if (entry.bytes.some((byte, index) => byte !== payload[index]))
      throw new Error("The round trip returned the right number of bytes, but they differ.");
    pass(`the round trip is byte-exact: ${payload.length} bytes written and read back (method ${entry.method}).`);
  } catch (error) {
    diagnostic(`WRITE FAIL: ${error.message}`, "failure");
  } finally {
    await cleanUpWriteProbe(apiHost, email, password, folder, fileIds);
    button.disabled = false;
  }
}

function useAccessToken() {
  const apiHost = elements.region.value;
  const token = elements.accessToken.value.trim();
  if (!allowedApiHosts.has(apiHost)) throw new Error("Select a valid pCloud region.");
  if (!token) throw new Error("Paste a pCloud OAuth access token.");

  state.authToken = token;
  state.tokenParam = "access_token";
  state.apiHost = apiHost;
  elements.accessToken.value = "";
  elements.listRoot.disabled = false;
  diagnostic("Using the pasted OAuth access token; it is memory-only and the input is cleared.", "success");
}

elements.origin.textContent = location.origin;
elements.secureContext.textContent = String(window.isSecureContext);

elements.directLogin.addEventListener("click", async () => {
  elements.directLogin.disabled = true;
  try {
    await directLogin();
  } catch (error) {
    elements.password.value = "";
    diagnostic(`Direct login failed: ${error.message}. Check DevTools for a CORS error.`, "failure");
  } finally {
    elements.directLogin.disabled = false;
  }
});

elements.useAccessToken.addEventListener("click", () => {
  try {
    useAccessToken();
  } catch (error) {
    diagnostic(`Access token rejected: ${error.message}`, "failure");
  }
});

elements.testWrite.addEventListener("click", () => testWrite(elements.testWrite));

elements.listRoot.addEventListener("click", async () => {
  elements.listRoot.disabled = true;
  try {
    await listRoot();
  } catch (error) {
    diagnostic(`Folder listing failed: ${error.message}`, "failure");
  } finally {
    elements.listRoot.disabled = false;
  }
});
