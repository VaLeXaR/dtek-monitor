import fs from "node:fs"
import path from "node:path"

import {
  EMERGENCY_OUTAGES_STATE_FILE,
  LAST_MESSAGE_FILE,
  QUIET_HOURS_END,
  QUIET_HOURS_START,
  RETRY_DELAY_MS,
  RETRY_MAX_ATTEMPTS,
} from "./constants.js"
import { warn } from "./logger.js"

function readJsonFile(file, fallback) {
  if (!fs.existsSync(file)) return fallback

  try {
    const contents = fs.readFileSync(file, "utf8").trim()
    return contents ? JSON.parse(contents) : fallback
  } catch (error) {
    warn(`⚠️ State file is invalid: ${error.message}`)
    return fallback
  }
}

export function capitalize(str) {
  if (typeof str !== "string") return ""
  return str[0].toUpperCase() + str.slice(1).toLowerCase()
}

export function loadLastMessage(file = LAST_MESSAGE_FILE) {
  const lastMessage = readJsonFile(file, null)
  if (!lastMessage) return null

  return lastMessage
}

export function saveLastMessage(
  { date, message_id, source_hash } = {},
  file = LAST_MESSAGE_FILE,
) {
  const state = {
    message_id,
    date,
  }
  if (typeof source_hash === "string") {
    state.source_hash = source_hash
  }

  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(state))
}

export function clearLastMessage(file = LAST_MESSAGE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({}))
}

export function loadEmergencyOutagesState(
  file = EMERGENCY_OUTAGES_STATE_FILE,
) {
  const state = readJsonFile(file, null)

  return state?.active === true
}

export function saveEmergencyOutagesState(
  active,
  file = EMERGENCY_OUTAGES_STATE_FILE,
) {
  fs.mkdirSync(path.dirname(file), {
    recursive: true,
  })
  fs.writeFileSync(file, JSON.stringify({ active }))
}

export function getEmergencyOutagesAction(notice, wereActive) {
  if (notice) return "send"
  if (wereActive) return "delete"
  return null
}

export function migrateEmergencyOutagesMessageState({
  emergencyMessageFile,
  emergencyStateFile = EMERGENCY_OUTAGES_STATE_FILE,
  lastMessageFile = LAST_MESSAGE_FILE,
} = {}) {
  if (!emergencyMessageFile || fs.existsSync(emergencyMessageFile)) {
    return false
  }

  if (!loadEmergencyOutagesState(emergencyStateFile)) return false

  const lastMessage = loadLastMessage(lastMessageFile)
  if (lastMessage) {
    saveLastMessage(lastMessage, emergencyMessageFile)
    clearLastMessage(lastMessageFile)
  } else {
    clearLastMessage(emergencyMessageFile)
  }

  return true
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

export function isQuietHours(
  now = new Date(),
  { end = QUIET_HOURS_END, start = QUIET_HOURS_START } = {},
) {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      hourCycle: "h23",
      timeZone: "Europe/Kyiv",
    })
      .formatToParts(now)
      .find((part) => part.type === "hour")?.value,
  )

  if (start === end) return false
  if (start < end) return hour >= start && hour < end
  return hour >= start || hour < end
}

export async function retry(
  operation,
  {
    delayMs = RETRY_DELAY_MS,
    maxAttempts = RETRY_MAX_ATTEMPTS,
    onRetry = () => {},
    shouldRetry = () => true,
    sleepFn = (timeout) =>
      new Promise((resolve) => setTimeout(resolve, timeout)),
  } = {},
) {
  let attempt = 1

  while (true) {
    try {
      return await operation(attempt)
    } catch (error) {
      if (attempt >= maxAttempts || !shouldRetry(error)) throw error

      const nextDelay = delayMs * 2 ** (attempt - 1)
      await onRetry(error, { attempt, nextDelay })
      await sleepFn(nextDelay)
      attempt += 1
    }
  }
}

export function getCurrentTime(now = new Date()) {
  const date = now.toLocaleDateString("uk-UA", {
    timeZone: "Europe/Kyiv",
  })

  const time = now.toLocaleTimeString("uk-UA", {
    timeZone: "Europe/Kyiv",
    hour: "2-digit",
    minute: "2-digit",
  })

  return `${time} ${date}`
}
