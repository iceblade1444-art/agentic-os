import nodemailer from "nodemailer";

import { config } from "../config.js";

const html = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

export class AccountMailer {
  constructor(mailConfig = config.mail) {
    this.config = mailConfig;
    this.ready = !!(mailConfig.host && mailConfig.from);
    this.transport = this.ready ? nodemailer.createTransport({
      host: mailConfig.host,
      port: mailConfig.port,
      secure: mailConfig.secure,
      auth: mailConfig.user ? { user: mailConfig.user, pass: mailConfig.password } : undefined,
      disableFileAccess: true,
      disableUrlAccess: true,
    }) : null;
  }

  async sendLink({ to, name, purpose, url }) {
    if (!this.ready) return false;
    const verification = purpose === "verify_email";
    const subject = verification ? "Confirm your Mila Agentic OS email" : "Reset your Mila Agentic OS password";
    const action = verification ? "Confirm email" : "Reset password";
    const lifespan = verification ? "24 hours" : "30 minutes";
    await this.transport.sendMail({
      from: this.config.from,
      to,
      subject,
      text: `Hello ${name || ""}. ${action}: ${url}\nThis one-time link expires in ${lifespan}.`,
      html: `<p>Hello ${html(name || "")}.</p><p><a href="${html(url)}">${action}</a></p><p>This one-time link expires in ${lifespan}.</p>`,
    });
    return true;
  }
}

export const accountMailer = new AccountMailer();
