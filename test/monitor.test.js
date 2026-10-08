import assert from "node:assert/strict"
import test, { afterEach, beforeEach, mock } from "node:test"

import {
  checkIsOutage,
  checkIsScheduled,
  deleteLastNotification,
  generateEmergencyOutagesMessage,
  generateMessage,
  getInfo,
  run,
  sendNotification,
} from "../src/monitor.js"

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

test("closes the browser and reports a failed DTEK response", async () => {
  let browserClosed = false
  mock.method(globalThis, "fetch", async () => ({
    ok: false,
    status: 503,
  }))
  const browserPage = {
    evaluate: async (callback, value) => callback(value),
    goto: async () => {},
    locator: () => ({ waitFor: async () => Promise.reject(Error("missing")) }),
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

test("handles Telegram send errors without persisting a message", async () => {
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
    loadLastMessageFn: () => ({}),
    saveLastMessageFn: () => {
      saved = true
    },
    telegramBotToken: "token",
    telegramChatId: "chat",
  })

  assert.equal(sent, false)
  assert.equal(deleted, true)
  assert.equal(saved, false)
})

test("gives a general emergency notice priority over address checks", async () => {
  const savedStates = []
  const messages = []
  await run({
    checkIsOutageFn: () => {
      throw Error("address check must not run")
    },
    generateEmergencyOutagesMessageFn: (notice) => `notice: ${notice}`,
    getInfoFn: async () => ({ emergencyOutagesNotice: "Emergency" }),
    loadEmergencyOutagesStateFn: () => false,
    saveEmergencyOutagesStateFn: (active) => savedStates.push(active),
    sendNotificationFn: async (message) => messages.push(message),
  })

  assert.deepEqual(savedStates, [true])
  assert.deepEqual(messages, ["notice: Emergency"])
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
  await run({
    deleteLastNotificationFn: async () => true,
    getInfoFn: async () => ({ emergencyOutagesNotice: null }),
    loadEmergencyOutagesStateFn: () => true,
    saveEmergencyOutagesStateFn: (active) => savedStates.push(active),
  })

  assert.deepEqual(savedStates, [false])
})

test("keeps emergency state when its notification cannot be deleted", async () => {
  const savedStates = []
  await run({
    deleteLastNotificationFn: async () => false,
    getInfoFn: async () => ({ emergencyOutagesNotice: null }),
    loadEmergencyOutagesStateFn: () => true,
    saveEmergencyOutagesStateFn: (active) => savedStates.push(active),
  })

  assert.deepEqual(savedStates, [])
})
