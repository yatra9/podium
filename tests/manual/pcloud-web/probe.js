const allowedApiHosts = new Set(["api.pcloud.com", "eapi.pcloud.com"]);
const state = { authToken: null, apiHost: null };
const elements = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map(element => [element.id, element])
);

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

async function pcloudJson(method, params = {}) {
  if (!state.authToken || !state.apiHost) throw new Error("Log in first.");
  const url = new URL(`https://${state.apiHost}/${method}`);
  url.searchParams.set("auth", state.authToken);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return responseJson(await fetch(url), method);
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

async function directJson(apiHost, email, password, method, params = {}) {
  const credentials = await directCredentials(apiHost, email, password);
  const url = new URL(`https://${apiHost}/${method}`);
  for (const [name, value] of Object.entries({ ...params, ...credentials })) url.searchParams.set(name, value);
  return responseJson(await fetch(url), method);
}

async function runTokenlessCapabilityTest(apiHost, email, password) {
  diagnostic("Falling back to per-request digest authentication for listfolder...");
  const listing = await directJson(apiHost, email, password, "listfolder", { folderid: "0" });
  const pdf = (listing.metadata?.contents || []).find(
    entry => !entry.isfolder && entry.name?.toLowerCase().endsWith(".pdf")
  );
  if (!pdf) throw new Error("Direct listfolder succeeded, but no PDF exists in the pCloud root folder.");
  diagnostic(`Direct listfolder succeeded; testing ${pdf.name}...`, "success");

  const link = await directJson(apiHost, email, password, "getfilelink", {
    fileid: String(pdf.fileid),
    contenttype: "application/pdf",
  });
  if (!link.hosts?.length || !link.path) throw new Error("getfilelink returned no host or path.");
  diagnostic(`Direct getfilelink succeeded; fetching ${link.hosts[0]}...`, "success");
  const response = await fetch(`https://${link.hosts[0]}${link.path}`);
  if (!response.ok) throw new Error(`Content download failed with HTTP ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const signature = new TextDecoder("ascii").decode(bytes.subarray(0, 5));
  if (signature !== "%PDF-") throw new Error(`Received ${bytes.length} bytes without a PDF signature.`);
  diagnostic(`LOCALHOST PASS: direct authentication downloaded ${bytes.length} PDF bytes. A deployed-origin test is still required.`, "success");
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
  loginUrl.searchParams.set("logout", "1");
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
  state.apiHost = apiHost;
  elements.listRoot.disabled = false;
  diagnostic("Direct login succeeded; auth token is memory-only.", "success");
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
    const button = document.createElement("button");
    button.textContent = "Test web download";
    button.addEventListener("click", () => testDownload(file, button));
    row.append(label, button);
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
    diagnostic(`LOCALHOST PASS: downloaded ${bytes.length} PDF bytes. This still requires a deployed-origin test.`, "success");
  } catch (error) {
    diagnostic(`WEB DOWNLOAD FAIL: ${error.message}`, "failure");
  } finally {
    button.disabled = false;
  }
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
