import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { chromium } from "playwright";
import factory from "../tools/jevfiller.mjs";

function schemaNode() {
  const node = {};
  for (const method of ["optional", "url", "min", "int"]) node[method] = () => node;
  return node;
}

const fakePi = {
  zod: {
    string: schemaNode,
    number: schemaNode,
    boolean: schemaNode,
    unknown: schemaNode,
    object: () => schemaNode(),
    union: () => schemaNode(),
    record: () => schemaNode(),
  },
};

const FORM = `<!doctype html>
<html><head><title>Jevfiller fixture</title></head><body>
<form id="application-form">
  <label for="first-name">First name</label>
  <input id="first-name" name="first_name" required>
  <label for="education">Highest education</label>
  <select id="education" name="education" required>
    <option value="">Choose...</option>
    <option value="Bachelor's Degree">Bachelor's Degree</option>
    <option value="Master's Degree">Master's Degree</option>
  </select>
  <label for="motivation">Why do you want to work here?</label>
  <textarea id="motivation" name="motivation" required></textarea>
  <label><input id="consent" name="consent" type="checkbox" required> I agree to the privacy terms</label>
  <button id="submit" type="submit">Submit application</button>
</form>
<script>
  document.querySelector('form').addEventListener('submit', (event) => {
    event.preventDefault();
    document.body.dataset.submitted = 'true';
  });
</script>
</body></html>`;

async function startFixture() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(FORM);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}/apply` };
}

async function launchBrowser() {
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    return chromium.launch({ headless: true });
  }
}

test("attaches to an existing Playwright server and never submits", async () => {
  const fixture = await startFixture();
  const owner = await launchBrowser();
  try {
    const ownerPage = await owner.newPage();
    await ownerPage.goto(fixture.url, { waitUntil: "domcontentloaded" });
    const { endpoint } = await owner.bind("jevfiller-test", { host: "127.0.0.1", port: 0 });
    const tool = factory(fakePi)[0];

    const result = await tool.execute("browser-smoke", {
      playwrightServerId: endpoint,
      url: fixture.url,
      tab: 0,
      answers: {
        "First name": "Example Applicant",
        "Highest education": "Bachelor's Degree",
        "Why do you want to work here?": "I want to build reliable hiring infrastructure.",
        "I agree to the privacy terms": { value: true, needs_confirmation: true },
      },
    }, undefined, undefined, undefined);

    assert.equal(result.details.submitted, false);
    assert.equal(result.details.verificationRequired, true);
    assert.equal(result.details.tab.index, 0);
    assert.equal(await ownerPage.locator("#first-name").inputValue(), "Example Applicant");
    assert.equal(await ownerPage.locator("#education").inputValue(), "Bachelor's Degree");
    assert.equal(await ownerPage.locator("#motivation").inputValue(), "I want to build reliable hiring infrastructure.");
    assert.equal(await ownerPage.locator("#consent").isChecked(), false);
    assert.equal(await ownerPage.locator("body").getAttribute("data-submitted"), null);
    assert.match(result.content[0].text, /human verification/);
  } finally {
    await owner.close().catch(() => {});
    await new Promise((resolve) => fixture.server.close(resolve));
  }
});
