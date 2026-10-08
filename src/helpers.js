import fs from "node:fs"
import path from "node:path"

import {
  EMERGENCY_OUTAGES_STATE_FILE,
  LAST_MESSAGE_FILE,
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

export function loadLastMessage(
  file = LAST_MESSAGE_FILE,
  now = new Date(),
) {
  const lastMessage = readJsonFile(file, null)
  if (!lastMessage) return null

  if (lastMessage?.date) {
    const messageDay = new Date(lastMessage.date * 1000).toLocaleDateString(
      "en-CA",
      { timeZone: "Europe/Kyiv" },
    )
    const today = now.toLocaleDateString("en-CA", {
      timeZone: "Europe/Kyiv",
    })

    if (messageDay < today) {
      clearLastMessage(file)
      return null
    }
  }

  return lastMessage
}

export function saveLastMessage(
  { date, message_id } = {},
  file = LAST_MESSAGE_FILE,
) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify({
      message_id,
      date,
    }),
  )
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
