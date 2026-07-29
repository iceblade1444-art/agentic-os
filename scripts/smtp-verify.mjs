#!/usr/bin/env node
import nodemailer from "nodemailer";
import process from "node:process";

const host = String(process.env.SMTP_HOST || "").trim();
const port = Math.max(1, Number(process.env.SMTP_PORT) || 587);
const secure = String(process.env.SMTP_SECURE || "").toLowerCase() === "true";
const user = String(process.env.SMTP_USER || "").trim();
const password = String(process.env.SMTP_PASSWORD || "");
const from = String(process.env.SMTP_FROM || "").trim();
const testTo = String(process.env.SMTP_TEST_TO || "").trim();

if (!host || !from || (user && !password)) {
  console.error("SMTP is incomplete. Set SMTP_HOST, SMTP_FROM and both SMTP_USER/SMTP_PASSWORD when authentication is used.");
  process.exit(1);
}

const transport = nodemailer.createTransport({
  host,
  port,
  secure,
  auth: user ? { user, pass: password } : undefined,
  disableFileAccess: true,
  disableUrlAccess: true,
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 15000,
});

await transport.verify();
console.log(`SMTP connection and authentication passed for ${host}:${port}.`);

if (testTo) {
  await transport.sendMail({
    from,
    to: testTo,
    subject: "Mila Agentic OS email check",
    text: "SMTP is configured correctly. Account verification and password recovery can now be enabled.",
  });
  console.log("SMTP test message accepted for delivery.");
}

transport.close();
