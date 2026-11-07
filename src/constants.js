import path from "node:path"

export const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, STREET, HOUSE } =
  process.env

export const KYIV_BANK = process.env.KYIV_BANK?.trim() || ""
export const KYIV_DISTRICT = process.env.KYIV_DISTRICT?.trim() || ""
export const LLM_API_KEY = process.env.LLM_API_KEY || ""
export const LLM_BASE_URL =
  process.env.LLM_BASE_URL?.trim() ||
  "https://generativelanguage.googleapis.com/v1beta/openai"
export const LLM_MODEL = process.env.LLM_MODEL?.trim() || "gemini-3.1-flash-lite"
export const LLM_TIMEOUT_MS = readInteger("LLM_TIMEOUT_MS", 30000, {
  min: 1,
  max: 120000,
})
export const LLM_CACHE_FILE = path.resolve("artifacts", "llm-notice-cache.json")

function readInteger(name, fallback, { min, max }) {
  const value = process.env[name]
  if (value === undefined || value === "") return fallback

  if (!/^\d+$/.test(value)) {
    throw Error(`${name} must be an integer between ${min} and ${max}.`)
  }

  const number = Number(value)
  if (number < min || number > max) {
    throw Error(`${name} must be an integer between ${min} and ${max}.`)
  }

  return number
}

export const SHUTDOWNS_PAGE = "https://www.dtek-kem.com.ua/ua"
export const TELEGRAM_MESSAGE_TITLE =
  "<b>Повідомлення з сайту ДТЕК Київські Електромережі</b>"

export const RETRY_MAX_ATTEMPTS = readInteger("RETRY_MAX_ATTEMPTS", 3, {
  min: 1,
  max: 10,
})
export const RETRY_DELAY_MS = readInteger("RETRY_DELAY_MS", 5000, {
  min: 0,
  max: 60000,
})
export const QUIET_HOURS_START = readInteger("QUIET_HOURS_START", 22, {
  min: 0,
  max: 23,
})
export const QUIET_HOURS_END = readInteger("QUIET_HOURS_END", 8, {
  min: 0,
  max: 23,
})

export const LAST_MESSAGE_FILE = path.resolve("artifacts", `last-message.json`)
export const EMERGENCY_OUTAGES_MESSAGE_FILE = path.resolve(
  "artifacts",
  "emergency-outages-message.json",
)
export const EMERGENCY_OUTAGES_STATE_FILE = path.resolve(
  "artifacts",
  "emergency-outages.json",
)
export const ADDRESS_REMOVAL_MESSAGE_FILE = path.resolve(
  "artifacts",
  "address-removal-message.json",
)
export const EMERGENCY_REMOVAL_MESSAGE_FILE = path.resolve(
  "artifacts",
  "emergency-removal-message.json",
)
