import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { afterEach, beforeEach, mock } from "node:test"

import {
  escapeHtml,
  isQuietHours,
  loadLastMessage,
  retry,
  saveLastMessage,
} from "../src/helpers.js"

let temporaryDirectory

beforeEach(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "dtek-monitor-"))
})

afterEach(() => {
  mock.restoreAll()
  fs.rmSync(temporaryDirectory, { recursive: true, force: true })
})

test("escapes values used in Telegram HTML messages", () => {
  assert.equal(
    escapeHtml('<Street & "house" \'owner\'>'),
    "&lt;Street &amp; &quot;house&quot; &#39;owner&#39;&gt;",
  )
})

test("loads and saves state in isolated files", () => {
  const lastMessageFile = path.join(temporaryDirectory, "last-message.json")
  const messageDate = Date.parse("2026-10-08T09:00:00Z") / 1000

  assert.equal(loadLastMessage(lastMessageFile), null)

  saveLastMessage({ date: messageDate, message_id: 456 }, lastMessageFile)

  assert.deepEqual(
    loadLastMessage(lastMessageFile, new Date("2026-10-08T10:00:00Z")),
    {
      date: messageDate,
      message_id: 456,
    },
  )
})

test("persists an optional source hash with Telegram message state", () => {
  const lastMessageFile = path.join(temporaryDirectory, "last-message.json")
  const lastMessage = {
    date: Date.parse("2026-10-08T09:00:00Z") / 1000,
    message_id: 456,
    source_hash: "abc123",
  }

  saveLastMessage(lastMessage, lastMessageFile)

  assert.deepEqual(loadLastMessage(lastMessageFile), lastMessage)
})

test("falls back safely when state files are corrupted", () => {
  mock.method(console, "warn", () => {})
  const lastMessageFile = path.join(temporaryDirectory, "last-message.json")
  fs.writeFileSync(lastMessageFile, "not-json")

  assert.equal(loadLastMessage(lastMessageFile), null)
})

test("preserves message state across Kyiv calendar dates", () => {
  const lastMessageFile = path.join(temporaryDirectory, "last-message.json")
  const previousDay = Date.parse("2026-10-07T20:30:00Z") / 1000
  const lastMessage = { date: previousDay, message_id: 456 }
  saveLastMessage(lastMessage, lastMessageFile)

  assert.deepEqual(loadLastMessage(lastMessageFile), lastMessage)
  assert.deepEqual(
    JSON.parse(fs.readFileSync(lastMessageFile, "utf8")),
    lastMessage,
  )
})

test("detects quiet hours across midnight in the Kyiv time zone", () => {
  assert.equal(isQuietHours(new Date("2026-10-08T18:59:00Z")), false)
  assert.equal(isQuietHours(new Date("2026-10-08T19:00:00Z")), true)
  assert.equal(isQuietHours(new Date("2026-10-09T04:59:00Z")), true)
  assert.equal(isQuietHours(new Date("2026-10-09T05:00:00Z")), false)
  assert.equal(
    isQuietHours(new Date("2026-10-08T20:00:00Z"), { start: 8, end: 8 }),
    false,
  )
})

test("retries failed operations with exponential delays", async () => {
  const delays = []
  let attempts = 0

  const result = await retry(
    async () => {
      attempts += 1
      if (attempts < 3) throw Error("temporary failure")
      return "done"
    },
    {
      delayMs: 10,
      maxAttempts: 3,
      sleepFn: async (delay) => delays.push(delay),
    },
  )

  assert.equal(result, "done")
  assert.equal(attempts, 3)
  assert.deepEqual(delays, [10, 20])
})
