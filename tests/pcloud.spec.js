const { test, expect } = require("@playwright/test");

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
