const { test, expect } = require("@playwright/test");
const zlib = require("node:zlib");

test.beforeEach(async ({ page }) => {
  await page.goto("/pod.html");
  await expect.poll(() => page.evaluate(() => typeof window._PCloudSrc_)).toBe("function");
});

test("pCloud maps a folder listing and downloads PDF bytes", async ({ page }) => {
  const pdf = Buffer.from("%PDF-1.7\nmock pCloud PDF\n%%EOF\n");

  await page.route("https://api.pcloud.com/listfolder**", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      result: 0,
      metadata: {
        contents: [
          { isfolder: true, folderid: 42, name: "Scores", created: "Thu, 01 Jan 2026 00:00:00 +0000", modified: "Thu, 01 Jan 2026 00:00:00 +0000" },
          { isfolder: false, fileid: 99, name: "Etude.pdf", size: pdf.length, created: "Thu, 01 Jan 2026 00:00:00 +0000", modified: "Thu, 01 Jan 2026 00:00:00 +0000" },
        ],
      },
    }),
  }));
  await page.route("https://api.pcloud.com/getfilelink**", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ result: 0, hosts: ["content.pcloud.com"], path: "/mock/Etude.pdf" }),
  }));
  await page.route("https://content.pcloud.com/mock/Etude.pdf", route => route.fulfill({
    contentType: "application/pdf",
    body: pdf,
  }));

  const result = await page.evaluate(async () => {
    const authProvider = {
      authenticate: async () => {},
      requestAuth: async () => ({ apiHost: "api.pcloud.com", params: { testauth: "yes" }, headers: {} }),
    };
    const src = new window._PCloudSrc_(authProvider);
    const dir = await src.getDir("");
    const file = await src.getFile("", "Etude.pdf");
    return {
      directoryId: dir.dirs.Scores.id,
      fileId: dir.files["Etude.pdf"].id,
      signature: new TextDecoder("ascii").decode(new Uint8Array(file.data).subarray(0, 5)),
    };
  });

  expect(result).toEqual({ directoryId: 42, fileId: 99, signature: "%PDF-" });
});

/**
 * Builds a single-member archive the way pCloud streams one: the local header
 * leaves its own size fields zero and sets the data-descriptor flag, so only the
 * central directory is authoritative.
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

/** Serves listfolder so a PCloudSrc can reach one file in the root. */
async function mockListfolder(page, size) {
  await page.route("https://api.pcloud.com/listfolder**", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      result: 0,
      metadata: { contents: [{ isfolder: false, fileid: 99, name: "Etude.pdf", size }] },
    }),
  }));
}

for (const method of [8, 0]) {
  test(`pCloud reads a file through getzip when the mechanism needs it (method ${method})`, async ({ page }) => {
    const pdf = Buffer.from(`%PDF-1.7\n${"mock pCloud score ".repeat(32)}\n%%EOF\n`);
    const zipRequests = [];
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));

    await mockListfolder(page, pdf.length);
    await page.route("https://api.pcloud.com/getzip**", route => {
      zipRequests.push(new URL(route.request().url()));
      route.fulfill({
        contentType: "application/zip",
        body: buildZip("Etude.pdf", pdf, { method, streamed: method === 8 }),
      });
    });
    // getfilelink must not be reached: from a deployed web origin it is refused.
    await page.route("https://api.pcloud.com/getfilelink**", route => route.abort("failed"));

    const result = await page.evaluate(async () => {
      const src = new window._PCloudSrc_({
        authenticate: async () => {},
        requestAuth: async () => ({ apiHost: "api.pcloud.com", params: { testauth: "yes" }, headers: {} }),
        contentAccess: "zip",
      });
      const file = await src.getFile("", "Etude.pdf");
      return {
        isArrayBuffer: file.data instanceof ArrayBuffer,
        bytes: [...new Uint8Array(file.data)],
      };
    });

    expect(result.isArrayBuffer).toBe(true);
    expect(Buffer.from(result.bytes)).toEqual(pdf);
    expect(zipRequests).toHaveLength(1);
    expect(zipRequests[0].searchParams.get("fileids")).toBe("99");
    expect(errors).toEqual([]);
  });
}

test("pCloud surfaces a getzip error envelope rather than parsing it as an archive", async ({ page }) => {
  await mockListfolder(page, 1024);
  await page.route("https://api.pcloud.com/getzip**", route => route.fulfill({
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({ result: 1000, error: "Log in required." }),
  }));

  const message = await page.evaluate(async () => {
    const src = new window._PCloudSrc_({
      authenticate: async () => {},
      requestAuth: async () => ({ apiHost: "api.pcloud.com", params: {}, headers: {} }),
      contentAccess: "zip",
    });
    try {
      await src.getFile("", "Etude.pdf");
      return "no error";
    } catch (error) {
      return error.message;
    }
  });

  expect(message).toBe("pCloud getzip failed: Log in required. (result 1000).");
});

test("pCloud uploads as multipart/form-data so the request is never preflighted", async ({ page }) => {
  const pdf = Buffer.from("%PDF-1.7\nmock pCloud PDF\n%%EOF\n");
  const uploads = [];
  const authorized = [];
  page.on("request", request => {
    if (request.headers().authorization) authorized.push(request.url());
  });

  await mockListfolder(page, pdf.length);
  await page.route("https://api.pcloud.com/uploadfile**", route => {
    const request = route.request();
    uploads.push({
      method: request.method(),
      contentType: request.headers()["content-type"] || "",
      url: new URL(request.url()),
      body: request.postDataBuffer(),
    });
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ result: 0, metadata: [{ fileid: 100, name: "New.pdf", size: pdf.length }] }),
    });
  });

  await page.evaluate(async bytes => {
    const src = new window._PCloudSrc_({
      authenticate: async () => {},
      requestAuth: async () => ({ apiHost: "api.pcloud.com", params: { testauth: "yes" }, headers: {} }),
      contentAccess: "zip",
    });
    await src.putFile("", "New.pdf", new Uint8Array(bytes));
  }, [...pdf]);

  expect(uploads).toHaveLength(1);
  expect(uploads[0].method).toBe("POST");
  // The three safelisted Content-Type values are the only ones api.pcloud.com
  // can accept from a web origin: it never answers OPTIONS with an
  // Access-Control-Allow-Headers field.
  expect(uploads[0].contentType).toMatch(/^multipart\/form-data; boundary=/);
  expect(authorized).toEqual([]);
  // The part carries the name, so the filename parameter is not needed.
  expect(uploads[0].url.searchParams.get("filename")).toBeNull();
  expect(uploads[0].url.searchParams.get("nopartial")).toBe("1");
  expect(uploads[0].body.includes(`filename="New.pdf"`)).toBe(true);
  expect(uploads[0].body.includes(pdf)).toBe(true);
});

test("pCloud reuses one digest until it is close to expiring", async ({ page }) => {
  // Every operation would otherwise cost two round trips: signing each request
  // separately measured 2.01x the time of reusing one digest.
  const fetched = [];
  for (const host of ["api", "eapi"])
    await page.route(`https://${host}.pcloud.com/getdigest**`, route => {
      fetched.push(host);
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          result: 0,
          digest: `${host}-digest-${fetched.filter(entry => entry === host).length}`,
          expires: new Date(Date.now() + 30000).toUTCString(),
        }),
      });
    });

  const result = await page.evaluate(async () => {
    const auth = new window._PCloudDirectAuth_();
    auth.sessionRestored = true;
    auth.email = "probe@example.test";
    auth.password = "secret";
    auth.apiHost = "api.pcloud.com";

    const first = await auth.requestAuth();
    const cached = await auth.requestAuth();
    // Bring the expiry inside the margin: the digest must then be replaced
    // rather than used until the last moment, because the expiry is the
    // server's and says nothing about this clock.
    auth.digest.expires = Date.now() + 1000;
    const renewed = await auth.requestAuth();
    // A region change must not reuse the other host's digest.
    auth.apiHost = "eapi.pcloud.com";
    const switched = await auth.requestAuth();

    return {
      digests: [first, cached, renewed, switched].map(auth => auth.params.digest),
      hosts: [first, cached, renewed, switched].map(auth => auth.apiHost),
      // The signature must be recomputed, not carried over with the old digest.
      resigned: first.params.passworddigest !== renewed.params.passworddigest,
    };
  });

  expect(result.digests).toEqual([
    "api-digest-1", "api-digest-1", "api-digest-2", "eapi-digest-1",
  ]);
  expect(result.hosts).toEqual([
    "api.pcloud.com", "api.pcloud.com", "api.pcloud.com", "eapi.pcloud.com",
  ]);
  expect(result.resigned).toBe(true);
  expect(fetched).toEqual(["api", "api", "eapi"]);
});

test("the web password store keeps no plaintext and no readable key", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const store = new window._WebPasswordStore_();
    const password = "correct horse battery staple";
    await store.set(password);

    const saved = sessionStorage.getItem("pcloud-password");
    const keys = await store.withStore("readonly", s => new Promise(resolve => {
      const request = s.getAllKeys();
      request.onsuccess = () => resolve(request.result);
    }));
    const record = await store.withStore("readonly", s => new Promise(resolve => {
      const request = s.get(keys[0]);
      request.onsuccess = () => resolve(request.result);
    }));

    let exported = "refused";
    try {
      await crypto.subtle.exportKey("raw", record.key);
      exported = "allowed";
    } catch (_error) { /* a non-extractable key cannot be read back out */ }

    const restored = await store.get();
    await store.clear();

    return {
      restored,
      // Neither the password nor anything resembling it may be in the store.
      sessionStorageHasPlaintext: saved.includes(password),
      sessionStorageHasId: JSON.parse(saved).id === keys[0],
      keyCount: keys.length,
      extractable: record.key.extractable,
      exported,
      clearedItem: sessionStorage.getItem("pcloud-password"),
      clearedKeys: (await store.withStore("readonly", s => new Promise(resolve => {
        const request = s.getAllKeys();
        request.onsuccess = () => resolve(request.result);
      }))).length,
    };
  });

  expect(result).toEqual({
    restored: "correct horse battery staple",
    sessionStorageHasPlaintext: false,
    sessionStorageHasId: true,
    keyCount: 1,
    extractable: false,
    exported: "refused",
    clearedItem: null,
    clearedKeys: 0,
  });
});

test("the web password store sweeps aged keys but spares another tab's", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const store = new window._WebPasswordStore_();
    const keys = () => store.withStore("readonly", s => new Promise(resolve => {
      const request = s.getAllKeys();
      request.onsuccess = () => resolve(request.result);
    }));

    await store.set("secret");
    // Stand in for another tab holding its own key: this tab has no ciphertext
    // for it, but it is in use and must survive.
    const [otherTabsKey] = await keys();
    sessionStorage.removeItem("pcloud-password");
    const orphaned = await store.get();
    const spared = (await keys()).length;

    // Backdate it past the lifetime, and now it is nobody's.
    await store.withStore("readwrite", s => new Promise(resolve => {
      const get = s.get(otherTabsKey);
      get.onsuccess = () => {
        const put = s.put({ ...get.result, created: 0 }, otherTabsKey);
        put.onsuccess = () => resolve();
      };
    }));
    await store.get();
    const swept = (await keys()).length;

    // Replacing a password must not leave the previous key behind.
    await store.set("first");
    await store.set("second");
    return { orphaned, spared, swept, keysAfterReplacing: (await keys()).length, current: await store.get() };
  });

  expect(result).toEqual({
    orphaned: null, spared: 1, swept: 0, keysAfterReplacing: 1, current: "second",
  });
});

test("the web password store asks again when the ciphertext does not match the key", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const store = new window._WebPasswordStore_();
    await store.set("secret");
    // Tamper with one byte of the ciphertext: AES-GCM must refuse it.
    const saved = JSON.parse(sessionStorage.getItem("pcloud-password"));
    saved.data[0] ^= 0xff;
    sessionStorage.setItem("pcloud-password", JSON.stringify(saved));
    const tampered = await store.get();
    return { tampered, item: sessionStorage.getItem("pcloud-password") };
  });

  // Refusing must also clean up, or the next load would retry the same failure.
  expect(result).toEqual({ tampered: null, item: null });
});

test("pCloud OAuth validates the redirect and restores its session token", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const session = {};
    let launches = 0;
    window.chrome = {};
    window.chrome.runtime = { id: "gdekbcnhempebaocajciooibhhgnbdjb" };
    window.chrome.storage = {
      session: {
        get: async key => ({ [key]: session[key] }),
        set: async values => Object.assign(session, values),
        remove: async key => delete session[key],
      },
    };
    window.chrome.identity = {
      getRedirectURL: () => "https://gdekbcnhempebaocajciooibhhgnbdjb.chromiumapp.org/",
      launchWebAuthFlow: async ({ url, interactive }) => {
        launches++;
        const state = new URL(url).searchParams.get("state");
        if (!interactive) throw new Error("OAuth must be interactive");
        return `https://gdekbcnhempebaocajciooibhhgnbdjb.chromiumapp.org/` +
          `#access_token=test-token&token_type=bearer&hostname=eapi.pcloud.com&state=${state}`;
      },
    };

    const first = new window._PCloudOAuthAuth_();
    const firstAuth = await first.requestAuth();
    const restored = new window._PCloudOAuthAuth_();
    const restoredAuth = await restored.requestAuth();
    return { firstAuth, restoredAuth, launches };
  });

  expect(result).toEqual({
    firstAuth: {
      apiHost: "eapi.pcloud.com",
      params: {},
      headers: { Authorization: "Bearer test-token" },
    },
    restoredAuth: {
      apiHost: "eapi.pcloud.com",
      params: {},
      headers: { Authorization: "Bearer test-token" },
    },
    launches: 1,
  });
});
