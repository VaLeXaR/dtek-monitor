import assert from "node:assert/strict"
import test, { afterEach, beforeEach, mock } from "node:test"

import {
  checkIsOutage,
  checkIsScheduled,
  deleteLastNotification,
  generateEmergencyOutagesMessage,
  generateMessage,
  getEmergencyOutagesNotice,
  getInfo,
  run,
  sendNotification,
} from "../src/monitor.js"
import {
  EMERGENCY_OUTAGES_MESSAGE_FILE,
  LAST_MESSAGE_FILE,
} from "../src/constants.js"

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

test("classifies scheduled, emergency, and unscheduled outages", () => {
  const noOutage = createInfo()
  const scheduled = createInfo("Планове", { start_date: "10:00" })
  const emergency = createInfo("Екстрене")
  const unscheduled = createInfo("Аварійне")

  assert.equal(checkIsOutage(noOutage, house), false)
  assert.equal(checkIsOutage(scheduled, house), true)
  assert.equal(checkIsScheduled(scheduled, house), true)
  assert.equal(checkIsScheduled(emergency, house), false)
  assert.equal(checkIsScheduled(unscheduled, house), false)
})

test("reports a missing configured house without a type error", () => {
  assert.throws(
    () => checkIsOutage({ data: {} }, house),
    /configured house is missing/,
  )
  assert.throws(
    () => checkIsScheduled({ data: {} }, house),
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

  assert.match(message, /Street &amp; &lt;name&gt;/)
  assert.match(message, /10:00 &amp; later/)
  assert.match(message, /&lt;unknown&gt;/)
  assert.match(message, /Аварійне &amp; &lt;небезпечне&gt;/)
  assert.match(message, /12:00 &quot;today&quot;/)
})

test("escapes a general emergency outages notice", () => {
  const message = generateEmergencyOutagesMessage(
    "Warning <all> & everyone",
    new Date("2026-10-08T09:05:00Z"),
  )

  assert.match(message, /^Warning &lt;all&gt; &amp; everyone/)
  assert.match(message, /12:05 08\.10\.2026/)
})

test("converts strong emphasis in an emergency notice to Telegram bold", () => {
  const message = generateEmergencyOutagesMessage(
    "Right bank: <strong>emergency & unsafe</strong>; <em>left bank</em>",
    new Date("2026-10-08T09:05:00Z"),
  )

  assert.match(
    message,
    /^Right bank: <b>emergency &amp; unsafe<\/b>; &lt;em&gt;left bank&lt;\/em&gt;/,
  )
})

test("extracts all paragraphs from a general emergency outages notice", async () => {
  const textNode = (text) => ({ nodeType: 3, textContent: text })
  const elementNode = (tagName, childNodes) => ({
    childNodes,
    nodeType: 1,
    tagName,
  })
  const noticeElement = elementNode("DIV", [
    textNode("\n    "),
    elementNode("P", [
      textNode("  Right bank: "),
      elementNode("STRONG", [textNode("emergency")]),
      textNode(".  "),
    ]),
    textNode("\n    "),
    elementNode("P", [
      textNode("Left bank: "),
      elementNode("STRONG", [textNode("scheduled")]),
      textNode(".  "),
    ]),
    textNode("\n  "),
  ])
  const browserPage = {
    locator: () => ({
      evaluate: async (callback) => callback(noticeElement),
      waitFor: async () => {},
    }),
  }

  assert.deepEqual(await getEmergencyOutagesNotice(browserPage), {
    segments: [
      { bold: false, text: "Right bank: " },
      { bold: true, text: "emergency" },
      { bold: false, text: ".\nLeft bank: " },
      { bold: true, text: "scheduled" },
      { bold: false, text: "." },
    ],
  })
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
    locator: () => ({
      count: async () => 0,
      waitFor: async () => Promise.reject(Error("missing")),
    }),
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
    getInfo({ browserType }),
    /DTEK request failed with status 503/,
  )
  assert.equal(browserClosed, true)
})

test("reports an uncertain emergency notice check instead of treating it as absent", async () => {
  const browserPage = {
    locator: () => ({
      count: async () => 1,
      waitFor: async () => Promise.reject(Error("page became unavailable")),
    }),
  }

  await assert.rejects(
    getEmergencyOutagesNotice(browserPage),
    /Emergency outages notice check failed: page became unavailable/,
  )
})

test("ignores a general modal without an emergency outages notice", async () => {
  const expectedInfo = createInfo("Аварійне")
  const browserPage = {
    evaluate: async () => expectedInfo,
    goto: async () => {},
    locator: (selector, { hasText }) => {
      assert.equal(selector, ".m-attention__text")
      assert.equal(hasText.test("Інформація для споживачів"), false)
      assert.equal(hasText.test("Застосовано екстрені відключення"), true)
      assert.equal(hasText.test("Графіки відключень не діють"), true)

      return {
        count: async () => 0,
        waitFor: async () => Promise.reject(Error("missing")),
      }
    },
    waitForSelector: async () => ({
      getAttribute: async () => "csrf-token",
    }),
  }
  const browserType = {
    launch: async () => ({
      close: async () => {},
      newPage: async () => browserPage,
    }),
  }

  assert.deepEqual(await getInfo({ browserType }), {
    ...expectedInfo,
    emergencyOutagesNotice: null,
  })
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

test("deletes a previous-day notification after an outage ends", async () => {
  let cleared = false
  let requestBody
  const deleted = await deleteLastNotification({
    clearLastMessageFn: () => {
      cleared = true
    },
    fetchFn: async (_url, options) => {
      requestBody = JSON.parse(options.body)
      return {
        json: async () => ({ ok: true }),
        ok: true,
      }
    },
    loadLastMessageFn: () => ({
      date: Date.parse("2026-10-08T20:51:00Z") / 1000,
      message_id: 123,
    }),
    telegramBotToken: "token",
    telegramChatId: "chat",
  })

  assert.equal(deleted, true)
  assert.equal(requestBody.message_id, 123)
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

test("keeps the previous Telegram notification when an update fails", async () => {
  let deleted = false
  let saved = false
  const sent = await sendNotification("message", {
    deleteLastNotificationFn: async () => {
      deleted = true
    },
    fetchFn: async () => ({
      json: async () => ({ ok: false, description: "failed" }),
      ok: false,
    }),
    loadLastMessageFn: () => ({ message_id: 123 }),
    saveLastMessageFn: () => {
      saved = true
    },
    telegramBotToken: "token",
    telegramChatId: "chat",
  })

  assert.equal(sent, false)
  assert.equal(deleted, false)
  assert.equal(saved, false)
})

for (const [notificationType, lastMessageFile] of [
  ["address outage", LAST_MESSAGE_FILE],
  ["general emergency outage", EMERGENCY_OUTAGES_MESSAGE_FILE],
]) {
  test(`updates a previous-day ${notificationType} notification`, async () => {
    let deleted = false
    const requests = []
    const savedMessages = []
    const sent = await sendNotification("current update", {
      deleteLastNotificationFn: async () => {
        deleted = true
        return true
      },
      fetchFn: async (url, options) => {
        requests.push([url, JSON.parse(options.body)])
        return {
          json: async () => ({
            ok: true,
            result: {
              date: Date.parse("2026-10-08T20:51:00Z") / 1000,
              edit_date: Date.parse("2026-10-08T21:01:00Z") / 1000,
              message_id: 123,
            },
          }),
          ok: true,
        }
      },
      lastMessageFile,
      loadLastMessageFn: () => ({
        date: Date.parse("2026-10-08T20:51:00Z") / 1000,
        message_id: 123,
      }),
      saveLastMessageFn: (message, savedFile) => {
        savedMessages.push([message, savedFile])
      },
      telegramBotToken: "token",
      telegramChatId: "chat",
    })

    assert.equal(sent, true)
    assert.equal(deleted, false)
    assert.match(requests[0][0], /\/editMessageText$/)
    assert.equal(requests[0][1].message_id, 123)
    assert.deepEqual(savedMessages, [
      [
        {
          date: Date.parse("2026-10-08T20:51:00Z") / 1000,
          edit_date: Date.parse("2026-10-08T21:01:00Z") / 1000,
          message_id: 123,
        },
        lastMessageFile,
      ],
    ])
  })
}

test("keeps an unchanged general emergency notification", async () => {
  let deleted = false
  let loadedFile
  let saved = false
  const sent = await sendNotification("same message", {
    deleteLastNotificationFn: async () => {
      deleted = true
    },
    fetchFn: async () => ({
      json: async () => ({
        ok: false,
        description:
          "Bad Request: message is not modified: specified new message content and reply markup are exactly the same",
      }),
      ok: false,
    }),
    lastMessageFile: EMERGENCY_OUTAGES_MESSAGE_FILE,
    loadLastMessageFn: (lastMessageFile) => {
      loadedFile = lastMessageFile
      return { message_id: 123 }
    },
    saveLastMessageFn: () => {
      saved = true
    },
    telegramBotToken: "token",
    telegramChatId: "chat",
  })

  assert.equal(sent, true)
  assert.equal(deleted, false)
  assert.equal(loadedFile, EMERGENCY_OUTAGES_MESSAGE_FILE)
  assert.equal(saved, false)
})

test("updates general emergency and address outage notifications independently", async () => {
  const savedStates = []
  const messages = []
  await run({
    checkIsOutageFn: () => true,
    checkIsScheduledFn: () => false,
    generateEmergencyOutagesMessageFn: (notice) => `notice: ${notice}`,
    generateMessageFn: () => "address outage",
    getInfoFn: async () => ({
      ...createInfo("Аварійне"),
      emergencyOutagesNotice: "Emergency",
    }),
    loadEmergencyOutagesStateFn: () => false,
    saveEmergencyOutagesStateFn: (active) => savedStates.push(active),
    sendNotificationFn: async (message, { lastMessageFile }) => {
      messages.push([message, lastMessageFile])
    },
  })

  assert.deepEqual(savedStates, [true])
  assert.deepEqual(messages, [
    ["notice: Emergency", EMERGENCY_OUTAGES_MESSAGE_FILE],
    ["address outage", LAST_MESSAGE_FILE],
  ])
})

test("sends only unscheduled address outage notifications", async () => {
  const messages = []
  const baseDependencies = {
    generateMessageFn: () => "outage",
    getInfoFn: async () => ({ data: {} }),
    loadEmergencyOutagesStateFn: () => false,
    sendNotificationFn: async (message) => messages.push(message),
  }

  await run({
    ...baseDependencies,
    checkIsOutageFn: () => true,
    checkIsScheduledFn: () => true,
  })
  await run({
    ...baseDependencies,
    checkIsOutageFn: () => true,
    checkIsScheduledFn: () => false,
  })

  assert.deepEqual(messages, ["outage"])
})

test("deletes the previous address notification when no outage remains", async () => {
  let deleted = false
  await run({
    checkIsOutageFn: () => false,
    checkIsScheduledFn: () => true,
    deleteLastNotificationFn: async () => {
      deleted = true
    },
    getInfoFn: async () => ({ data: {} }),
    loadEmergencyOutagesStateFn: () => false,
  })

  assert.equal(deleted, true)
})

test("resets emergency state only after its notification is deleted", async () => {
  const savedStates = []
  const deletedFiles = []
  await run({
    checkIsOutageFn: () => true,
    checkIsScheduledFn: () => true,
    deleteLastNotificationFn: async ({ lastMessageFile }) => {
      deletedFiles.push(lastMessageFile)
      return true
    },
    getInfoFn: async () => ({
      ...createInfo("Планове"),
      emergencyOutagesNotice: null,
    }),
    loadEmergencyOutagesStateFn: () => true,
    saveEmergencyOutagesStateFn: (active) => savedStates.push(active),
  })

  assert.deepEqual(savedStates, [false])
  assert.deepEqual(deletedFiles, [EMERGENCY_OUTAGES_MESSAGE_FILE])
})

test("keeps emergency state when its notification cannot be deleted", async () => {
  const savedStates = []
  await run({
    checkIsOutageFn: () => true,
    checkIsScheduledFn: () => true,
    deleteLastNotificationFn: async () => false,
    getInfoFn: async () => ({
      ...createInfo("Планове"),
      emergencyOutagesNotice: null,
    }),
    loadEmergencyOutagesStateFn: () => true,
    saveEmergencyOutagesStateFn: (active) => savedStates.push(active),
  })

  assert.deepEqual(savedStates, [])
})
