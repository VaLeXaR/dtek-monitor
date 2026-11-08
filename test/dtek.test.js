import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { afterEach, mock } from "node:test"

import {
  DTEK_TIMEOUT_MS,
  getAddressInfoFromForm,
  isAddressResponse,
  loadBrowserState,
  readAddressResponse,
  saveBrowserState,
} from "../src/dtek.js"

const street = "вул. Прикладна (Тестова)"

function response(
  body,
  { method = "getHomeNum", target = street, status = 200 } = {}
) {
  return {
    url: () => "https://www.dtek-kem.com.ua/ua/ajax",
    request: () => ({
      method: () => "POST",
      postData: () =>
        new URLSearchParams({
          method,
          "data[0][name]": "street",
          "data[0][value]": target,
        }).toString(),
    }),
    ok: () => status >= 200 && status < 300,
    status: () => status,
    text: async () => body,
  }
}

afterEach(() => mock.restoreAll())

test("matches only the native address response for the configured street", () => {
  assert.equal(isAddressResponse(response(""), street), true)
  assert.equal(
    isAddressResponse(response("", { target: street.toUpperCase() }), street),
    true
  )
  assert.equal(
    isAddressResponse(response("", { method: "getCekText" }), street),
    false
  )
  assert.equal(
    isAddressResponse(response("", { target: "Another street" }), street),
    false
  )
  assert.equal(
    isAddressResponse(
      {
        ...response(""),
        url: () => "https://example.com/ua/ajax",
      },
      street
    ),
    false
  )
  assert.equal(
    isAddressResponse(
      {
        ...response(""),
        request: () => ({ method: () => "GET" }),
      },
      street
    ),
    false
  )
})

for (const [body, status, error] of [
  [
    '<html><script src="/_Incapsula_Resource?private"></script></html>',
    200,
    /Incapsula blocked/,
  ],
  ["<html>Maintenance</html>", 200, /HTML received instead of JSON/],
  ["private invalid data", 200, /invalid JSON/],
  ["{}", 503, /status 503/],
  ['{"result":false,"data":{}}', 200, /unsuccessful or invalid/],
  ['{"result":true,"data":[]}', 200, /unsuccessful or invalid/],
  ["null", 200, /unsuccessful or invalid/],
]) {
  test(`rejects unusable address response: ${error}`, async () => {
    await assert.rejects(
      readAddressResponse(response(body, { status })),
      (value) => {
        assert.match(value.message, error)
        assert.doesNotMatch(value.message, /private/)
        return true
      }
    )
  })
}

test("uses the native form, closes the notice, and subscribes before selection", async () => {
  const events = []
  const info = { result: true, data: { 1: { sub_type: "Аварійне" } } }
  const reply = response(JSON.stringify(info))
  const option = {
    waitFor: async () => events.push("option ready"),
    click: async () => events.push("select street"),
  }
  const page = {
    waitForFunction: async (callback, value, { timeout }) => {
      assert.equal(timeout, DTEK_TIMEOUT_MS)
      events.push("form ready")
    },
    locator: (selector) => {
      if (selector === ".m-attention__close:visible") {
        return {
          all: async () => [{ click: async () => events.push("close notice") }],
        }
      }
      if (selector === "#discon_form #street") {
        return {
          fill: async (value) => {
            assert.equal(value, street)
            events.push("fill street")
          },
        }
      }
      assert.equal(selector, "#streetautocomplete-list > div")
      return {
        filter: ({ hasText }) => {
          assert.equal(hasText.test(street), true)
          assert.equal(hasText.test(street.toLowerCase()), true)
          assert.equal(hasText.test(`${street} extra`), false)
          assert.equal(hasText.test("вул. Прикладна Тестова"), false)
          return option
        },
      }
    },
    waitForResponse: async (predicate, { timeout }) => {
      assert.equal(timeout, DTEK_TIMEOUT_MS)
      assert.equal(predicate(reply), true)
      events.push("subscribe")
      return reply
    },
  }
  assert.deepEqual(await getAddressInfoFromForm(page, street), info)
  assert.deepEqual(events, [
    "form ready",
    "close notice",
    "fill street",
    "option ready",
    "subscribe",
    "select street",
  ])
})

test("bounds readiness waits and does not expose private selectors in errors", async () => {
  const page = {
    waitForFunction: async () => {
      const error = Error(`private selector ${street}`)
      error.name = "TimeoutError"
      throw error
    },
  }
  await assert.rejects(getAddressInfoFromForm(page, street), (error) => {
    assert.match(error.message, /timeout/)
    assert.doesNotMatch(error.message, /private|Прикладна/)
    return true
  })
  await assert.rejects(
    getAddressInfoFromForm(page, ""),
    /STREET must be configured/
  )
})

test("stores only DTEK session data atomically with private permissions", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dtek-session-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, "session", "state.json")
  assert.equal(loadBrowserState(file), undefined)
  const state = {
    cookies: [
      { name: "site", value: "private", domain: ".dtek-kem.com.ua" },
      { name: "visitor", value: "private", domain: "www.dtek-kem.com.ua" },
      { name: "analytics", value: "other", domain: ".example.com" },
    ],
    origins: [
      { origin: "https://www.dtek-kem.com.ua", localStorage: [] },
      { origin: "https://example.com", localStorage: [] },
    ],
  }
  await saveBrowserState(
    { storageState: async () => structuredClone(state) },
    file
  )
  assert.deepEqual(loadBrowserState(file), {
    cookies: state.cookies.slice(0, 2),
    origins: state.origins.slice(0, 1),
  })
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  }
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["state.json"])
  await saveBrowserState(
    {
      storageState: async () => {
        throw Error("private session data")
      },
    },
    file
  )
  assert.equal(loadBrowserState(file).cookies.length, 2)
})

test("ignores corrupted session data without logging its content", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dtek-corrupt-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, "state.json")
  const messages = []
  mock.method(console, "warn", (...args) => messages.push(args.join(" ")))
  for (const contents of ["private invalid JSON", "null", '{"cookies":{}}']) {
    fs.writeFileSync(file, contents)
    assert.equal(loadBrowserState(file), undefined)
  }
  assert.equal(messages.length, 3)
  assert.doesNotMatch(messages.join("\n"), /private/)
})

test("reports a safe filesystem error code while preserving existing session data", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dtek-unwritable-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, "state.json")
  const contents = JSON.stringify({ cookies: [], origins: [] })
  fs.writeFileSync(file, contents)
  const messages = []
  mock.method(console, "warn", (...args) => messages.push(args.join(" ")))
  mock.method(fs, "writeFileSync", () => {
    const error = Error("private session and path must not be logged")
    error.code = "EACCES"
    throw error
  })
  await saveBrowserState(
    { storageState: async () => ({ cookies: [], origins: [] }) },
    file
  )
  assert.equal(fs.readFileSync(file, "utf8"), contents)
  assert.equal(messages.length, 1)
  assert.match(messages[0], /EACCES/)
  assert.doesNotMatch(messages[0], /private|must not be logged/)
})
