import { pathToFileURL } from "node:url"

import { chromium } from "playwright"

import {
  HOUSE,
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
  loadEmergencyOutagesState,
  loadLastMessage,
  saveEmergencyOutagesState,
  saveLastMessage,
} from "./helpers.js"

export async function getEmergencyOutagesNotice(browserPage) {
  console.log("🌀 Checking emergency outages notice...")

  const notice = browserPage.locator(
    ".m-attention__text > p:first-child",
  )

  try {
    await notice.waitFor({ state: "visible", timeout: 3000 })
    console.log("🚨 Emergency outages notice detected!")
    return (await notice.innerText()).trim()
  } catch {
    console.log("🟢 Emergency outages notice is not found.")
    return null
  }
}

export async function getInfo({ browserType = chromium } = {}) {
  console.log("🌀 Getting info...")

  const browser = await browserType.launch({ headless: true })

  try {
    const browserPage = await browser.newPage()

    await browserPage.goto(SHUTDOWNS_PAGE, {
      waitUntil: "load",
    })

    const emergencyOutagesNotice =
      await getEmergencyOutagesNotice(browserPage)

    if (emergencyOutagesNotice) {
      console.log("✅ Getting info finished.")
      return { emergencyOutagesNotice }
    }

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
        formData.append("data[1][value]", new Date().toLocaleString("uk-UA"))

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

    console.log("✅ Getting info finished.")
    return info
  } catch (error) {
    throw Error(`❌ Getting info failed: ${error.message}`)
  } finally {
    await browser.close()
  }
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
  console.log("🌀 Checking power outage...")

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
    ? console.log("🚨 Power outage detected!")
    : console.log("⚡️ No power outage!")

  return isOutageDetected
}

export function checkIsScheduled(info, house = HOUSE) {
  console.log("🌀 Checking whether power outage scheduled...")

  const { sub_type = "" } = getAddressInfo(info, house)
  const normalizedSubtype = String(sub_type).toLowerCase()
  const isScheduled =
    !normalizedSubtype.includes("екстрен") &&
    !normalizedSubtype.includes("аварій")

  isScheduled
    ? console.log("🗓️ Power outage scheduled!")
    : console.log("⚠️ Power outage not scheduled!")

  return isScheduled
}

export function generateMessage(
  info,
  { street = STREET, house = HOUSE } = {},
) {
  console.log("🌀 Generating message...")

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
    `🔌 Орієнтовний час відновлення - ${escapeHtml(end_date)}`,
    "",
    `⚠️ <i>${reason}.</i>`,
    "\n",
    `🔄 <i>Дата оновлення інформації – ${escapeHtml(updateTimestamp)}</i>`,
  ].join("\n")
}

export function generateEmergencyOutagesMessage(notice, now = new Date()) {
  console.log("🌀 Generating emergency outages message...")

  return [
    escapeHtml(notice),
    "",
    `🔄 <i>Дата оновлення інформації – ${getCurrentTime(now)}</i>`,
  ].join("\n")
}

export async function deleteLastNotification({
  clearLastMessageFn = clearLastMessage,
  fetchFn = globalThis.fetch,
  loadLastMessageFn = loadLastMessage,
  telegramBotToken = TELEGRAM_BOT_TOKEN,
  telegramChatId = TELEGRAM_CHAT_ID,
} = {}) {
  const lastMessage = loadLastMessageFn() || {}

  if (!lastMessage.message_id) {
    console.log("🟢 Notification is not found.")
    return true
  }

  if (!telegramBotToken)
    throw Error("❌ Missing telegram bot token or chat id.")
  if (!telegramChatId) throw Error("❌ Missing telegram chat id.")

  console.log("🗑️ Deleting notification...")

  try {
    const response = await fetchFn(
      `https://api.telegram.org/bot${telegramBotToken}/deleteMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: telegramChatId,
          message_id: lastMessage.message_id,
        }),
      },
    )

    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw Error(data.description || "Telegram API request failed.")
    }

    clearLastMessageFn()
    console.log("🟢 Notification deleted.")
    return true
  } catch (error) {
    console.log("🔴 Notification not deleted.", error.message)
    return false
  }
}

export async function sendNotification(
  message,
  {
    deleteLastNotificationFn = deleteLastNotification,
    fetchFn = globalThis.fetch,
    loadLastMessageFn = loadLastMessage,
    saveLastMessageFn = saveLastMessage,
    telegramBotToken = TELEGRAM_BOT_TOKEN,
    telegramChatId = TELEGRAM_CHAT_ID,
  } = {},
) {
  if (!telegramBotToken)
    throw Error("❌ Missing telegram bot token or chat id.")
  if (!telegramChatId) throw Error("❌ Missing telegram chat id.")

  console.log("🌀 Sending notification...")

  const lastMessage = loadLastMessageFn() || {}
  try {
    const response = await fetchFn(
      `https://api.telegram.org/bot${telegramBotToken}/${
        lastMessage.message_id ? "editMessageText" : "sendMessage"
      }`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: telegramChatId,
          text: message,
          parse_mode: "HTML",
          message_id: lastMessage.message_id ?? undefined,
          disable_notification: true,
        }),
      },
    )

    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw Error(data.description || "Telegram API request failed.")
    }

    saveLastMessageFn(data.result)

    console.log("🟢 Notification sent.")
    return true
  } catch (error) {
    console.log("🔴 Notification not sent.", error.message)
    await deleteLastNotificationFn()
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
    await sendNotificationFn(message)
    return
  }

  if (emergencyOutagesAction === "delete") {
    const notificationDeleted = await deleteLastNotificationFn()
    if (notificationDeleted) {
      saveEmergencyOutagesStateFn(false)
    }
    return
  }

  const isOutage = checkIsOutageFn(info)
  const isScheduled = checkIsScheduledFn(info)
  if (isOutage && !isScheduled) {
    const message = generateMessageFn(info)
    await sendNotificationFn(message)
  }

  if (!isOutage) {
    await deleteLastNotificationFn()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
