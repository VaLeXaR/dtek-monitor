import assert from "node:assert/strict"
import test, { afterEach, beforeEach, mock } from "node:test"

import {
  checkIsAccident,
  checkIsOutage,
  deleteLastNotification,
  generateMessage,
  getAddressOutageMessageHash,
  getInfo,
  run,
  sendNotification,
} from "../src/monitor.js"
import { LAST_MESSAGE_FILE } from "../src/constants.js"

const house = "1"

function createInfo(subType = "", overrides = {}) {
  return {
    data: {
      [house]: {
        sub_type: subType,
        start_date: "",
        end_date: "",
        type: "",
        ...overrides,
      },
    },
    updateTimestamp: "08.10.2026 12:00",
  }
}

beforeEach(() => {
  mock.method(console, "log", () => {})
})

afterEach(() => {
  mock.restoreAll()
})

test("classifies only accidental address outages", () => {
  const noOutage = createInfo()
  const scheduled = createInfo("Планове", { start_date: "10:00" })
  const otherType = createInfo("Інше")
  const accidental = createInfo("Аварійне")

  assert.equal(checkIsOutage(noOutage, house), false)
  assert.equal(checkIsOutage(scheduled, house), true)
  assert.equal(checkIsAccident(scheduled, house), false)
  assert.equal(checkIsAccident(otherType, house), false)
  assert.equal(checkIsAccident(accidental, house), true)
})

test("reports a missing configured house without a type error", () => {
  assert.throws(
    () => checkIsOutage({ data: {} }, house),
    /configured house is missing/,
  )
  assert.throws(
    () => checkIsAccident({ data: {} }, house),
    /configured house is missing/,
  )
})

test("escapes address and DTEK values in an outage message", () => {
  const info = createInfo("Аварійне & <небезпечне>", {
    start_date: "10:00 & later",
    end_date: "<unknown>",
  })
  info.updateTimestamp = '12:00 "today"'

  const message = generateMessage(info, {
    street: "Street & <name>",
    house,
  })

  assert.match(
    message,
    /^<b>Повідомлення з сайту ДТЕК Київські Електромережі<\/b>\n\n/,
  )
  assert.match(message, /Street &amp; &lt;name&gt;/)
  assert.match(message, /10:00 &amp; later/)
  assert.match(message, /&lt;unknown&gt;/)
  assert.match(message, /Аварійне &amp; &lt;небезпечне&gt;/)
  assert.match(message, /12:00 &quot;today&quot;/)
})

test("hashes address outage details without the update timestamp", () => {
  const outage = createInfo("Аварійне", {
    start_date: "10:00",
    end_date: "12:00",
  })
  const laterUpdate = {
    ...outage,
    updateTimestamp: "08.10.2026 12:10",
  }
  const changedOutage = createInfo("Аварійне", {
    start_date: "10:00",
    end_date: "13:00",
  })

  assert.equal(
    getAddressOutageMessageHash(outage, { street: "Street", house }),
    getAddressOutageMessageHash(laterUpdate, { street: "Street", house }),
  )
  assert.notEqual(
    getAddressOutageMessageHash(outage, { street: "Street", house }),
    getAddressOutageMessageHash(changedOutage, {
      street: "Street",
      house,
    }),
  )
})

test("gets address data without checking general DTEK notices", async () => {
  const expectedInfo = createInfo("Аварійне")
  let browserClosed = false
  const browserPage = {
    evaluate: async () => expectedInfo,
    goto: async () => {},
    waitForSelector: async () => ({
      getAttribute: async () => "csrf-token",
    }),
  }
  const browserType = {
    launch: async () => ({
      close: async () => {
        browserClosed = true
      },
      newPage: async () => browserPage,
    }),
  }

  assert.deepEqual(await getInfo({ browserType }), expectedInfo)
  assert.equal(browserClosed, true)
})

test("closes the browser and reports a failed DTEK response", async () => {
  let browserClosed = false
  mock.method(globalThis, "fetch", async () => ({
    ok: false,
    status: 503,
  }))
  const browserPage = {
    evaluate: async (callback, value) => callback(value),
    goto: async () => {},
    waitForSelector: async () => ({
      getAttribute: async () => "csrf-token",
    }),
  }
  const browserType = {
    launch: async () => ({
      close: async () => {
        browserClosed = true
      },
      newPage: async () => browserPage,
    }),
  }

  await assert.rejects(
    getInfo({ browserType, retryMaxAttempts: 1 }),
    /DTEK request failed with status 503/,
  )
  assert.equal(browserClosed, true)
})

test("deletes a Telegram notification only after a successful response", async () => {
  let cleared = false
  const deleted = await deleteLastNotification({
    clearLastMessageFn: () => {
      cleared = true
    },
    fetchFn: async () => ({
      json: async () => ({ ok: true }),
      ok: true,
    }),
    loadLastMessageFn: () => ({ message_id: 123 }),
    telegramBotToken: "token",
    telegramChatId: "chat",
  })

  assert.equal(deleted, true)
  assert.equal(cleared, true)
})

test("keeps Telegram state when deletion fails", async () => {
  let cleared = false
  const deleted = await deleteLastNotification({
    clearLastMessageFn: () => {
      cleared = true
    },
    fetchFn: async () => ({
      json: async () => ({ ok: false, description: "failed" }),
      ok: false,
    }),
    loadLastMessageFn: () => ({ message_id: 123 }),
    telegramBotToken: "token",
    telegramChatId: "chat",
  })

  assert.equal(deleted, false)
  assert.equal(cleared, false)
})

test("sends a new Telegram notification when the saved message is missing", async () => {
  const requests = []
  const savedMessages = []
  const responses = [
    {
      json: async () => ({
        ok: false,
        description: "Bad Request: message to edit not found",
      }),
      ok: false,
    },
    {
      json: async () => ({
        ok: true,
        result: { date: 1_760_277_764, message_id: 456 },
      }),
      ok: true,
    },
  ]

  const sent = await sendNotification("message", {
    fetchFn: async (url, options) => {
      requests.push([url, JSON.parse(options.body)])
      return responses.shift()
    },
    loadLastMessageFn: () => ({ message_id: 123 }),
    saveLastMessageFn: (message, savedFile) => {
      savedMessages.push([message, savedFile])
    },
    telegramBotToken: "token",
    telegramChatId: "chat",
  })

  assert.equal(sent, true)
  assert.match(requests[0][0], /\/editMessageText$/)
  assert.match(requests[1][0], /\/sendMessage$/)
  assert.deepEqual(savedMessages, [
    [{ date: 1_760_277_764, message_id: 456 }, LAST_MESSAGE_FILE],
  ])
})

test("sends only accidental address outage notifications", async () => {
  const messages = []
  const deletedFiles = []
  const baseDependencies = {
    deleteLastNotificationFn: async ({ lastMessageFile }) => {
      deletedFiles.push(lastMessageFile)
    },
    generateMessageFn: () => "outage",
    getAddressOutageMessageHashFn: () => "address-hash",
    getInfoFn: async () => ({ data: {} }),
    sendNotificationFn: async (message) => messages.push(message),
  }

  await run({
    ...baseDependencies,
    checkIsOutageFn: () => true,
    checkIsAccidentFn: () => false,
  })
  await run({
    ...baseDependencies,
    checkIsOutageFn: () => true,
    checkIsAccidentFn: () => true,
  })

  assert.deepEqual(messages, ["outage"])
  assert.deepEqual(deletedFiles, [LAST_MESSAGE_FILE])
})

test("replaces an address notification when outage details change", async () => {
  const currentOutage = createInfo("Аварійне", {
    start_date: "10:00",
    end_date: "13:00",
  })
  const previousOutage = createInfo("Аварійне", {
    start_date: "10:00",
    end_date: "12:00",
  })
  const getSourceHash = (info) =>
    getAddressOutageMessageHash(info, { street: "Street", house })
  const calls = []

  await run({
    checkIsOutageFn: () => true,
    checkIsAccidentFn: () => true,
    deleteLastNotificationFn: async (options) => {
      calls.push(["delete", options])
      return true
    },
    generateMessageFn: () => "new address outage",
    getAddressOutageMessageHashFn: getSourceHash,
    getInfoFn: async () => currentOutage,
    loadLastMessageFn: () => ({
      message_id: 123,
      source_hash: getSourceHash(previousOutage),
    }),
    sendNotificationFn: async (message, options) => {
      calls.push(["send", message, options])
      return true
    },
  })

  assert.deepEqual(calls, [
    ["delete", { lastMessageFile: LAST_MESSAGE_FILE }],
    [
      "send",
      "new address outage",
      {
        lastMessageFile: LAST_MESSAGE_FILE,
        sourceHash: getSourceHash(currentOutage),
      },
    ],
  ])
})

test("deletes the previous address notification when no outage remains", async () => {
  let deleted = false
  await run({
    checkIsOutageFn: () => false,
    checkIsAccidentFn: () => false,
    deleteLastNotificationFn: async () => {
      deleted = true
    },
    getInfoFn: async () => ({ data: {} }),
  })

  assert.equal(deleted, true)
})
