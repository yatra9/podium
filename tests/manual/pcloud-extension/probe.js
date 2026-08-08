const allowedApiHosts = new Set(["api.pcloud.com", "eapi.pcloud.com"]);
const state = {
  accessToken: null,
  authToken: null,
  apiHost: null,
};

const elements = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map(element => [element.id, element])
);

function diagnostic(message, status = "") {
  const item = document.createElement("li");
  item.textContent = message;
  if (status) item.className = status;
  elements.diagnostics.append(item);
}

function randomState() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function pcloudJson(method, params = {}) {
  if ((!state.accessToken && !state.authToken) || !state.apiHost) throw new Error("Authenticate with pCloud first.");
  const url = new URL(`https://${state.apiHost}/${method}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  if (state.authToken) url.searchParams.set("auth", state.authToken);

  const response = await fetch(url, {
    headers: state.accessToken ? { Authorization: `Bearer ${state.accessToken}` } : {},
    referrerPolicy: "no-referrer",
  });
  const payload = await response.json();
  if (!response.ok || payload.result !== 0) {
    throw new Error(`${method} failed: ${payload.error || response.status} (result ${payload.result ?? "n/a"})`);
  }
  return payload;
}

async function sha1Hex(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function directCredentials(apiHost, email, password) {
  const response = await fetch(`https://${apiHost}/getdigest`, { referrerPolicy: "no-referrer" });
  const payload = await response.json();
  if (!response.ok || payload.result !== 0 || !payload.digest) {
    throw new Error(`getdigest failed: ${payload.error || response.status}`);
  }
  const usernameHash = await sha1Hex(email);
  const material = new TextEncoder().encode(password + usernameHash + payload.digest);
  return {
    username: email,
    digest: payload.digest,
    passworddigest: await sha1Hex(material),
  };
}

async function directJson(apiHost, email, password, method, params = {}) {
  const credentials = await directCredentials(apiHost, email, password);
  const url = new URL(`https://${apiHost}/${method}`);
  for (const [name, value] of Object.entries({ ...params, ...credentials })) url.searchParams.set(name, value);
  const response = await fetch(url, { referrerPolicy: "no-referrer" });
  const payload = await response.json();
  if (!response.ok || payload.result !== 0) {
    throw new Error(`${method} failed: ${payload.error || response.status} (result ${payload.result ?? "n/a"})`);
  }
  return payload;
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
  if (!link.hosts?.length || !link.path) throw new Error("getfilelink returned no download host or path.");
  diagnostic(`Direct getfilelink succeeded; downloading from ${link.hosts[0]}...`, "success");
  const response = await fetch(`https://${link.hosts[0]}${link.path}`, { referrerPolicy: "no-referrer" });
  if (!response.ok) throw new Error(`Content download failed with HTTP ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const signature = new TextDecoder("ascii").decode(bytes.subarray(0, 5));
  if (signature !== "%PDF-") throw new Error(`Downloaded ${bytes.length} bytes without a PDF signature.`);
  diagnostic(`PASS: Chrome extension directly authenticated and downloaded ${bytes.length} PDF bytes.`, "success");
}

async function directLogin() {
  const apiHost = elements.region.value;
  const email = elements.email.value.trim().toLowerCase();
  const password = elements.password.value;
  if (!allowedApiHosts.has(apiHost)) throw new Error("Select a valid pCloud data region.");
  if (!email || !password) throw new Error("Enter the pCloud email and password.");

  diagnostic(`Calling https://${apiHost}/getdigest...`);
  const digestResponse = await fetch(`https://${apiHost}/getdigest`, { referrerPolicy: "no-referrer" });
  const digestPayload = await digestResponse.json();
  if (!digestResponse.ok || digestPayload.result !== 0 || !digestPayload.digest) {
    throw new Error(`getdigest failed: ${digestPayload.error || digestResponse.status}`);
  }

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
  const loginResponse = await fetch(loginUrl, { referrerPolicy: "no-referrer" });
  const loginPayload = await loginResponse.json();
  if (!loginResponse.ok || loginPayload.result !== 0) {
    throw new Error(`Direct login failed: ${loginPayload.error || loginResponse.status} (result ${loginPayload.result ?? "n/a"})`);
  }

  if (!loginPayload.auth) {
    diagnostic("userinfo authenticated the account but returned no auth token; token issuance appears disabled for direct login.");
    await runTokenlessCapabilityTest(apiHost, email, password);
    return;
  }

  state.accessToken = null;
  state.authToken = loginPayload.auth;
  state.apiHost = apiHost;
  elements.listRoot.disabled = false;
  diagnostic(`Direct login succeeded against ${apiHost}; auth token is memory-only and expires in one hour.`, "success");
}

async function authorize() {
  const clientId = elements.clientId.value.trim();
  if (!clientId) throw new Error("Enter and save a pCloud Client ID first.");

  const expectedState = randomState();
  const redirectUri = chrome.identity.getRedirectURL();
  const url = new URL("https://my.pcloud.com/oauth2/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "token");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", expectedState);

  diagnostic("Opening pCloud OAuth authorization...");
  const responseUrl = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive: true });
  const response = new URL(responseUrl);
  const params = new URLSearchParams(response.hash.slice(1));
  const returnedState = params.get("state");
  const apiHost = params.get("hostname");
  const accessToken = params.get("access_token");

  if (returnedState !== expectedState) throw new Error("OAuth state mismatch; response rejected.");
  if (!allowedApiHosts.has(apiHost)) throw new Error(`Unexpected pCloud API host: ${apiHost || "missing"}`);
  if (!accessToken) throw new Error("OAuth response did not include an access token.");

  state.accessToken = accessToken;
  state.authToken = null;
  state.apiHost = apiHost;
  elements.listRoot.disabled = false;
  diagnostic(`OAuth succeeded; pCloud selected ${apiHost}.`, "success");
}

async function listRoot() {
  elements.files.replaceChildren();
  diagnostic(`Calling https://${state.apiHost}/listfolder for folder ID 0...`);
  const payload = await pcloudJson("listfolder", { folderid: "0" });
  const pdfs = (payload.metadata?.contents || []).filter(
    entry => !entry.isfolder && entry.name?.toLowerCase().endsWith(".pdf")
  );
  diagnostic(`Root folder listing succeeded; found ${pdfs.length} PDF file(s).`, "success");

  if (!pdfs.length) {
    const message = document.createElement("p");
    message.textContent = "No PDF exists in the pCloud root folder. Upload one there and list again.";
    elements.files.append(message);
    return;
  }

  for (const file of pdfs) {
    const row = document.createElement("div");
    row.className = "file";
    const label = document.createElement("span");
    label.textContent = `${file.name} (${file.size ?? "unknown"} bytes, file ID ${file.fileid})`;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Test private download";
    button.addEventListener("click", () => testDownload(file, button));
    row.append(label, button);
    elements.files.append(row);
  }
}

async function testDownload(file, button) {
  button.disabled = true;
  try {
    diagnostic(`Calling getfilelink for ${file.name}...`);
    const link = await pcloudJson("getfilelink", {
      fileid: String(file.fileid),
      contenttype: "application/pdf",
    });
    if (!link.hosts?.length || !link.path) throw new Error("getfilelink returned no download host or path.");
    diagnostic(`getfilelink succeeded; downloading from ${link.hosts[0]}...`, "success");

    const downloadUrl = `https://${link.hosts[0]}${link.path}`;
    const response = await fetch(downloadUrl, { referrerPolicy: "no-referrer" });
    if (!response.ok) throw new Error(`Content download failed with HTTP ${response.status}.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const signature = new TextDecoder("ascii").decode(bytes.subarray(0, 5));
    if (signature !== "%PDF-") throw new Error(`Downloaded ${bytes.length} bytes, but the PDF signature is missing.`);
    diagnostic(`PASS: Chrome extension downloaded ${bytes.length} PDF bytes from pCloud.`, "success");
  } catch (error) {
    diagnostic(`FAIL: ${error.message}`, "failure");
  } finally {
    button.disabled = false;
  }
}

elements.extensionId.textContent = chrome.runtime.id;
elements.redirectUri.textContent = chrome.identity.getRedirectURL();

chrome.storage.local.get("pcloudClientId").then(({ pcloudClientId }) => {
  if (pcloudClientId) elements.clientId.value = pcloudClientId;
});

elements.saveClientId.addEventListener("click", async () => {
  const clientId = elements.clientId.value.trim();
  await chrome.storage.local.set({ pcloudClientId: clientId });
  diagnostic("Client ID saved locally in this extension.", "success");
});

elements.directLogin.addEventListener("click", async () => {
  elements.directLogin.disabled = true;
  try {
    await directLogin();
  } catch (error) {
    elements.password.value = "";
    diagnostic(`Direct login failed: ${error.message}`, "failure");
  } finally {
    elements.directLogin.disabled = false;
  }
});

elements.authorize.addEventListener("click", async () => {
  elements.authorize.disabled = true;
  try {
    await authorize();
  } catch (error) {
    diagnostic(`OAuth failed: ${error.message}`, "failure");
  } finally {
    elements.authorize.disabled = false;
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
