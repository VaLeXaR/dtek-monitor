import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { afterEach, beforeEach, mock } from "node:test"

import {
  escapeHtml,
  getCurrentTime,
  getEmergencyOutagesAction,
  loadEmergencyOutagesState,
  loadLastMessage,
  saveEmergencyOutagesState,
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

test("chooses the correct general emergency outages action", () => {
  assert.equal(getEmergencyOutagesAction("Emergency outages", false), "send")
  assert.equal(getEmergencyOutagesAction("Emergency outages", true), "send")
  assert.equal(getEmergencyOutagesAction(null, true), "delete")
  assert.equal(getEmergencyOutagesAction(null, false), null)
})

test("escapes values used in Telegram HTML messages", () => {
  assert.equal(
    escapeHtml('<Street & "house" \'owner\'>'),
    "&lt;Street &amp; &quot;house&quot; &#39;owner&#39;&gt;",
  )
})

test("loads and saves state in isolated files", () => {
  const lastMessageFile = path.join(temporaryDirectory, "last-message.json")
  const emergencyStateFile = path.join(
    temporaryDirectory,
    "emergency-outages.json",
  )
  const messageDate = Date.parse("2026-10-08T09:00:00Z") / 1000

  assert.equal(loadLastMessage(lastMessageFile), null)
  assert.equal(loadEmergencyOutagesState(emergencyStateFile), false)

  saveLastMessage({ date: messageDate, message_id: 456 }, lastMessageFile)
  saveEmergencyOutagesState(true, emergencyStateFile)

  assert.deepEqual(
    loadLastMessage(lastMessageFile, new Date("2026-10-08T10:00:00Z")),
    {
      date: messageDate,
      message_id: 456,
    },
  )
  assert.equal(loadEmergencyOutagesState(emergencyStateFile), true)
})

test("falls back safely when state files are corrupted", () => {
  mock.method(console, "warn", () => {})
  const lastMessageFile = path.join(temporaryDirectory, "last-message.json")
  const emergencyStateFile = path.join(
    temporaryDirectory,
    "emergency-outages.json",
  )
  fs.writeFileSync(lastMessageFile, "not-json")
  fs.writeFileSync(emergencyStateFile, "")

  assert.equal(loadLastMessage(lastMessageFile), null)
  assert.equal(loadEmergencyOutagesState(emergencyStateFile), false)
})

test("clears previous-day message state using the Kyiv calendar date", () => {
  const lastMessageFile = path.join(temporaryDirectory, "last-message.json")
  const previousDay = Date.parse("2026-10-07T20:30:00Z") / 1000
  const nextDayInKyiv = new Date("2026-10-07T21:30:00Z")
  saveLastMessage(
    { date: previousDay, message_id: 456 },
    lastMessageFile,
  )

  assert.equal(loadLastMessage(lastMessageFile, nextDayInKyiv), null)
  assert.deepEqual(JSON.parse(fs.readFileSync(lastMessageFile, "utf8")), {})
})

test("formats the current time in the Kyiv time zone", () => {
  assert.equal(
    getCurrentTime(new Date("2026-10-08T09:05:00Z")),
    "12:05 08.10.2026",
  )
})
