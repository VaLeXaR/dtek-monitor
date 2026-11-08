import fs from "node:fs"
import path from "node:path"

import { warn } from "./logger.js"

export const DTEK_TIMEOUT_MS = 30000

export function loadBrowserState(file) {
  if (!file) return undefined
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"))
    if (!Array.isArray(state?.cookies) || !Array.isArray(state?.origins)) {
      throw Error("Invalid state")
    }
    return state
  } catch (error) {
    if (error.code !== "ENOENT") {
      warn("⚠️ Сесію браузера ДТЕК не вдалося прочитати; створюється нова.")
    }
    return undefined
  }
}

export async function saveBrowserState(context, file) {
  if (!context || !file) return
  const temporaryFile = `${file}.${process.pid}.tmp`
  try {
    const state = await context.storageState()
    // Keep only the target site's cookies and local storage, never analytics.
    state.cookies = state.cookies.filter((cookie) =>
      /(^|\.)dtek-kem\.com\.ua$/.test(cookie.domain)
    )
    state.origins = state.origins.filter(
      ({ origin }) => origin === "https://www.dtek-kem.com.ua"
    )
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(temporaryFile, JSON.stringify(state), {
      flag: "wx",
      mode: 0o600,
    })
    fs.renameSync(temporaryFile, file)
  } catch {
    warn("⚠️ Сесію браузера ДТЕК не вдалося зберегти.")
  } finally {
    try {
      fs.rmSync(temporaryFile, { force: true })
    } catch {
      // A cleanup failure must not discard an otherwise usable DTEK result.
    }
  }
}

export async function waitForDtekPage(page) {
  await page.locator('meta[name="csrf-token"]').waitFor({
    state: "attached",
    timeout: DTEK_TIMEOUT_MS,
  })
}

export function isAddressResponse(response, street) {
  const request = response.request()
  const url = new URL(response.url())
  if (
    url.origin !== "https://www.dtek-kem.com.ua" ||
    url.pathname !== "/ua/ajax" ||
    request.method() !== "POST"
  )
    return false

  const form = new URLSearchParams(request.postData() || "")
  if (form.get("method") !== "getHomeNum") return false
  return [...form].some(
    ([name, value]) =>
      /^data\[\d+\]\[name\]$/.test(name) &&
      value === "street" &&
      form.get(name.replace("[name]", "[value]"))?.trim().toLowerCase() ===
        street.trim().toLowerCase()
  )
}

export async function readAddressResponse(response) {
  if (!response.ok()) {
    throw Error(`DTEK request failed with status ${response.status()}.`)
  }
  const body = await response.text()
  if (body.trimStart().startsWith("<")) {
    const reason = body.includes("_Incapsula_Resource")
      ? "Incapsula blocked the address request"
      : "HTML received instead of JSON"
    throw Error(`DTEK /ua/ajax: ${reason} (HTTP ${response.status()}).`)
  }
  let info
  try {
    info = JSON.parse(body)
  } catch {
    throw Error("DTEK /ua/ajax returned invalid JSON.")
  }
  if (
    info?.result !== true ||
    !info.data ||
    typeof info.data !== "object" ||
    Array.isArray(info.data)
  ) {
    throw Error("DTEK /ua/ajax returned unsuccessful or invalid address data.")
  }
  return info
}

export async function getAddressInfoFromForm(page, street) {
  if (!street?.trim()) throw Error("STREET must be configured.")
  let response
  try {
    await page.waitForFunction(
      () =>
        typeof DisconSchedule !== "undefined" &&
        typeof DisconSchedule.ajax?.formSubmit === "function" &&
        !!DisconSchedule.ajax.url &&
        Array.isArray(DisconSchedule.streets) &&
        typeof jQuery === "function" &&
        document.readyState === "complete",
      null,
      { timeout: DTEK_TIMEOUT_MS }
    )
    const closeButtons = page.locator(".m-attention__close:visible")
    for (const button of await closeButtons.all()) await button.click()

    await page.locator("#discon_form #street").fill(street)
    // Match the entire label so similarly named streets cannot be selected.
    const escapedStreet = street.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const option = page.locator("#streetautocomplete-list > div").filter({
      hasText: new RegExp(`^${escapedStreet}$`, "iu"),
    })
    await option.waitFor({ state: "visible", timeout: DTEK_TIMEOUT_MS })
    const results = await Promise.all([
      page.waitForResponse((value) => isAddressResponse(value, street), {
        timeout: DTEK_TIMEOUT_MS,
      }),
      option.click(),
    ])
    response = results[0]
  } catch (error) {
    // Playwright errors can contain selectors with the private street value.
    const reason = error.name === "TimeoutError" ? "timeout" : "browser error"
    throw Error(
      `DTEK address form interaction failed (${reason}); site scripts or requests may be blocked.`
    )
  }
  return readAddressResponse(response)
}
