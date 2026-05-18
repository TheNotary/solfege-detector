import { test, expect, type ConsoleMessage } from "@playwright/test";

/**
 * Smoke test: load each top-level route in a headless browser and confirm no
 * `console.error` calls and no uncaught page errors fire during the first few
 * seconds after mount.
 *
 * The app expects a websocket backend on ws://localhost:8000. Without one,
 * benign reconnect logs would fail the assertion, so those are filtered out.
 * Any *other* console.error or pageerror is treated as a real regression.
 */

const BENIGN_PATTERNS: RegExp[] = [
  // Backend websocket isn't running in CI; the app retries silently.
  /WebSocket connection .* failed/i,
  /ws:\/\/localhost:8000/,
  /failed to connect/i,
  // Vite HMR ping noise when the dev server restarts.
  /\[vite\] connect(ed|ing)/i,
];

function isBenign(text: string): boolean {
  return BENIGN_PATTERNS.some((re) => re.test(text));
}

/**
 * Hook console.error + pageerror collection onto a page. Returns an array
 * the test can drain after navigation/interaction is done.
 */
function captureErrors(page: import("@playwright/test").Page): string[] {
  const errors: string[] = [];

  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (isBenign(text)) return;
    errors.push(`[console.error] ${text}`);
  });

  page.on("pageerror", (err: Error) => {
    const text = `${err.message}\n${err.stack ?? ""}`;
    if (isBenign(text)) return;
    errors.push(`[pageerror] ${text}`);
  });

  return errors;
}

test.describe("smoke: no console errors", () => {
  test("MainMenu (/) loads cleanly", async ({ page }) => {
    const errors = captureErrors(page);

    await page.goto("/");
    // MainMenu renders three navigation entries.
    await expect(page.getByText(/Play Game/i)).toBeVisible();

    // Let any async effects / settings reads settle.
    await page.waitForTimeout(500);

    expect(errors, errors.join("\n----\n")).toEqual([]);
  });

  test("ConfigView (/config) loads cleanly", async ({ page }) => {
    const errors = captureErrors(page);

    await page.goto("/config");
    await page.waitForTimeout(500);

    expect(errors, errors.join("\n----\n")).toEqual([]);
  });

  test("CalibrateView (/calibrate) loads cleanly", async ({ page }) => {
    const errors = captureErrors(page);

    await page.goto("/calibrate");
    await page.waitForTimeout(500);

    expect(errors, errors.join("\n----\n")).toEqual([]);
  });

  test("GameView (/play) mounts and starts the audio graph cleanly", async ({ page }) => {
    const errors = captureErrors(page);

    await page.goto("/play", { waitUntil: "domcontentloaded" });

    // GameView mounts staff labels for each solfege syllable; wait for one
    // as a proxy for "the component rendered without throwing".
    await page.waitForSelector(".staff-label", { timeout: 5_000 });

    // Give the AudioContext, AEC worklet load, and the first few render
    // cycles a chance to run so any wiring/lifecycle errors surface.
    await page.waitForTimeout(2_000);

    expect(errors, errors.join("\n----\n")).toEqual([]);
  });
});
