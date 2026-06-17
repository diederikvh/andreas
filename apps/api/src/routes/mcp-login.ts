/**
 * Web-login voor de MCP OAuth-flow. De better-auth mcp-plugin stuurt een
 * niet-ingelogde gebruiker naar deze pagina (`loginPage`) met de originele
 * /authorize-query erachter. Hier logt de gebruiker in met de telefoon-OTP
 * (dezelfde endpoints als de app), waarna we terugsturen naar
 * `/api/auth/mcp/authorize?<originele query>` — die ziet nu de sessie en
 * geeft de autorisatiecode af aan de client.
 */
import { Hono } from 'hono';

export const mcpLoginRoute = new Hono();

const PAGE = `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Andreas — inloggen</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh; display: flex; align-items: center; justify-content: center;
    background: #0a0a0b; color: #f2f2ef;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    padding: 24px;
  }
  .card { width: 100%; max-width: 360px; }
  .brand { font-size: 28px; font-weight: 800; letter-spacing: -0.02em; margin: 0 0 4px; }
  .brand span { color: #d4ff3a; }
  .sub { color: #9a9a94; font-size: 14px; margin: 0 0 28px; line-height: 1.4; }
  label { display: block; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #9a9a94; margin: 0 0 8px; }
  input {
    width: 100%; padding: 14px 16px; font-size: 16px; border-radius: 12px;
    border: 1px solid #2a2a2d; background: #141416; color: #f2f2ef; margin-bottom: 16px;
  }
  input:focus { outline: none; border-color: #d4ff3a; }
  button {
    width: 100%; padding: 14px 16px; font-size: 16px; font-weight: 600; border: none;
    border-radius: 12px; background: #d4ff3a; color: #0a0a0b; cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  .msg { font-size: 13px; margin-top: 14px; min-height: 18px; }
  .msg.err { color: #ff6b6b; }
  .msg.ok { color: #9a9a94; }
  .hidden { display: none; }
</style>
</head>
<body>
  <div class="card">
    <h1 class="brand">Andreas <span>✕</span></h1>
    <p class="sub">Log in met je telefoonnummer om deze app toegang te geven tot het Amsterdamse uitgaansaanbod.</p>

    <div id="step-phone">
      <label for="phone">Telefoonnummer</label>
      <input id="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+31 6 12345678" />
      <button id="send">Stuur code</button>
    </div>

    <div id="step-code" class="hidden">
      <label for="code">Code uit sms</label>
      <input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" />
      <button id="verify">Inloggen</button>
    </div>

    <div id="msg" class="msg"></div>
  </div>

<script>
  // De originele /authorize-query staat in onze eigen URL — die geven we
  // straks 1-op-1 mee terug naar het authorize-endpoint.
  var authorizeQuery = window.location.search || '';
  var phoneEl = document.getElementById('phone');
  var codeEl = document.getElementById('code');
  var sendBtn = document.getElementById('send');
  var verifyBtn = document.getElementById('verify');
  var msg = document.getElementById('msg');
  var stepPhone = document.getElementById('step-phone');
  var stepCode = document.getElementById('step-code');

  function setMsg(text, kind) { msg.textContent = text || ''; msg.className = 'msg ' + (kind || ''); }
  // Normaliseer naar E.164 zodat het matcht met het app-account (dat als
  // +31… is opgeslagen). Anders maakt better-auth een tweede user aan.
  function normalizePhone(raw) {
    var s = (raw || '').replace(/[\\s()\\-]/g, '');
    if (s.indexOf('00') === 0) s = '+' + s.slice(2);
    if (s.charAt(0) === '+') return s;
    if (s.charAt(0) === '0') return '+31' + s.slice(1); // NL lokaal: 06… → +316…
    return '+' + s; // bv. 316… → +316…
  }
  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      // Volg geen 302 (verify kan redirecten) — de cookie wordt toch gezet
      // en we bevestigen via get-session. Voorkomt een cross-origin throw.
      redirect: 'manual',
      body: JSON.stringify(body),
    });
  }

  sendBtn.addEventListener('click', async function () {
    var phoneNumber = normalizePhone(phoneEl.value);
    if (!phoneNumber || phoneNumber.length < 8) { setMsg('Vul je telefoonnummer in.', 'err'); return; }
    sendBtn.disabled = true; setMsg('Code versturen…', 'ok');
    try {
      var r = await post('/api/auth/phone-number/send-otp', { phoneNumber: phoneNumber });
      if (!r.ok) throw new Error('send failed');
      window._phone = phoneNumber;
      stepPhone.classList.add('hidden');
      stepCode.classList.remove('hidden');
      setMsg('We hebben een code gestuurd naar ' + phoneNumber + '.', 'ok');
      codeEl.focus();
    } catch (e) {
      setMsg('Versturen mislukt. Klopt het nummer?', 'err');
    } finally { sendBtn.disabled = false; }
  });

  verifyBtn.addEventListener('click', async function () {
    var code = codeEl.value.trim();
    if (!code) { setMsg('Vul de code in.', 'err'); return; }
    verifyBtn.disabled = true; setMsg('Inloggen…', 'ok');
    try {
      // verify kan 200 óf een 302-redirect teruggeven; in beide gevallen
      // wordt de sessie-cookie gezet. We vertrouwen daarom niet op de
      // response-status, maar bevestigen de login via get-session.
      await post('/api/auth/phone-number/verify', { phoneNumber: window._phone, code: code });
      var s = await fetch('/api/auth/get-session', { credentials: 'include' });
      var session = s.ok ? await s.json() : null;
      if (session && session.user) {
        setMsg('Gelukt, je wordt teruggestuurd…', 'ok');
        window.location.href = '/api/auth/mcp/authorize' + authorizeQuery;
      } else {
        setMsg('Code klopt niet of is verlopen.', 'err');
        verifyBtn.disabled = false;
      }
    } catch (e) {
      setMsg('Er ging iets mis. Probeer het opnieuw.', 'err');
      verifyBtn.disabled = false;
    }
  });
</script>
</body>
</html>`;

mcpLoginRoute.get('/', (c) => c.html(PAGE));
