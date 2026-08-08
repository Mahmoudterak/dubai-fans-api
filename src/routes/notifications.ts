import { Router, type IRouter } from "express";
import fs from "fs";
import path from "path";

const router: IRouter = Router();

// ── Token Storage (JSON file, persists across restarts) ──────────────────────
const DATA_DIR = path.join(process.cwd(), "data");
const TOKENS_FILE = path.join(DATA_DIR, "push-tokens.json");

function loadTokens(): string[] {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(TOKENS_FILE)) return [];
    return JSON.parse(fs.readFileSync(TOKENS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveTokens(tokens: string[]): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKENS_FILE, JSON.stringify([...new Set(tokens)], null, 2));
}

// ── POST /api/notifications/register ─────────────────────────────────────────
router.post("/notifications/register", (req, res): void => {
  const { token } = req.body as { token?: string };
  if (!token || typeof token !== "string" || !token.startsWith("ExponentPushToken")) {
    res.status(400).json({ error: "رمز الإشعار غير صالح" });
    return;
  }
  const tokens = loadTokens();
  if (!tokens.includes(token)) {
    tokens.push(token);
    saveTokens(tokens);
  }
  res.json({ success: true, registered: tokens.length });
});

// ── POST /api/notifications/send ──────────────────────────────────────────────
// Protected by ADMIN_PASSWORD header
router.post("/notifications/send", async (req, res): Promise<void> => {
  const adminSecret = process.env.ADMIN_PASSWORD;
  const provided = req.headers["x-admin-secret"];

  if (adminSecret && provided !== adminSecret) {
    res.status(401).json({ error: "غير مصرح" });
    return;
  }

  const { title, body, data } = req.body as {
    title?: string;
    body?: string;
    data?: Record<string, string>;
  };

  if (!title || !body) {
    res.status(400).json({ error: "العنوان والنص مطلوبان" });
    return;
  }

  const tokens = loadTokens();
  if (tokens.length === 0) {
    res.json({ success: true, sent: 0, message: "لا توجد أجهزة مسجّلة بعد" });
    return;
  }

  // Send via Expo Push API in chunks of 100
  const CHUNK = 100;
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < tokens.length; i += CHUNK) {
    const chunk = tokens.slice(i, i + CHUNK).map((to) => ({
      to,
      title,
      body,
      data: data ?? {},
      sound: "default",
    }));

    try {
      const response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
        },
        body: JSON.stringify(chunk),
      });

      const result = (await response.json()) as { data: { status: string }[] };
      const statuses = Array.isArray(result.data) ? result.data : [];
      sent += statuses.filter((s) => s.status === "ok").length;
      failed += statuses.filter((s) => s.status !== "ok").length;
    } catch (err) {
      req.log.error({ err }, "Expo Push API error");
      failed += chunk.length;
    }
  }

  res.json({ success: true, sent, failed, total: tokens.length });
});

// ── GET /api/notifications/stats ──────────────────────────────────────────────
router.get("/notifications/stats", (req, res): void => {
  const adminSecret = process.env.ADMIN_PASSWORD;
  const provided = req.headers["x-admin-secret"];
  if (adminSecret && provided !== adminSecret) {
    res.status(401).json({ error: "غير مصرح" });
    return;
  }
  const tokens = loadTokens();
  res.json({ registeredDevices: tokens.length });
});

export default router;
