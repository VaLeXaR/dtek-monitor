import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"

import { chromium } from "playwright"

import {
  HOUSE,
  LAST_MESSAGE_FILE,
  RETRY_DELAY_MS,
  RETRY_MAX_ATTEMPTS,
  SHUTDOWNS_PAGE,
  STREET,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  TELEGRAM_MESSAGE_TITLE,
} from "./constants.js"

import {
  capitalize,
  clearLastMessage,
  escapeHtml,
  isQuietHours,
  loadLastMessage,
  retry,
  saveLastMessage,
} from "./helpers.js"
import { log, logError } from "./logger.js"

export async function getInfo({
  browserType = chromium,
  retryDelayMs = RETRY_DELAY_MS,
  retryFn = retry,
  retryMaxAttempts = RETRY_MAX_ATTEMPTS,
  sleepFn,
} = {}) {
  return retryFn(
    async () => {
      log("🌀 Getting info...")

      let browser
      try {
        browser = await browserType.launch({ headless: true })
        const browserPage = await browser.newPage()

        await browserPage.goto(SHUTDOWNS_PAGE, {
          waitUntil: "load",
        })

        const csrfTokenTag = await browserPage.waitForSelector(
          'meta[name="csrf-token"]',
          { state: "attached" },
        )
        const csrfToken = await csrfTokenTag.getAttribute("content")

        const info = await browserPage.evaluate(
          async ({ STREET, csrfToken }) => {
            const formData = new URLSearchParams()
            formData.append("method", "getHomeNum")
            formData.append("data[0][name]", "street")
            formData.append("data[0][value]", STREET)
            formData.append("data[1][name]", "updateFact")
            formData.append(
              "data[1][value]",
              new Date().toLocaleString("uk-UA"),
            )

            const response = await fetch("/ua/ajax", {
              method: "POST",
              headers: {
                "x-requested-with": "XMLHttpRequest",
                "x-csrf-token": csrfToken,
              },
              body: formData,
            })

            if (!response.ok) {
              throw Error(`DTEK request failed with status ${response.status}.`)
            }

            return await response.json()
          },
          { STREET, csrfToken },
        )

        log("✅ Getting info finished.")
        return info
      } catch (error) {
        throw Error(`❌ Getting info failed: ${error.message}`)
      } finally {
        await browser?.close()
      }
    },
    {
      delayMs: retryDelayMs,
      maxAttempts: retryMaxAttempts,
      onRetry: (error, { attempt, nextDelay }) => {
        log(
          `⚠️ DTEK attempt ${attempt} failed; retrying in ${nextDelay} ms.`,
          error.message,
        )
      },
      sleepFn,
    },
  )
}

function getAddressInfo(info, house) {
  if (!info?.data) {
    throw Error("❌ Power outage info missed.")
  }

  const addressInfo = info.data[house]
  if (
    !Object.hasOwn(info.data, house) ||
    !addressInfo ||
    typeof addressInfo !== "object"
  ) {
    throw Error("❌ Power outage info for the configured house is missing.")
  }

  return addressInfo
}

export function checkIsOutage(info, house = HOUSE) {
  log("🌀 Checking power outage...")

  const {
    sub_type = "",
    start_date = "",
    end_date = "",
    type = "",
  } = getAddressInfo(info, house)
  const isOutageDetected = [sub_type, start_date, end_date, type].some(
    (value) => String(value ?? "").trim() !== "",
  )

  isOutageDetected
    ? log("🚨 Power outage detected!")
    : log("⚡️ No power outage!")

  return isOutageDetected
}

export function checkIsAccident(info, house = HOUSE) {
  log("🌀 Checking whether power outage is accidental...")

  const { sub_type = "" } = getAddressInfo(info, house)
  const isAccident = String(sub_type).toLowerCase().includes("аварій")

  isAccident
    ? log("🚨 Accidental power outage detected!")
    : log("⚡️ No accidental power outage!")

  return isAccident
}

export function generateMessage(
  info,
  { street = STREET, house = HOUSE } = {},
) {
  log("🌀 Generating message...")

  const { sub_type = "", start_date = "", end_date = "" } = getAddressInfo(
    info,
    house,
  )
  const { updateTimestamp } = info || {}

  const address = `${escapeHtml(street)}, ${escapeHtml(house)}`
  const reason = escapeHtml(capitalize(sub_type))

  return [
    TELEGRAM_MESSAGE_TITLE,
    "",
    `⚡️ <b>За адресою ${address} зафіксовано відключення</b>`,
    "",
    `🪫 Час початку - ${escapeHtml(start_date)}`,
    `🔌 Орієнтовний час відновлення - <b>${escapeHtml(end_date)}</b>`,
    "",
    `⚠️ <i>${reason}.</i>`,
    "\n",
    `🔄 <i>Дата оновлення інформації – ${escapeHtml(updateTimestamp)}</i>`,
  ].join("\n")
}

function normalizeSourceValue(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim()
}

function createSourceHash(value) {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

export function getAddressOutageMessageHash(
  info,
  { street = STREET, house = HOUSE } = {},
) {
  const { sub_type = "", start_date = "", end_date = "" } = getAddressInfo(
    info,
    house,
  )
  const visibleValues = [
    street,
    house,
    start_date,
    end_date,
    capitalize(sub_type),
  ].map(normalizeSourceValue)

  return createSourceHash(JSON.stringify(visibleValues))
}

function hasNotificationSourceChanged(lastMessage, sourceHash) {
  return (
    Boolean(lastMessage.message_id) &&
    typeof lastMessage.source_hash === "string" &&
    lastMessage.source_hash !== sourceHash
  )
}

async function requestTelegram(
  method,
  body,
  {
    fetchFn,
    retryDelayMs,
    retryFn,
    retryMaxAttempts,
    sleepFn,
    telegramBotToken,
  },
) {
  return retryFn(
    async () => {
      const response = await fetchFn(
        `https://api.telegram.org/bot${telegramBotToken}/${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      )
      const data = await response.json()
      const status = Number(response.status)

      if (
        (!response.ok || !data.ok) &&
        (status === 429 || (status >= 500 && status <= 599))
      ) {
        throw Error(data.description || `Telegram returned status ${status}.`)
      }

      return { data, response }
    },
    {
      delayMs: retryDelayMs,
      maxAttempts: retryMaxAttempts,
      onRetry: (error, { attempt, nextDelay }) => {
        log(
          `⚠️ Telegram attempt ${attempt} failed; retrying in ${nextDelay} ms.`,
          error.message,
        )
      },
      sleepFn,
    },
  )
}

export async function deleteLastNotification({
  clearLastMessageFn = clearLastMessage,
  fetchFn = globalThis.fetch,
  lastMessageFile = LAST_MESSAGE_FILE,
  loadLastMessageFn = loadLastMessage,
  retryDelayMs = RETRY_DELAY_MS,
  retryFn = retry,
  retryMaxAttempts = RETRY_MAX_ATTEMPTS,
  sleepFn,
  telegramBotToken = TELEGRAM_BOT_TOKEN,
  telegramChatId = TELEGRAM_CHAT_ID,
} = {}) {
  const lastMessage = loadLastMessageFn(lastMessageFile) || {}

  if (!lastMessage.message_id) {
    log("🟢 Notification is not found.")
    return true
  }

  if (!telegramBotToken)
    throw Error("❌ Missing telegram bot token or chat id.")
  if (!telegramChatId) throw Error("❌ Missing telegram chat id.")

  log("🗑️ Deleting notification...")

  try {
    const { data, response } = await requestTelegram(
      "deleteMessage",
      {
        chat_id: telegramChatId,
        message_id: lastMessage.message_id,
      },
      {
        fetchFn,
        retryDelayMs,
        retryFn,
        retryMaxAttempts,
        sleepFn,
        telegramBotToken,
      },
    )

    if (!response.ok || !data.ok) {
      if (
        data.description
          ?.toLowerCase()
          .includes("message to delete not found")
      ) {
        clearLastMessageFn(lastMessageFile)
        log("🟢 Notification is already deleted.")
        return true
      }

      throw Error(data.description || "Telegram API request failed.")
    }

    clearLastMessageFn(lastMessageFile)
    log("🟢 Notification deleted.")
    return true
  } catch (error) {
    log("🔴 Notification not deleted.", error.message)
    return false
  }
}

export async function sendNotification(
  message,
  {
    fetchFn = globalThis.fetch,
    isQuietHoursFn = isQuietHours,
    lastMessageFile = LAST_MESSAGE_FILE,
    loadLastMessageFn = loadLastMessage,
    now = new Date(),
    retryDelayMs = RETRY_DELAY_MS,
    retryFn = retry,
    retryMaxAttempts = RETRY_MAX_ATTEMPTS,
    saveLastMessageFn = saveLastMessage,
    sleepFn,
    sourceHash,
    telegramBotToken = TELEGRAM_BOT_TOKEN,
    telegramChatId = TELEGRAM_CHAT_ID,
  } = {},
) {
  if (!telegramBotToken)
    throw Error("❌ Missing telegram bot token or chat id.")
  if (!telegramChatId) throw Error("❌ Missing telegram chat id.")

  log("🌀 Sending notification...")

  const lastMessage = loadLastMessageFn(lastMessageFile) || {}
  try {
    const requestNotification = async (method, messageId) => {
      return requestTelegram(
        method,
        {
          chat_id: telegramChatId,
          text: message,
          parse_mode: "HTML",
          message_id: messageId,
          disable_notification: isQuietHoursFn(now),
        },
        {
          fetchFn,
          retryDelayMs,
          retryFn,
          retryMaxAttempts,
          sleepFn,
          telegramBotToken,
        },
      )
    }

    let { data, response } = await requestNotification(
      lastMessage.message_id ? "editMessageText" : "sendMessage",
      lastMessage.message_id,
    )

    if (
      (!response.ok || !data.ok) &&
      lastMessage.message_id &&
      data.description?.toLowerCase().includes("message to edit not found")
    ) {
      log("⚠️ Previous notification is missing. Sending a new one...")
      const newNotification = await requestNotification("sendMessage")
      data = newNotification.data
      response = newNotification.response
    }

    if (!response.ok || !data.ok) {
      if (
        lastMessage.message_id &&
        data.description?.toLowerCase().includes("message is not modified")
      ) {
        if (
          typeof sourceHash === "string" &&
          lastMessage.source_hash !== sourceHash
        ) {
          saveLastMessageFn(
            { ...lastMessage, source_hash: sourceHash },
            lastMessageFile,
          )
        }
        log("🟢 Notification is already up to date.")
        return true
      }

      throw Error(data.description || "Telegram API request failed.")
    }

    saveLastMessageFn(
      {
        ...data.result,
        ...(typeof sourceHash === "string"
          ? { source_hash: sourceHash }
          : {}),
      },
      lastMessageFile,
    )

    log("🟢 Notification sent.")
    return true
  } catch (error) {
    log("🔴 Notification not sent.", error.message)
    return false
  }
}

export async function run({
  checkIsOutageFn = checkIsOutage,
  checkIsAccidentFn = checkIsAccident,
  deleteLastNotificationFn = deleteLastNotification,
  generateMessageFn = generateMessage,
  getAddressOutageMessageHashFn = getAddressOutageMessageHash,
  getInfoFn = getInfo,
  loadLastMessageFn = loadLastMessage,
  sendNotificationFn = sendNotification,
} = {}) {
  const info = await getInfoFn()

  const isOutage = checkIsOutageFn(info)
  const isAccident = checkIsAccidentFn(info)
  if (isOutage && isAccident) {
    const sourceHash = getAddressOutageMessageHashFn(info)
    const lastAddressMessage = loadLastMessageFn(LAST_MESSAGE_FILE) || {}
    const shouldReplaceNotification = hasNotificationSourceChanged(
      lastAddressMessage,
      sourceHash,
    )
    let canSendNotification = true

    if (shouldReplaceNotification) {
      canSendNotification = await deleteLastNotificationFn({
        lastMessageFile: LAST_MESSAGE_FILE,
      })
    }

    if (canSendNotification) {
      const message = generateMessageFn(info)
      await sendNotificationFn(message, {
        lastMessageFile: LAST_MESSAGE_FILE,
        sourceHash,
      })
    }
  }

  if (!isAccident) {
    await deleteLastNotificationFn({ lastMessageFile: LAST_MESSAGE_FILE })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    logError(error.message)
    process.exitCode = 1
  })
}
