// Pluggable SMS sender. No provider configured (dev default) -> logs to the console.
async function send({ to, message }) {
  if (!process.env.SMS_API_URL) {
    console.log(`[sms] (dev, not sent) to=${to} message="${message}"`);
    return { dev: true };
  }
  const res = await fetch(process.env.SMS_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.SMS_API_KEY ? { Authorization: `Bearer ${process.env.SMS_API_KEY}` } : {}),
    },
    body: JSON.stringify({ to, message, from: process.env.SMS_SENDER_ID || 'WIMScare' }),
  });
  if (!res.ok) throw new Error(`SMS provider responded with ${res.status}`);
  return res.json().catch(() => ({}));
}

async function sendOtpSms(phone, code, { purpose } = {}) {
  const label = purpose === 'login' ? 'login' : 'phone verification';
  await send({ to: phone, message: `WIMScare ${label} code: ${code}. Expires in 10 minutes. Do not share this code.` });
}

module.exports = { send, sendOtpSms };
