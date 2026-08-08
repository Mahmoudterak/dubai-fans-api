/**
 * Admin notifications page HTML — inlined so it can be served from
 * Cloudflare Workers without filesystem access.
 *
 * Original source: public/admin/notifications.html
 * To update: edit that file, then copy the content here.
 */
export const NOTIFICATIONS_HTML = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>لوحة الإشعارات — دبي فانز</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: "Segoe UI", Tahoma, Arial, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }

    .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 1rem;
      padding: 2rem;
      width: 100%;
      max-width: 480px;
      box-shadow: 0 20px 40px rgba(0,0,0,.4);
    }

    .logo {
      text-align: center;
      margin-bottom: 1.5rem;
    }
    .logo h1 {
      font-size: 1.4rem;
      font-weight: 700;
      color: #f1f5f9;
      letter-spacing: .02em;
    }
    .logo p {
      font-size: .85rem;
      color: #94a3b8;
      margin-top: .25rem;
    }

    label {
      display: block;
      font-size: .85rem;
      font-weight: 600;
      color: #94a3b8;
      margin-bottom: .4rem;
    }

    input, textarea, select {
      width: 100%;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: .5rem;
      color: #f1f5f9;
      font-size: 1rem;
      padding: .65rem .85rem;
      outline: none;
      transition: border-color .2s;
      font-family: inherit;
    }
    input:focus, textarea:focus, select:focus {
      border-color: #6366f1;
    }
    textarea {
      resize: vertical;
      min-height: 80px;
    }
    select option {
      background: #1e293b;
    }

    .field { margin-bottom: 1.1rem; }

    .divider {
      border: none;
      border-top: 1px solid #334155;
      margin: 1.4rem 0;
    }

    button[type="submit"] {
      width: 100%;
      background: #6366f1;
      color: #fff;
      border: none;
      border-radius: .55rem;
      font-size: 1rem;
      font-weight: 700;
      padding: .8rem;
      cursor: pointer;
      transition: background .2s, transform .1s;
      font-family: inherit;
    }
    button[type="submit"]:hover { background: #4f46e5; }
    button[type="submit"]:active { transform: scale(.98); }
    button[type="submit"]:disabled {
      background: #334155;
      color: #64748b;
      cursor: not-allowed;
    }

    #result {
      margin-top: 1.1rem;
      border-radius: .55rem;
      padding: .85rem 1rem;
      font-size: .9rem;
      line-height: 1.5;
      display: none;
    }
    #result.success {
      background: #064e3b;
      border: 1px solid #065f46;
      color: #6ee7b7;
      display: block;
    }
    #result.error {
      background: #450a0a;
      border: 1px solid #7f1d1d;
      color: #fca5a5;
      display: block;
    }

    .stats-bar {
      display: flex;
      gap: .75rem;
      margin-bottom: 1.4rem;
    }
    .stat {
      flex: 1;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: .55rem;
      padding: .65rem .85rem;
      text-align: center;
    }
    .stat .num {
      font-size: 1.5rem;
      font-weight: 700;
      color: #6366f1;
    }
    .stat .lbl {
      font-size: .75rem;
      color: #64748b;
      margin-top: .15rem;
    }
  </style>
</head>
<body>
<div class="card">
  <div class="logo">
    <h1>🔔 لوحة الإشعارات</h1>
    <p>إرسال إشعار فوري لجميع أجهزة دبي فانز</p>
  </div>

  <!-- Stats row (loaded on page open) -->
  <div class="stats-bar">
    <div class="stat">
      <div class="num" id="stat-devices">—</div>
      <div class="lbl">جهاز مسجّل</div>
    </div>
  </div>

  <form id="notif-form" autocomplete="off">
    <div class="field">
      <label for="password">كلمة مرور المدير</label>
      <input type="password" id="password" name="password" placeholder="••••••••" required />
    </div>

    <hr class="divider" />

    <div class="field">
      <label for="title">عنوان الإشعار</label>
      <input type="text" id="title" name="title" placeholder="مثال: عرض خاص اليوم فقط!" maxlength="100" required />
    </div>

    <div class="field">
      <label for="body">نص الإشعار</label>
      <textarea id="body" name="body" placeholder="اكتب محتوى الإشعار هنا…" maxlength="250" required></textarea>
    </div>

    <div class="field">
      <label for="screen">الشاشة الوجهة</label>
      <select id="screen" name="screen">
        <option value="">— بدون توجيه —</option>
        <option value="pricing">صفحة الأسعار</option>
        <option value="services">صفحة الخدمات</option>
        <option value="analyze">صفحة التحليل</option>
      </select>
    </div>

    <button type="submit" id="send-btn">إرسال الإشعار</button>
  </form>

  <div id="result"></div>
</div>

<script>
  const API_BASE = window.location.origin;

  // ── Load device count on page load ──────────────────────────────────────────
  async function loadStats(password) {
    try {
      const headers = password ? { "x-admin-secret": password } : {};
      const res = await fetch(\`\${API_BASE}/api/notifications/stats\`, { headers });
      if (res.ok) {
        const data = await res.json();
        document.getElementById("stat-devices").textContent = data.registeredDevices ?? "—";
      }
    } catch { /* silent */ }
  }

  // Attempt initial load without a password (server may have no ADMIN_SECRET set)
  loadStats("");

  // ── Send form ────────────────────────────────────────────────────────────────
  document.getElementById("notif-form").addEventListener("submit", async (e) => {
    e.preventDefault();

    const password = document.getElementById("password").value.trim();
    const title    = document.getElementById("title").value.trim();
    const body     = document.getElementById("body").value.trim();
    const screen   = document.getElementById("screen").value;

    const btn    = document.getElementById("send-btn");
    const result = document.getElementById("result");

    btn.disabled = true;
    btn.textContent = "جارٍ الإرسال…";
    result.className = "";
    result.style.display = "none";

    // Refresh stats with the entered password
    await loadStats(password);

    const payload = { title, body };
    if (screen) payload.data = { screen };

    try {
      const res = await fetch(\`\${API_BASE}/api/notifications/send\`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-secret": password,
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        result.className = "error";
        result.textContent = \`❌ خطأ: \${data.error || res.statusText}\`;
      } else if (data.sent === 0 && data.total === 0) {
        result.className = "success";
        result.textContent = "⚠️ لا توجد أجهزة مسجّلة بعد — لم يُرسَل أي إشعار.";
      } else {
        result.className = "success";
        result.innerHTML =
          \`✅ تم الإرسال بنجاح!<br>\` +
          \`📱 وصل إلى <strong>\${data.sent}</strong> جهاز\` +
          (data.failed ? \` — فشل في <strong>\${data.failed}</strong>\` : "") +
          \` من أصل <strong>\${data.total}</strong> مسجّل.\`;
        // Refresh displayed stats
        await loadStats(password);
      }
    } catch (err) {
      result.className = "error";
      result.textContent = \`❌ تعذّر الاتصال بالخادم: \${err.message}\`;
    } finally {
      btn.disabled = false;
      btn.textContent = "إرسال الإشعار";
    }
  });
</script>
</body>
</html>`;
