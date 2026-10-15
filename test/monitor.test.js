import assert from "node:assert/strict"
import test, { afterEach, beforeEach, mock } from "node:test"

import {
  checkIsOutage,
  checkIsScheduled,
  deleteLastNotification,
  generateEmergencyOutagesMessage,
  generateMessage,
  getAddressOutageMessageHash,
  getEmergencyOutagesNoticeHash,
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

test("escapes a general emergency outages notice", () => {
  const message = generateEmergencyOutagesMessage(
    "Warning <all> & everyone",
    new Date("2026-10-08T09:05:00Z"),
  )

  assert.match(
    message,
    /^<b>Повідомлення з сайту ДТЕК Київські Електромережі<\/b>\n\nWarning &lt;all&gt; &amp; everyone/,
  )
  assert.match(message, /12:05 08\.10\.2026/)
})

test("converts strong emphasis in an emergency notice to Telegram bold", () => {
  const message = generateEmergencyOutagesMessage(
    "Right bank: <strong>emergency & unsafe</strong>; <em>left bank</em>",
    new Date("2026-10-08T09:05:00Z"),
  )

  assert.match(
    message,
    /Right bank: <b>emergency &amp; unsafe<\/b>; &lt;em&gt;left bank&lt;\/em&gt;/,
  )
})

test("hashes normalized visible emergency notice text", () => {
  const plainNotice = {
    segments: [{ bold: false, text: "  Emergency   outages  " }],
  }
  const formattedNotice = {
    segments: [
      { bold: false, text: "Emergency " },
      { bold: true, text: "outages" },
    ],
  }
  const changedNotice = {
    segments: [{ bold: false, text: "Emergency outage ended" }],
  }

  assert.equal(
    getEmergencyOutagesNoticeHash(plainNotice),
    getEmergencyOutagesNoticeHash(formattedNotice),
  )
  assert.notEqual(
    getEmergencyOutagesNoticeHash(plainNotice),
    getEmergencyOutagesNoticeHash(changedNotice),
  )
})

test("extracts matching DTEK notices and preserves their paragraphs", async () => {
  const textNode = (text) => ({ nodeType: 3, textContent: text })
  const elementNode = (tagName, childNodes) => ({
    childNodes,
    nodeType: 1,
    tagName,
  })
  const noticeElement = elementNode("DIV", [
    textNode("\n    "),
    elementNode("P", [
      textNode("  Right bank: зафіксовано "),
      elementNode("STRONG", [textNode("emergency")]),
      textNode(".  "),
    ]),
    textNode("\n    "),
    elementNode("P", [
      textNode("Left bank: застосовано "),
      elementNode("STRONG", [textNode("scheduled")]),
      textNode(".  "),
    ]),
    textNode("\n  "),
  ])
  const notices = {
    evaluateAll: async (callback) => callback([noticeElement]),
    waitFor: async () => {},
  }
  const browserPage = {
    locator: (selector, options) => {
      assert.equal(selector, ".m-attention__text")
      assert.deepEqual(options, {
        hasText: /застосовано|не діють|зафіксовано|зникло світло/i,
      })
      return {
        filter: (filterOptions) => {
          assert.deepEqual(filterOptions, { visible: true })
          return {
            ...notices,
            first: () => notices,
          }
        },
      }
    },
  }

  assert.deepEqual(await getEmergencyOutagesNotice(browserPage), {
    segments: [
      { bold: false, text: "Right bank: зафіксовано " },
      { bold: true, text: "emergency" },
      { bold: false, text: ".\nLeft bank: застосовано " },
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
      filter: () => ({
        count: async () => 0,
        first: () => ({
          waitFor: async () => Promise.reject(Error("missing")),
        }),
      }),
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
    getInfo({ browserType, retryMaxAttempts: 1 }),
    /DTEK request failed with status 503/,
  )
  assert.equal(browserClosed, true)
})

test("retries a transient browser launch failure", async () => {
  let launches = 0
  const delays = []
  const expectedInfo = createInfo("Аварійне")
  const browserPage = {
    evaluate: async () => expectedInfo,
    goto: async () => {},
    locator: () => ({
      filter: () => ({
        count: async () => 0,
        first: () => ({
          waitFor: async () => Promise.reject(Error("missing")),
        }),
      }),
    }),
    waitForSelector: async () => ({
      getAttribute: async () => "csrf-token",
    }),
  }
  const browserType = {
    launch: async () => {
      launches += 1
      if (launches === 1) throw Error("browser unavailable")
      return {
        close: async () => {},
        newPage: async () => browserPage,
      }
    },
  }

  assert.deepEqual(
    await getInfo({
      browserType,
      retryDelayMs: 10,
      retryMaxAttempts: 2,
      sleepFn: async (delay) => delays.push(delay),
    }),
    { ...expectedInfo, emergencyOutagesNotice: null },
  )
  assert.equal(launches, 2)
  assert.deepEqual(delays, [10])
})

test("reports an uncertain emergency notice check instead of treating it as absent", async () => {
  const browserPage = {
    locator: () => ({
      filter: () => ({
        count: async () => 1,
        first: () => ({
          waitFor: async () =>
            Promise.reject(Error("page became unavailable")),
        }),
      }),
    }),
  }

  await assert.rejects(
    getEmergencyOutagesNotice(browserPage),
    /Emergency outages notice check failed: page became unavailable/,
  )
})

test("collects a matching general DTEK notice", async () => {
  const expectedInfo = createInfo("Аварійне")
  const expectedNotice = {
    segments: [{ bold: false, text: "Застосовано аварійні графіки" }],
  }
  const notices = {
    evaluateAll: async () => expectedNotice,
    waitFor: async () => {},
  }
  const browserPage = {
    evaluate: async () => expectedInfo,
    goto: async () => {},
    locator: (selector, options) => {
      assert.equal(selector, ".m-attention__text")
      assert.deepEqual(options, {
        hasText: /застосовано|не діють|зафіксовано|зникло світло/i,
      })

      return {
        filter: (filterOptions) => {
          assert.deepEqual(filterOptions, { visible: true })
          return {
            ...notices,
            first: () => notices,
          }
        },
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
    emergencyOutagesNotice: expectedNotice,
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

test("clears stale state when a Telegram notification is already missing", async () => {
  let cleared = false
  const deleted = await deleteLastNotification({
    clearLastMessageFn: () => {
      cleared = true
    },
    fetchFn: async () => ({
      json: async () => ({
        ok: false,
        description: "Bad Request: message to delete not found",
      }),
      ok: false,
    }),
    loadLastMessageFn: () => ({ message_id: 123 }),
    telegramBotToken: "token",
    telegramChatId: "chat",
  })

  assert.equal(deleted, true)
  assert.equal(cleared, true)
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
  assert.equal(requests[0][1].message_id, 123)
  assert.match(requests[1][0], /\/sendMessage$/)
  assert.equal(Object.hasOwn(requests[1][1], "message_id"), false)
  assert.deepEqual(savedMessages, [
    [
      { date: 1_760_277_764, message_id: 456 },
      LAST_MESSAGE_FILE,
    ],
  ])
})

test("saves a source hash after sending a general notification", async () => {
  let savedMessage
  const sent = await sendNotification("message", {
    fetchFn: async () => ({
      json: async () => ({
        ok: true,
        result: { date: 1_760_277_764, message_id: 456 },
      }),
      ok: true,
    }),
    lastMessageFile: EMERGENCY_OUTAGES_MESSAGE_FILE,
    loadLastMessageFn: () => null,
    saveLastMessageFn: (message) => {
      savedMessage = message
    },
    sourceHash: "current-hash",
    telegramBotToken: "token",
    telegramChatId: "chat",
  })

  assert.equal(sent, true)
  assert.deepEqual(savedMessage, {
    date: 1_760_277_764,
    message_id: 456,
    source_hash: "current-hash",
  })
})

test("retries a transient Telegram failure without clearing state", async () => {
  const delays = []
  const requestBodies = []
  let requests = 0
  let savedMessage

  const sent = await sendNotification("message", {
    fetchFn: async (_url, options) => {
      requests += 1
      requestBodies.push(JSON.parse(options.body))
      if (requests === 1) {
        return {
          json: async () => ({ ok: false, description: "unavailable" }),
          ok: false,
          status: 503,
        }
      }

      return {
        json: async () => ({
          ok: true,
          result: { date: 1_760_277_764, message_id: 456 },
        }),
        ok: true,
        status: 200,
      }
    },
    loadLastMessageFn: () => ({ message_id: 123 }),
    now: new Date("2026-10-08T09:00:00Z"),
    retryDelayMs: 10,
    retryMaxAttempts: 2,
    saveLastMessageFn: (message) => {
      savedMessage = message
    },
    sleepFn: async (delay) => delays.push(delay),
    telegramBotToken: "token",
    telegramChatId: "chat",
  })

  assert.equal(sent, true)
  assert.equal(requests, 2)
  assert.deepEqual(delays, [10])
  assert.equal(requestBodies[0].disable_notification, false)
  assert.deepEqual(savedMessage, {
    date: 1_760_277_764,
    message_id: 456,
  })
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
      return { message_id: 123, source_hash: "same-hash" }
    },
    saveLastMessageFn: () => {
      saved = true
    },
    telegramBotToken: "token",
    telegramChatId: "chat",
    sourceHash: "same-hash",
  })

  assert.equal(sent, true)
  assert.equal(deleted, false)
  assert.equal(loadedFile, EMERGENCY_OUTAGES_MESSAGE_FILE)
  assert.equal(saved, false)
})

test("stores a source hash for an unchanged legacy notification", async () => {
  let savedMessage
  const sent = await sendNotification("same message", {
    fetchFn: async () => ({
      json: async () => ({
        ok: false,
        description: "Bad Request: message is not modified",
      }),
      ok: false,
    }),
    lastMessageFile: EMERGENCY_OUTAGES_MESSAGE_FILE,
    loadLastMessageFn: () => ({ date: 123, message_id: 456 }),
    saveLastMessageFn: (message) => {
      savedMessage = message
    },
    sourceHash: "current-hash",
    telegramBotToken: "token",
    telegramChatId: "chat",
  })

  assert.equal(sent, true)
  assert.deepEqual(savedMessage, {
    date: 123,
    message_id: 456,
    source_hash: "current-hash",
  })
})

test("updates general emergency and address outage notifications independently", async () => {
  const savedStates = []
  const messages = []
  await run({
    checkIsOutageFn: () => true,
    checkIsScheduledFn: () => false,
    generateEmergencyOutagesMessageFn: (notice) => `notice: ${notice}`,
    generateMessageFn: () => "address outage",
    getAddressOutageMessageHashFn: () => "address-hash",
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

test("updates the same general notification when visible text is unchanged", async () => {
  const notice = {
    segments: [
      { bold: false, text: "Emergency " },
      { bold: true, text: "outages" },
    ],
  }
  const previousNotice = {
    segments: [{ bold: false, text: "Emergency outages" }],
  }
  const calls = []

  await run({
    checkIsOutageFn: () => true,
    checkIsScheduledFn: () => true,
    deleteLastNotificationFn: async () => {
      calls.push("delete")
      return true
    },
    generateEmergencyOutagesMessageFn: () => "formatted notice",
    getInfoFn: async () => ({
      ...createInfo("Планове"),
      emergencyOutagesNotice: notice,
    }),
    loadEmergencyOutagesStateFn: () => true,
    loadLastMessageFn: () => ({
      message_id: 123,
      source_hash: getEmergencyOutagesNoticeHash(previousNotice),
    }),
    sendNotificationFn: async (_message, options) => {
      calls.push(["send", options])
      return true
    },
  })

  assert.deepEqual(calls, [
    [
      "send",
      {
        lastMessageFile: EMERGENCY_OUTAGES_MESSAGE_FILE,
        sourceHash: getEmergencyOutagesNoticeHash(notice),
      },
    ],
  ])
})

test("updates a legacy general notification without replacing it", async () => {
  const calls = []

  await run({
    checkIsOutageFn: () => true,
    checkIsScheduledFn: () => true,
    deleteLastNotificationFn: async () => {
      calls.push("delete")
      return true
    },
    generateEmergencyOutagesMessageFn: () => "current notice",
    getInfoFn: async () => ({
      ...createInfo("Планове"),
      emergencyOutagesNotice: "Current emergency notice",
    }),
    loadEmergencyOutagesStateFn: () => true,
    loadLastMessageFn: () => ({ message_id: 123 }),
    sendNotificationFn: async (_message, options) => {
      calls.push(["send", options])
      return true
    },
  })

  assert.deepEqual(calls, [
    [
      "send",
      {
        lastMessageFile: EMERGENCY_OUTAGES_MESSAGE_FILE,
        sourceHash: getEmergencyOutagesNoticeHash(
          "Current emergency notice",
        ),
      },
    ],
  ])
})

test("rotates a general notification before Telegram's deletion deadline", async () => {
  const now = new Date("2026-10-10T08:00:00Z")
  const notice = "Current emergency notice"
  const sourceHash = getEmergencyOutagesNoticeHash(notice)
  const calls = []

  await run({
    checkIsOutageFn: () => true,
    checkIsScheduledFn: () => true,
    deleteLastNotificationFn: async (options) => {
      calls.push(["delete", options])
      return true
    },
    generateEmergencyOutagesMessageFn: () => "current notice",
    getInfoFn: async () => ({
      ...createInfo(),
      emergencyOutagesNotice: notice,
    }),
    loadEmergencyOutagesStateFn: () => true,
    loadLastMessageFn: (lastMessageFile) =>
      lastMessageFile === EMERGENCY_OUTAGES_MESSAGE_FILE
        ? {
            date: now.getTime() / 1000 - 47 * 60 * 60,
            edit_date: now.getTime() / 1000 - 60,
            message_id: 123,
            source_hash: sourceHash,
          }
        : null,
    now,
    sendNotificationFn: async (message, options) => {
      calls.push(["send", message, options])
      return true
    },
  })

  assert.deepEqual(calls, [
    ["delete", { lastMessageFile: EMERGENCY_OUTAGES_MESSAGE_FILE }],
    [
      "send",
      "current notice",
      {
        lastMessageFile: EMERGENCY_OUTAGES_MESSAGE_FILE,
        sourceHash,
      },
    ],
  ])
})

test("keeps a general notification younger than the rotation age", async () => {
  const now = new Date("2026-10-10T08:00:00Z")
  const notice = "Current emergency notice"
  const sourceHash = getEmergencyOutagesNoticeHash(notice)
  const calls = []

  await run({
    checkIsOutageFn: () => true,
    checkIsScheduledFn: () => true,
    deleteLastNotificationFn: async (options) => {
      calls.push(["delete", options])
      return true
    },
    generateEmergencyOutagesMessageFn: () => "current notice",
    getInfoFn: async () => ({
      ...createInfo("Планове"),
      emergencyOutagesNotice: notice,
    }),
    loadEmergencyOutagesStateFn: () => true,
    loadLastMessageFn: () => ({
      date: now.getTime() / 1000 - 47 * 60 * 60 + 1,
      message_id: 123,
      source_hash: sourceHash,
    }),
    now,
    sendNotificationFn: async (message, options) => {
      calls.push(["send", message, options])
      return true
    },
  })

  assert.deepEqual(calls, [
    [
      "send",
      "current notice",
      {
        lastMessageFile: EMERGENCY_OUTAGES_MESSAGE_FILE,
        sourceHash,
      },
    ],
  ])
})

test("replaces a general notification when visible text changes", async () => {
  const notice = {
    segments: [{ bold: false, text: "New emergency notice" }],
  }
  const calls = []

  await run({
    checkIsOutageFn: () => true,
    checkIsScheduledFn: () => true,
    deleteLastNotificationFn: async (options) => {
      calls.push(["delete", options])
      return true
    },
    generateEmergencyOutagesMessageFn: () => "new formatted notice",
    getInfoFn: async () => ({
      ...createInfo("Планове"),
      emergencyOutagesNotice: notice,
    }),
    loadEmergencyOutagesStateFn: () => true,
    loadLastMessageFn: (lastMessageFile) =>
      lastMessageFile === EMERGENCY_OUTAGES_MESSAGE_FILE
        ? {
            message_id: 123,
            source_hash: getEmergencyOutagesNoticeHash(
              "Old emergency notice",
            ),
          }
        : null,
    sendNotificationFn: async (message, options) => {
      calls.push(["send", message, options])
      return true
    },
  })

  assert.deepEqual(calls, [
    ["delete", { lastMessageFile: EMERGENCY_OUTAGES_MESSAGE_FILE }],
    [
      "send",
      "new formatted notice",
      {
        lastMessageFile: EMERGENCY_OUTAGES_MESSAGE_FILE,
        sourceHash: getEmergencyOutagesNoticeHash(notice),
      },
    ],
  ])
})

test("does not send a changed general notification when deletion fails", async () => {
  const messages = []

  await run({
    checkIsOutageFn: () => true,
    checkIsScheduledFn: () => false,
    deleteLastNotificationFn: async () => false,
    generateMessageFn: () => "address outage",
    getAddressOutageMessageHashFn: () => "address-hash",
    getInfoFn: async () => ({
      ...createInfo("Планове"),
      emergencyOutagesNotice: "New emergency notice",
    }),
    loadEmergencyOutagesStateFn: () => true,
    loadLastMessageFn: (lastMessageFile) =>
      lastMessageFile === EMERGENCY_OUTAGES_MESSAGE_FILE
        ? {
            message_id: 123,
            source_hash: getEmergencyOutagesNoticeHash(
              "Old emergency notice",
            ),
          }
        : null,
    sendNotificationFn: async (message) => messages.push(message),
  })

  assert.deepEqual(messages, ["address outage"])
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
    checkIsScheduledFn: () => false,
    deleteLastNotificationFn: async (options) => {
      calls.push(["delete", options])
      return true
    },
    generateMessageFn: () => "new address outage",
    getAddressOutageMessageHashFn: getSourceHash,
    getInfoFn: async () => ({
      ...currentOutage,
      emergencyOutagesNotice: null,
    }),
    loadEmergencyOutagesStateFn: () => false,
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

test("does not send a changed address notification when deletion fails", async () => {
  const currentOutage = createInfo("Аварійне", { end_date: "13:00" })
  const previousOutage = createInfo("Аварійне", { end_date: "12:00" })
  const getSourceHash = (info) =>
    getAddressOutageMessageHash(info, { street: "Street", house })
  let sent = false

  await run({
    checkIsOutageFn: () => true,
    checkIsScheduledFn: () => false,
    deleteLastNotificationFn: async () => false,
    getAddressOutageMessageHashFn: getSourceHash,
    getInfoFn: async () => ({
      ...currentOutage,
      emergencyOutagesNotice: null,
    }),
    loadEmergencyOutagesStateFn: () => false,
    loadLastMessageFn: () => ({
      message_id: 123,
      source_hash: getSourceHash(previousOutage),
    }),
    sendNotificationFn: async () => {
      sent = true
    },
  })

  assert.equal(sent, false)
})

test("sends only unscheduled address outage notifications", async () => {
  const messages = []
  const baseDependencies = {
    generateMessageFn: () => "outage",
    getAddressOutageMessageHashFn: () => "address-hash",
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
