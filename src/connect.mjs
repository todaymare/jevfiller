import { chromium } from "playwright-core";

const ENDPOINT_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

export function validateEndpoint(value) {
  const raw = String(value ?? "").trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("playwrightServerId must be a Playwright wsEndpoint or a Chrome CDP URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error("playwrightServerId must not contain embedded credentials");
  }
  if (!ENDPOINT_PROTOCOLS.has(parsed.protocol)) {
    throw new Error("playwrightServerId must be an unauthenticated ws://, wss://, http://, or https:// endpoint");
  }
  return parsed.toString();
}

/**
 * Attach to an existing browser. ws(s) endpoints use Playwright's protocol;
 * http(s) endpoints use Chromium's CDP protocol.
 */
export async function connectToBrowser(serverId) {
  const endpoint = validateEndpoint(serverId);
  try {
    if (endpoint.startsWith("ws://") || endpoint.startsWith("wss://")) {
      return await chromium.connect(endpoint, { timeout: 15_000 });
    }
    return await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
  } catch (error) {
    throw new Error(`Could not attach to the existing Playwright browser: ${error instanceof Error ? error.message.slice(0, 220) : "connection failed"}`);
  }
}

export async function pagesInBrowser(browser) {
  return browser.contexts().flatMap((context) => context.pages());
}

/**
 * Select a tab without creating a page. Numeric selectors are stable within
 * the current browser snapshot. String selectors must match exactly one page's
 * URL or title, which avoids silently filling the wrong tab.
 */
export async function selectTab(browser, selector = 0) {
  const pages = await pagesInBrowser(browser);
  if (!pages.length) throw new Error("The Playwright browser has no open tabs");

  if (typeof selector === "number") {
    if (!Number.isInteger(selector) || selector < 0 || selector >= pages.length) {
      throw new Error(`tab index ${selector} is outside the ${pages.length} open tab(s)`);
    }
    return { page: pages[selector], index: selector, pages };
  }

  const value = String(selector).trim();
  if (!value) throw new Error("tab must be a non-empty index, URL, or title");
  const urlMatches = pages.filter((page) => page.url() === value);
  if (urlMatches.length === 1) return { page: urlMatches[0], index: pages.indexOf(urlMatches[0]), pages };
  if (urlMatches.length > 1) throw new Error(`tab URL matched ${urlMatches.length} open tabs; use a numeric tab index`);

  const titleMatches = [];
  for (const page of pages) {
    if ((await page.title().catch(() => "")) === value) titleMatches.push(page);
  }
  if (titleMatches.length === 1) return { page: titleMatches[0], index: pages.indexOf(titleMatches[0]), pages };
  if (titleMatches.length > 1) throw new Error(`tab title matched ${titleMatches.length} open tabs; use a numeric tab index`);
  throw new Error(`No open tab matched ${value}`);
}

/** A connected Browser.close() detaches and leaves the owner's browser alive. */
export async function detachBrowser(browser) {
  await browser.close().catch(() => {});
}
