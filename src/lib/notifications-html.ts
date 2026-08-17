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

    button[type="submit"], .logout-btn {
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
    button[type="submit"]:hover, .logout-btn:hover { background: #4f46e5; }
    button[type="submit"]:active, .logout-btn:active { transform: scale(.98); }
    button[type="submit"]:disabled {
      background: #334155;
      color: #64748b;
      cursor: not-allowed;
    }
    .logout-btn {
      background: #334155;
      font-size: .85rem;
      padding: .5rem;
      margin-top: .75rem;
    }
    .logout-btn:hover { background: #475569; }

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

    #login-section, #dashboard-section { display: none; }
    #login-section.active, #dashboard-section.active { display: block; }
  </style>
</head>
<body>
<div class="card">
  <div class="logo">
    <h1>🔔 لوحة الإشعارات</h1>
    <p>إرسال إشعار فوري لجميع أجهزة دبي فانز</p>
  </div>

  <!-- ── Login section ──────────────────────────────────────────────────────── -->
  <div id="login-section">
    <form id="login-form" autocomplete="off">
      <div class="field">
        <label for="email">البريد الإلكتروني</label>
        <input type="email" id="email" name="email" placeholder="admin@example.com" required autofocus />
      </div>
      <div class="field">
        <label for="password">كلمة المرور</label>
        <input type="password" id="password" name="password" placeholder="••••••••" required />
      </div>
      <div id="login-error" style="color:#fca5a5;font-size:.85rem;margin-bottom:.75rem;display:none;"></div>
      <button type="submit" id="login-btn">دخول</button>
    </form>
  </div>

  <!-- ── Dashboard section (shown after login) ─────────────────────────────── -->
  <div id="dashboard-section">
    <!-- Stats row -->
    <div class="stats-bar">
      <div class="stat">
        <div class="num" id="stat-devices">—</div>
        <div class="lbl">جهاز مسجّل</div>
      </div>
    </div>

    <form id="notif-form" autocomplete="off">
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
    <button class="logout-btn" id="logout-btn">تسجيل الخروج</button>
  </div>
</div>

<script>
  const API_BASE = window.location.origin;

  const loginSection     = document.getElementById("login-section");
  const dashboardSection = document.getElementById("dashboard-section");

  function showLogin()     { loginSection.classList.add("active");    dashboardSection.classList.remove("active"); }
  function showDashboard() { dashboardSection.classList.add("active"); loginSection.classList.remove("active"); }

  // ── Load device count ────────────────────────────────────────────────────────
  async function loadStats() {
    try {
      const res = await fetch(\`\${API_BASE}/api/notifications/stats\`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        document.getElementById("stat-devices").textContent = data.registeredDevices ?? "—";
      }
    } catch { /* silent */ }
  }

  // ── Check existing session on page load ──────────────────────────────────────
  (async () => {
    try {
      const res = await fetch(\`\${API_BASE}/api/portal/admin/auth/me\`, { credentials: "include" });
      if (res.ok) {
        showDashboard();
        await loadStats();
      } else {
        showLogin();
      }
    } catch {
      showLogin();
    }
  })();

  // ── Login form ───────────────────────────────────────────────────────────────
  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const loginError = document.getElementById("login-error");
    const loginBtn   = document.getElementById("login-btn");
    const email      = document.getElementById("email").value.trim();
    const password   = document.getElementById("password").value;

    loginError.style.display = "none";
    loginBtn.disabled = true;
    loginBtn.textContent = "جارٍ التحقق…";

    try {
      const res = await fetch(\`\${API_BASE}/api/portal/admin/auth/login\`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });

      if (res.ok) {
        showDashboard();
        await loadStats();
      } else {
        const data = await res.json().catch(() => ({}));
        loginError.textContent = data?.error?.message || "البريد الإلكتروني أو كلمة المرور غير صحيحة";
        loginError.style.display = "block";
      }
    } catch (err) {
      loginError.textContent = \`تعذّر الاتصال بالخادم: \${err.message}\`;
      loginError.style.display = "block";
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = "دخول";
    }
  });

  // ── Logout ───────────────────────────────────────────────────────────────────
  document.getElementById("logout-btn").addEventListener("click", async () => {
    await fetch(\`\${API_BASE}/api/portal/admin/auth/logout\`, {
      method: "POST",
      credentials: "include",
    }).catch(() => {});
    showLogin();
    document.getElementById("email").value    = "";
    document.getElementById("password").value = "";
  });

  // ── Send notification form ───────────────────────────────────────────────────
  document.getElementById("notif-form").addEventListener("submit", async (e) => {
    e.preventDefault();

    const title  = document.getElementById("title").value.trim();
    const body   = document.getElementById("body").value.trim();
    const screen = document.getElementById("screen").value;

    const btn    = document.getElementById("send-btn");
    const result = document.getElementById("result");

    btn.disabled = true;
    btn.textContent = "جارٍ الإرسال…";
    result.className = "";
    result.style.display = "none";

    const payload = { title, body };
    if (screen) payload.data = { screen };

    try {
      const res = await fetch(\`\${API_BASE}/api/notifications/send\`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });

      if (res.status === 401 || res.status === 403) {
        showLogin();
        return;
      }

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
        await loadStats();
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
