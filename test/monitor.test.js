import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { afterEach, beforeEach, mock } from "node:test"

import {
  loadLastMessage,
  saveLastMessage,
} from "../src/helpers.js"

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
  ADDRESS_REMOVAL_MESSAGE_FILE,
  EMERGENCY_REMOVAL_MESSAGE_FILE,
  EMERGENCY_OUTAGES_MESSAGE_FILE,
  LAST_MESSAGE_FILE,
} from "../src/constants.js"

import { readAddressResponse } from "../src/dtek.js"

const house = "1"

function createDtekBrowser(notice = null, goto = async () => {}) {
  const stats = { launches: 0, contexts: 0, visits: 0, closed: 0 }
  const notices = {
    waitFor: async () => {},
    evaluateAll: async () => notice || { segments: [] },
  }
  const page = {
    setDefaultTimeout: () => {},
    goto: async (...args) => {
      stats.visits += 1
      await goto(...args)
    },
    locator: (selector) => {
      if (selector === 'meta[name="csrf-token"]') {
        return { waitFor: async () => {} }
      }
      return { filter: () => ({ ...notices, first: () => notices }) }
    },
  }
  const browserType = {
    launch: async () => {
      stats.launches += 1
      return {
        close: async () => {
          stats.closed += 1
        },
        newContext: async () => {
          stats.contexts += 1
          return { newPage: async () => page }
        },
      }
    },
  }
  return { browserType, stats }
}

function getTestInfo(options) {
  return getInfo({ browserStateFile: null, ...options })
}

for (const [kind, messageFile, prefix] of [
  [
    "general",
    EMERGENCY_OUTAGES_MESSAGE_FILE,
    "Повідомлення про загальні екстрені/аварійні відключення прибране з сайту ДТЕК.",
  ],
  [
    "address",
    LAST_MESSAGE_FILE,
    "Повідомлення про адресне відключення прибране з сайту ДТЕК.",
  ],
]) {
  test(`sends a ${kind} removal explanation once and retries Telegram failures`, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dtek-removal-"))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const stateFile = path.join(directory, "message.json")
    const removalStateFile = path.join(directory, "removal.json")
    saveLastMessage({ message_id: 123, date: 123 }, stateFile)
    const requests = []
    let phase = "delete failure"
    let active = kind === "general"
    const dependencies = {
      now: new Date("2026-10-08T20:00:00Z"),
      getInfoFn: async () => ({ emergencyOutagesNotice: null }),
      checkIsOutageFn: () => kind === "general",
      checkIsScheduledFn: () => true,
      loadEmergencyOutagesStateFn: () => active,
      loadRemovalMessageFn: () => null,
      saveEmergencyOutagesStateFn: (value) => {
        active = value
      },
      deleteLastNotificationFn: async (options) => {
        assert.equal(options.lastMessageFile, messageFile)
        return deleteLastNotification({
          ...options,
          lastMessageFile: stateFile,
          removalMessageFile: removalStateFile,
          telegramBotToken: "token",
          telegramChatId: "chat",
          retryMaxAttempts: 1,
          fetchFn: async (url, request) => {
            const method = url.split("/").at(-1)
            requests.push([method, JSON.parse(request.body)])
            const ok =
              (phase === "success" && method === "sendMessage") ||
              (phase === "send failure" && method === "deleteMessage")
            return {
              ok,
              json: async () => ({
                ok,
                description:
                  phase === "success" && method === "deleteMessage"
                    ? "Bad Request: message to delete not found"
                    : "failed",
                result: { message_id: 456, date: 456 },
              }),
            }
          },
        })
      },
    }

    await run(dependencies)
    assert.deepEqual(requests.map(([method]) => method), [
      "deleteMessage",
    ])
    assert.equal(loadLastMessage(stateFile).message_id, 123)
    assert.equal(active, kind === "general")

    phase = "send failure"
    await run(dependencies)
    assert.equal(loadLastMessage(stateFile).message_id, 123)
    assert.equal(active, kind === "general")

    phase = "success"
    await run(dependencies)
    assert.deepEqual(loadLastMessage(stateFile), {})
    assert.deepEqual(loadLastMessage(removalStateFile), {
      message_id: 456,
      date: 456,
    })
    assert.equal(active, false)
    const [, body] = requests.at(-1)
    assert.equal(
      body.text,
      `${prefix} Це не означає, що світло повернулося. Будь ласка, розумно споживайте електроенергію — це допоможе зменшити навантаження на мережу та уникнути екстрених відключень.`,
    )
    assert.equal(body.parse_mode, "HTML")
    assert.equal(body.disable_notification, true)
    assert.equal(body.message_id, undefined)

    const requestCount = requests.length
    await run(dependencies)
    assert.equal(requests.length, requestCount)
  })
}

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

for (const [kind, outageFile, removalFile] of [
  ["general", EMERGENCY_OUTAGES_MESSAGE_FILE, EMERGENCY_REMOVAL_MESSAGE_FILE],
  ["address", LAST_MESSAGE_FILE, ADDRESS_REMOVAL_MESSAGE_FILE],
]) {
  for (const trigger of ["return", "expiry"]) {
    test(`cleans up ${kind} cancellation on ${trigger}, preserving state on failure`, async (t) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dtek-lifecycle-"))
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
      const localFile = (file) => path.join(directory, path.basename(file))
      let now = new Date("2026-10-24T20:00:00Z")
      const sentAt = now.getTime()
      let outage = false
      let emergencyActive = kind === "general"
      let deletionFails = false
      let messageId = 200
      const requests = []
      const fetchFn = async (url, options) => {
        const method = url.split("/").at(-1)
        const body = JSON.parse(options.body)
        requests.push({ method, body })
        const ok = method !== "deleteMessage" || !deletionFails
        return {
          ok,
          json: async () => ({
            ok,
            description: ok ? undefined : "Deletion failed",
            result: {
              message_id: ++messageId,
              date: now.getTime() / 1000,
            },
          }),
        }
      }
      saveLastMessage({ message_id: 100, date: sentAt / 1000 }, localFile(outageFile))
      const check = () => run({
        now,
        getInfoFn: async () => ({
          emergencyOutagesNotice: kind === "general" && outage ? "Notice" : null,
        }),
        analyzeEmergencyNoticeFn: async () => ({ status: "affected" }),
        checkIsOutageFn: () => kind === "address" && outage,
        checkIsScheduledFn: () => false,
        generateMessageFn: () => "Address outage",
        generateEmergencyOutagesMessageFn: () => "General outage",
        getAddressOutageMessageHashFn: () => "address-hash",
        loadLastMessageFn: (file) => loadLastMessage(localFile(file)),
        loadRemovalMessageFn: (file) => loadLastMessage(localFile(file)),
        loadEmergencyOutagesStateFn: () => emergencyActive,
        saveEmergencyOutagesStateFn: (active) => { emergencyActive = active },
        deleteLastNotificationFn: (options) => deleteLastNotification({
          ...options,
          lastMessageFile: localFile(options.lastMessageFile),
          removalMessageFile: options.removalMessageFile
            ? localFile(options.removalMessageFile)
            : undefined,
          fetchFn,
          telegramBotToken: "token",
          telegramChatId: "chat",
          retryMaxAttempts: 1,
        }),
        sendNotificationFn: (message, options) => sendNotification(message, {
          ...options,
          lastMessageFile: localFile(options.lastMessageFile),
          now,
          fetchFn,
          telegramBotToken: "token",
          telegramChatId: "chat",
          retryMaxAttempts: 1,
        }),
      })

      await check()
      const cancellation = loadLastMessage(localFile(removalFile))
      assert.ok(cancellation.message_id)
      assert.equal(cancellation.date, sentAt / 1000)
      assert.deepEqual(loadLastMessage(localFile(outageFile)), {})
      const otherRemovalFile = kind === "general"
        ? ADDRESS_REMOVAL_MESSAGE_FILE
        : EMERGENCY_REMOVAL_MESSAGE_FILE
      if (trigger === "return") {
        saveLastMessage(
          { message_id: 999, date: sentAt / 1000 },
          localFile(otherRemovalFile),
        )
      }
      const count = requests.length
      now = new Date(sentAt + 36 * 60 * 60 * 1000 - 1)
      await check()
      assert.equal(requests.length, count)

      if (trigger === "return") {
        outage = true
      } else {
        now = new Date(sentAt + 36 * 60 * 60 * 1000)
      }
      deletionFails = true
      await check()
      assert.deepEqual(loadLastMessage(localFile(removalFile)), cancellation)
      assert.equal(requests.length, count + 1)
      assert.equal(requests.at(-1).body.message_id, cancellation.message_id)

      deletionFails = false
      await check()
      assert.deepEqual(loadLastMessage(localFile(removalFile)), {})
      assert.equal(requests[count + 1].method, "deleteMessage")
      assert.equal(requests[count + 1].body.message_id, cancellation.message_id)
      if (trigger === "return") {
        assert.equal(requests[count + 2].method, "sendMessage")
        assert.ok(loadLastMessage(localFile(outageFile)).message_id)
        assert.equal(loadLastMessage(localFile(otherRemovalFile)).message_id, 999)
      } else {
        assert.equal(requests.length, count + 2)
        await check()
        assert.equal(requests.length, count + 2)
      }
    })
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
    /^<b>🚨 Повідомлення з сайту ДТЕК Київські Електромережі<\/b>\n\n/,
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
    /^<b>🚨 Повідомлення з сайту ДТЕК Київські Електромережі<\/b>\n\nWarning &lt;all&gt; &amp; everyone/,
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
      assert.equal(options, undefined)
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

test("closes the browser and preserves the notice result after a failed address response", async () => {
  const { browserType, stats } = createDtekBrowser()
  const info = await getTestInfo({
    browserType,
    retryMaxAttempts: 1,
    getAddressInfoFn: async () => {
      throw Error("DTEK request failed with status 503.")
    },
  })
  assert.equal(info.emergencyOutagesNotice, null)
  assert.match(info.addressError.message, /DTEK request failed with status 503/)
  assert.equal(stats.closed, 1)
})

test("retries a transient browser launch failure", async () => {
  const { browserType, stats } = createDtekBrowser()
  const launch = browserType.launch
  let launches = 0
  const delays = []
  browserType.launch = async () => {
    launches += 1
    if (launches === 1) throw Error("browser unavailable")
    return launch()
  }
  const expectedInfo = createInfo("Аварійне")
  assert.deepEqual(
    await getTestInfo({
      browserType,
      getAddressInfoFn: async () => expectedInfo,
      retryDelayMs: 10,
      retryMaxAttempts: 2,
      sleepFn: async (delay) => delays.push(delay),
    }),
    { ...expectedInfo, emergencyOutagesNotice: null }
  )
  assert.equal(launches, 2)
  assert.equal(stats.closed, 1)
  assert.deepEqual(delays, [10])
})

test("reports an uncertain emergency notice check instead of treating it as absent", async () => {
  const browserPage = {
    locator: () => ({
      filter: () => ({
        count: async () => 1,
        first: () => ({
          waitFor: async () => Promise.reject(Error("page became unavailable")),
        }),
      }),
    }),
  }

  await assert.rejects(
    getEmergencyOutagesNotice(browserPage),
    /Emergency outages notice check failed: page became unavailable/
  )
})

test("collects a matching general DTEK notice", async () => {
  const expectedInfo = createInfo("Аварійне")
  const expectedNotice = {
    segments: [{ bold: false, text: "Застосовано аварійні графіки" }],
  }
  const { browserType } = createDtekBrowser(expectedNotice)
  assert.deepEqual(
    await getTestInfo({
      browserType,
      getAddressInfoFn: async () => expectedInfo,
    }),
    {
      ...expectedInfo,
      emergencyOutagesNotice: expectedNotice,
    }
  )
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
    analyzeEmergencyNoticeFn: async () => ({ status: "affected" }),
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
    analyzeEmergencyNoticeFn: async () => ({ status: "affected" }),
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
    analyzeEmergencyNoticeFn: async () => ({ status: "affected" }),
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
    analyzeEmergencyNoticeFn: async () => ({ status: "affected" }),
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
    analyzeEmergencyNoticeFn: async () => ({ status: "affected" }),
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
    analyzeEmergencyNoticeFn: async () => ({ status: "affected" }),
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
    analyzeEmergencyNoticeFn: async () => ({ status: "affected" }),
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
    analyzeEmergencyNoticeFn: async () => ({ status: "affected" }),
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
    analyzeEmergencyNoticeFn: async () => ({ status: "affected" }),
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
    analyzeEmergencyNoticeFn: async () => ({ status: "affected" }),
    ...baseDependencies,
    checkIsOutageFn: () => true,
    checkIsScheduledFn: () => true,
  })
  await run({
    analyzeEmergencyNoticeFn: async () => ({ status: "affected" }),
    ...baseDependencies,
    checkIsOutageFn: () => true,
    checkIsScheduledFn: () => false,
  })

  assert.deepEqual(messages, ["outage"])
})

test("deletes the previous address notification when no outage remains", async () => {
  let deleted = false
  await run({
    analyzeEmergencyNoticeFn: async () => ({ status: "affected" }),
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
    analyzeEmergencyNoticeFn: async () => ({ status: "affected" }),
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
    analyzeEmergencyNoticeFn: async () => ({ status: "affected" }),
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

for (const outcome of ["unknown", "error", "not_affected"]) {
  for (const deletionSucceeds of [true, false]) {
    test(`handles LLM ${outcome} with deletion=${deletionSucceeds} independently of address outage`, async () => {
      const deleted = []
      const states = []
      const sent = []
      await run({
        analyzeEmergencyNoticeFn: async () => {
          if (outcome === "error") throw Error("LLM failure")
          return { status: outcome }
        },
        getInfoFn: async () => ({ emergencyOutagesNotice: "DTEK notice" }),
        loadEmergencyOutagesStateFn: () => true,
        loadLastMessageFn: () => ({}),
        saveEmergencyOutagesStateFn: (state) => states.push(state),
        checkIsOutageFn: () => true,
        checkIsScheduledFn: () => false,
        getAddressOutageMessageHashFn: () => "address-hash",
        generateMessageFn: () => "Address outage",
        sendNotificationFn: async (message) => sent.push(message),
        deleteLastNotificationFn: async ({ lastMessageFile }) => {
          deleted.push(lastMessageFile)
          return deletionSucceeds
        },
      })
      assert.deepEqual(sent, ["Address outage"])
      assert.deepEqual(
        deleted,
        outcome === "not_affected" ? [EMERGENCY_OUTAGES_MESSAGE_FILE] : [],
      )
      assert.deepEqual(
        states,
        outcome === "not_affected" && deletionSucceeds ? [false] : [],
      )
    })
  }
}

test("does not call LLM when the modal is absent", async () => {
  let called = false
  await run({
    analyzeEmergencyNoticeFn: async () => {
      called = true
    },
    getInfoFn: async () => ({ emergencyOutagesNotice: null }),
    loadEmergencyOutagesStateFn: () => false,
    checkIsOutageFn: () => true,
    checkIsScheduledFn: () => true,
  })
  assert.equal(called, false)
})

for (const failure of ["Incapsula", "HTTP", "JSON", "missing house"]) {
  for (const noticePresent of [true, false]) {
    test(`processes general notice=${noticePresent} despite ${failure}, preserving address state`, async (t) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dtek-partial-"))
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
      const localFile = (file) => path.join(directory, path.basename(file))
      const addressState = { message_id: 123, date: 1 }
      const removalState = { message_id: 456, date: 1 }
      saveLastMessage(addressState, localFile(LAST_MESSAGE_FILE))
      saveLastMessage(removalState, localFile(ADDRESS_REMOVAL_MESSAGE_FILE))
      const notice = {
        segments: [{ text: "Екстрені відключення у Києві", bold: false }],
      }
      const sent = []
      const deleted = []
      const saved = []
      const { browserType, stats } = createDtekBrowser(
        noticePresent ? notice : null
      )
      const info = await getTestInfo({
        browserType,
        getAddressInfoFn: async () =>
          readAddressResponse({
            ok: () => failure !== "HTTP",
            status: () => (failure === "HTTP" ? 503 : 200),
            text: async () => {
              if (failure === "Incapsula") {
                return '<html><script src="/_Incapsula_Resource?secret"></script></html>'
              }
              if (failure === "JSON") return "invalid JSON with private data"
              return JSON.stringify({ result: true, data: {} })
            },
          }),
        retryMaxAttempts: 2,
        sleepFn: async () => {},
      })
      assert.equal(stats.visits, failure === "missing house" ? 1 : 2)
      assert.equal(stats.launches, 1)
      assert.equal(stats.contexts, 1)
      assert.equal(stats.closed, 1)
      if (failure === "Incapsula") {
        assert.match(info.addressError.message, /Incapsula blocked/)
        assert.doesNotMatch(info.addressError.message, /secret/)
      }
      if (failure === "JSON") {
        assert.match(info.addressError.message, /invalid JSON/)
        assert.doesNotMatch(info.addressError.message, /private data/)
      }
      await assert.rejects(
        run({
          now: new Date("2026-11-08T14:00:00Z"),
          getInfoFn: async () => info,
          analyzeEmergencyNoticeFn: async () => ({ status: "affected" }),
          checkIsOutageFn: (value) => checkIsOutage(value, house),
          loadEmergencyOutagesStateFn: () => true,
          saveEmergencyOutagesStateFn: (value) => saved.push(value),
          loadLastMessageFn: (file) => loadLastMessage(localFile(file)),
          loadRemovalMessageFn: (file) => loadLastMessage(localFile(file)),
          generateEmergencyOutagesMessageFn: () => "General notice",
          sendNotificationFn: async (message, { lastMessageFile }) => {
            sent.push(lastMessageFile)
            saveLastMessage(
              { message_id: 789, date: 1 },
              localFile(lastMessageFile)
            )
          },
          deleteLastNotificationFn: async ({ lastMessageFile }) => {
            deleted.push(lastMessageFile)
            fs.rmSync(localFile(lastMessageFile), { force: true })
            return true
          },
        }),
        failure === "missing house"
          ? /configured house is missing/
          : /Getting info failed/
      )
      assert.deepEqual(
        sent,
        noticePresent ? [EMERGENCY_OUTAGES_MESSAGE_FILE] : []
      )
      assert.deepEqual(
        deleted,
        noticePresent ? [] : [EMERGENCY_OUTAGES_MESSAGE_FILE]
      )
      assert.deepEqual(saved, [noticePresent])
      assert.deepEqual(
        loadLastMessage(localFile(LAST_MESSAGE_FILE)),
        addressState
      )
      assert.deepEqual(
        loadLastMessage(localFile(ADDRESS_REMOVAL_MESSAGE_FILE)),
        removalState
      )
    })
  }
}

test("does not use an earlier notice if the final page check fails", async () => {
  let visits = 0
  const { browserType, stats } = createDtekBrowser(
    { segments: [{ text: "Earlier notice" }] },
    async () => {
      visits += 1
      if (visits === 2) throw Error("page unavailable")
    }
  )
  await assert.rejects(
    getTestInfo({
      browserType,
      getAddressInfoFn: async () => {
        throw Error("form unavailable")
      },
      retryMaxAttempts: 2,
      sleepFn: async () => {},
    }),
    /page unavailable/
  )
  assert.equal(stats.closed, 1)
})

test("reuses the browser session when an address retry succeeds", async () => {
  const { browserType, stats } = createDtekBrowser()
  const expectedInfo = createInfo("Аварійне")
  let attempts = 0
  const info = await getTestInfo({
    browserType,
    getAddressInfoFn: async () => {
      attempts += 1
      if (attempts === 1) throw Error("Incapsula blocked the address request")
      return expectedInfo
    },
    retryMaxAttempts: 2,
    sleepFn: async () => {},
  })
  assert.deepEqual(info, { ...expectedInfo, emergencyOutagesNotice: null })
  assert.deepEqual(stats, { launches: 1, contexts: 1, visits: 2, closed: 1 })
})

test("loads and saves the browser session across separate checks", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "dtek-check-session-")
  )
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, "state.json")
  const session = {
    cookies: [
      { name: "session", value: "private", domain: ".dtek-kem.com.ua" },
    ],
    origins: [],
  }
  const options = []
  for (let check = 0; check < 2; check += 1) {
    const { browserType, stats } = createDtekBrowser()
    const launch = browserType.launch
    browserType.launch = async () => {
      const browser = await launch()
      const newContext = browser.newContext
      browser.newContext = async (value) => {
        options.push(value)
        const context = await newContext()
        context.storageState = async () => structuredClone(session)
        return context
      }
      return browser
    }
    await getTestInfo({
      browserType,
      browserStateFile: file,
      getAddressInfoFn: async () => createInfo(),
    })
    assert.equal(stats.closed, 1)
  }
  assert.deepEqual(options[0], {
    locale: "uk-UA",
    timezoneId: "Europe/Kyiv",
    storageState: undefined,
  })
  assert.deepEqual(options[1].storageState, session)
})

test("discards a session rejected by Chromium without losing the check", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "dtek-invalid-session-")
  )
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, "state.json")
  fs.writeFileSync(file, JSON.stringify({ cookies: [{}], origins: [] }))
  const { browserType, stats } = createDtekBrowser()
  const launch = browserType.launch
  let attempts = 0
  browserType.launch = async () => {
    const browser = await launch()
    const newContext = browser.newContext
    browser.newContext = async (options) => {
      attempts += 1
      if (options.storageState) throw Error("invalid cookie")
      const context = await newContext()
      context.storageState = async () => ({ cookies: [], origins: [] })
      return context
    }
    return browser
  }
  const info = await getTestInfo({
    browserType,
    browserStateFile: file,
    getAddressInfoFn: async () => createInfo(),
  })
  assert.equal(info.addressError, undefined)
  assert.equal(attempts, 2)
  assert.equal(stats.closed, 1)
})
