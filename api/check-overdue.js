const { createClient } = require("@supabase/supabase-js");
const nodemailer = require("nodemailer");
const webpush = require("web-push");

const BUFFER_MINUTES = parseInt(process.env.BUFFER_MINUTES || "10", 10);
const WAIT_MINUTES = parseInt(process.env.WAIT_MINUTES || "15", 10);
const SITE_URL = process.env.SITE_URL || "https://gym-safety.vercel.app";

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function getMailer() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });
}

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    `mailto:${process.env.GMAIL_USER || "no-reply@gym-safety.vercel.app"}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// 이메일과 별개로 즉시 휴대폰 알림을 시도. 구독이 없거나 실패해도
// 이메일 발송 결과에는 영향을 주지 않도록 별도로 처리.
async function sendPushSafely(subscription, payload) {
  if (!subscription) return;
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
  } catch (e) {
    // 만료된 구독 등은 조용히 무시 (이메일이 안전망 역할을 함)
  }
}

// notification_schedule의 요일/시간대를 서버 실행 위치(UTC 등)와 무관하게
// 한국 시간 기준으로 매칭하기 위한 헬퍼
function seoulNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date());

  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });

  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dayOfWeek: weekdayMap[map.weekday],
    hour: parseInt(map.hour, 10) % 24,
    minute: parseInt(map.minute, 10)
  };
}

module.exports = async (req, res) => {
  // Vercel Cron이 보내는 요청인지 확인 (외부에서 아무나 이 URL을 호출해
  // 이메일을 마구 발송시키는 것을 막기 위함)
  if (process.env.CRON_SECRET) {
    const auth = req.headers["authorization"] || "";
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
  }

  const supabase = getSupabase();
  const mailer = getMailer();
  const now = Date.now();
  const results = { alerted: [], escalated: [], errors: [] };

  try {
    // 1단계: (예상 운동시간 + 여유시간)이 지났는데 아직 1차 확인 요청을 안 보낸 사람
    const { data: dueForAlert, error: err1 } = await supabase
      .from("checkins")
      .select("id, name, phone, email, expected_minutes, created_at, confirm_token, push_subscription")
      .eq("status", "운동중")
      .is("alert_sent_at", null);

    if (err1) throw err1;

    for (const row of dueForAlert || []) {
      const deadline = new Date(row.created_at).getTime() + (row.expected_minutes + BUFFER_MINUTES) * 60000;
      if (now < deadline) continue;

      const confirmUrl = `${SITE_URL}/?confirm=${row.id}&token=${row.confirm_token}`;

      try {
        await mailer.sendMail({
          from: process.env.GMAIL_USER,
          to: row.email,
          subject: "[건강체력증진실] 운동 시간 확인 요청",
          text: `${row.name}님, 예상 운동시간이 지났습니다. 계속 안전하게 운동 중이시라면 아래 링크를 눌러 확인해주세요.\n\n${confirmUrl}\n\n${WAIT_MINUTES}분 내에 확인하지 않으시면 비상연락 담당자에게 알림이 발송됩니다.`
        });

        await sendPushSafely(row.push_subscription, {
          title: "운동 시간 확인 요청",
          body: `${row.name}님, 예상 운동시간이 지났습니다. 눌러서 확인해주세요.`,
          url: confirmUrl
        });

        await supabase
          .from("checkins")
          .update({ alert_sent_at: new Date().toISOString() })
          .eq("id", row.id);

        results.alerted.push(row.id);
      } catch (e) {
        results.errors.push({ id: row.id, stage: "alert", message: e.message });
      }
    }

    // 2단계: 1차 확인 요청을 보냈지만 무응답 상태로 대기시간이 지난 사람 -> 비상연락
    const { data: dueForEscalation, error: err2 } = await supabase
      .from("checkins")
      .select("id, name, phone, email, expected_minutes, created_at, alert_sent_at")
      .eq("status", "운동중")
      .is("confirmed_at", null)
      .is("escalated_at", null)
      .not("alert_sent_at", "is", null);

    if (err2) throw err2;

    let contacts = null;

    for (const row of dueForEscalation || []) {
      const deadline = new Date(row.alert_sent_at).getTime() + WAIT_MINUTES * 60000;
      if (now < deadline) continue;

      if (!contacts) {
        const { dayOfWeek, hour, minute } = seoulNow();
        const nowTimeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;

        const { data: scheduleRows, error: err3 } = await supabase
          .from("notification_schedule")
          .select("contact_name, contact_email")
          .eq("day_of_week", dayOfWeek)
          .lte("start_time", nowTimeStr)
          .gte("end_time", nowTimeStr);

        if (err3) throw err3;
        contacts = scheduleRows || [];
      }

      if (contacts.length === 0) {
        results.errors.push({ id: row.id, stage: "escalate", message: "해당 시간대 담당자가 notification_schedule에 없음" });
        continue;
      }

      try {
        await mailer.sendMail({
          from: process.env.GMAIL_USER,
          to: contacts.map(c => c.contact_email).join(","),
          subject: "[건강체력증진실] 미퇴실 확인 필요",
          text: `${row.name}(${row.phone})님이 예상 운동시간(${row.expected_minutes}분)을 초과했고, 확인 요청에 응답이 없습니다.\n입실시각: ${new Date(row.created_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}\n현장 확인이 필요합니다.`
        });

        await supabase
          .from("checkins")
          .update({ escalated_at: new Date().toISOString() })
          .eq("id", row.id);

        results.escalated.push(row.id);
      } catch (e) {
        results.errors.push({ id: row.id, stage: "escalate", message: e.message });
      }
    }

    res.status(200).json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
