import { pathToFileURL } from "node:url"

import { chromium } from "playwright"

import {
  EMERGENCY_OUTAGES_MESSAGE_FILE,
  HOUSE,
  LAST_MESSAGE_FILE,
  RETRY_DELAY_MS,
  RETRY_MAX_ATTEMPTS,
  SHUTDOWNS_PAGE,
  STREET,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
} from "./constants.js"

import {
  capitalize,
  clearLastMessage,
  escapeHtml,
  getEmergencyOutagesAction,
  getCurrentTime,
  isQuietHours,
  loadEmergencyOutagesState,
  loadLastMessage,
  migrateEmergencyOutagesMessageState,
  retry,
  saveEmergencyOutagesState,
  saveLastMessage,
} from "./helpers.js"
import { log, logError } from "./logger.js"

export async function getEmergencyOutagesNotice(browserPage) {
  log("🌀 Checking emergency outages notice...")

  const notice = browserPage.locator(".m-attention__text", {
    hasText: /застосовано|не діють|зафіксовано|зникло світло/i,
  })

  try {
    await notice.waitFor({ state: "visible", timeout: 3000 })
    log("🚨 Emergency outages notice detected!")
    return await notice.evaluate((element) => {
      const segments = []

      const appendText = (text, bold) => {
        if (!text) return

        const previousSegment = segments.at(-1)
        if (previousSegment?.bold === bold) {
          previousSegment.text += text
          return
        }

        segments.push({ text, bold })
      }

      const appendLineBreak = () => {
        let lastSegment = segments.at(-1)
        if (!lastSegment) return

        lastSegment.text = lastSegment.text.trimEnd()
        if (!lastSegment.text) {
          segments.pop()
          lastSegment = segments.at(-1)
        }

        if (!lastSegment || lastSegment.text.endsWith("\n")) return
        appendText("\n", false)
      }

      const collectSegments = (node, bold = false) => {
        if (node.nodeType === 3) {
          let text = (node.textContent ?? "").replace(/\s+/g, " ")
          if (segments.at(-1)?.text.endsWith("\n")) {
            text = text.trimStart()
          }
          appendText(text, bold)
          return
        }

        if (node.nodeType !== 1) return
        if (node.tagName === "BR") {
          appendLineBreak()
          return
        }

        const isBold = bold || node.tagName === "STRONG"
        for (const childNode of node.childNodes) {
          collectSegments(childNode, isBold)
        }

        if (node.tagName === "P") appendLineBreak()
      }

      collectSegments(element)

      if (segments.length > 0) {
        segments[0].text = segments[0].text.trimStart()
        segments.at(-1).text = segments.at(-1).text.trimEnd()
      }

      return {
        segments: segments.filter(({ text }) => text !== ""),
      }
    })
  } catch (error) {
    try {
      if ((await notice.count()) === 0) {
        log("🟢 Emergency outages notice is not found.")
        return null
      }
    } catch (countError) {
      throw Error(
        `❌ Emergency outages notice check failed: ${countError.message}`,
      )
    }

    throw Error(
      `❌ Emergency outages notice check failed: ${error.message}`,
    )
  }
}

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

        const emergencyOutagesNotice =
          await getEmergencyOutagesNotice(browserPage)

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
        return { ...info, emergencyOutagesNotice }
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

export function checkIsScheduled(info, house = HOUSE) {
  log("🌀 Checking whether power outage scheduled...")

  const { sub_type = "" } = getAddressInfo(info, house)
  const normalizedSubtype = String(sub_type).toLowerCase()
  const isScheduled =
    !normalizedSubtype.includes("екстрен") &&
    !normalizedSubtype.includes("аварій")

  isScheduled
    ? log("🗓️ Power outage scheduled!")
    : log("⚠️ Power outage not scheduled!")

  return isScheduled
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

export function generateEmergencyOutagesMessage(notice, now = new Date()) {
  log("🌀 Generating emergency outages message...")

  const formattedNotice = Array.isArray(notice?.segments)
    ? notice.segments
        .map(({ text, bold }) => {
          const escapedText = escapeHtml(text)
          return bold ? `<b>${escapedText}</b>` : escapedText
        })
        .join("")
    : String(notice ?? "")
        .split(/(<\/?strong(?:\s[^<>]*)?>)/gi)
        .map((part) => {
          if (/^<strong(?:\s[^<>]*)?>$/i.test(part)) return "<b>"
          if (/^<\/strong>$/i.test(part)) return "</b>"
          return escapeHtml(part)
        })
        .join("")

  return [
    formattedNotice,
    "",
    `🔄 <i>Дата оновлення інформації – ${getCurrentTime(now)}</i>`,
  ].join("\n")
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
        log("🟢 Notification is already up to date.")
        return true
      }

      throw Error(data.description || "Telegram API request failed.")
    }

    saveLastMessageFn(data.result, lastMessageFile)

    log("🟢 Notification sent.")
    return true
  } catch (error) {
    log("🔴 Notification not sent.", error.message)
    return false
  }
}

export async function run({
  checkIsOutageFn = checkIsOutage,
  checkIsScheduledFn = checkIsScheduled,
  deleteLastNotificationFn = deleteLastNotification,
  generateEmergencyOutagesMessageFn = generateEmergencyOutagesMessage,
  generateMessageFn = generateMessage,
  getInfoFn = getInfo,
  loadEmergencyOutagesStateFn = loadEmergencyOutagesState,
  saveEmergencyOutagesStateFn = saveEmergencyOutagesState,
  sendNotificationFn = sendNotification,
} = {}) {
  const info = await getInfoFn()
  const emergencyOutagesWereActive = loadEmergencyOutagesStateFn()
  const emergencyOutagesAction = getEmergencyOutagesAction(
    info.emergencyOutagesNotice,
    emergencyOutagesWereActive,
  )

  if (emergencyOutagesAction === "send") {
    saveEmergencyOutagesStateFn(true)
    const message = generateEmergencyOutagesMessageFn(
      info.emergencyOutagesNotice,
    )
    await sendNotificationFn(message, {
      lastMessageFile: EMERGENCY_OUTAGES_MESSAGE_FILE,
    })
  }

  if (emergencyOutagesAction === "delete") {
    const notificationDeleted = await deleteLastNotificationFn({
      lastMessageFile: EMERGENCY_OUTAGES_MESSAGE_FILE,
    })
    if (notificationDeleted) {
      saveEmergencyOutagesStateFn(false)
    }
  }

  const isOutage = checkIsOutageFn(info)
  const isScheduled = checkIsScheduledFn(info)
  if (isOutage && !isScheduled) {
    const message = generateMessageFn(info)
    await sendNotificationFn(message, { lastMessageFile: LAST_MESSAGE_FILE })
  }

  if (!isOutage) {
    await deleteLastNotificationFn({ lastMessageFile: LAST_MESSAGE_FILE })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateEmergencyOutagesMessageState({
    emergencyMessageFile: EMERGENCY_OUTAGES_MESSAGE_FILE,
  })
  run().catch((error) => {
    logError(error.message)
    process.exitCode = 1
  })
}
