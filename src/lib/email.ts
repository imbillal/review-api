import nodemailer from "nodemailer";

const user = process.env.SMTP_USER ?? process.env.NODEMAILER_EMAIL;
const pass = process.env.SMTP_PASS ?? process.env.NODEMAILER_PASS;
const from = process.env.EMAIL_FROM ?? (user ? `Pinion <${user}>` : "Pinion <noreply@pinion.dev>");

const transporter =
  user && pass
    ? nodemailer.createTransport({
        service: "gmail",
        auth: { user, pass },
      })
    : null;

export type SendEmailResult =
  | { status: "sent"; id: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string };

export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
}): Promise<SendEmailResult> {
  if (!transporter) {
    const reason = "SMTP_USER / SMTP_PASS not set";
    console.warn("[email] skipped:", opts.subject, "→", opts.to, `(${reason})`);
    return { status: "skipped", reason };
  }
  try {
    const info = await transporter.sendMail({
      from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
    });
    return { status: "sent", id: info.messageId };
  } catch (e) {
    const error = (e as Error).message ?? "unknown";
    console.error("[email] send failed:", error);
    return { status: "failed", error };
  }
}

export function inviteEmailHtml(opts: { inviterName: string; scopeLabel: string; acceptUrl: string }) {
  return `
    <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
      <h2 style="margin:0 0 16px">You're invited to Pinion</h2>
      <p>${escapeHtml(opts.inviterName)} invited you to join <b>${escapeHtml(opts.scopeLabel)}</b> on Pinion.</p>
      <p><a href="${opts.acceptUrl}" style="background:#111;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Accept invitation</a></p>
      <p style="color:#666;font-size:12px;margin-top:24px">If you weren't expecting this, you can ignore this email.</p>
    </div>
  `;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
