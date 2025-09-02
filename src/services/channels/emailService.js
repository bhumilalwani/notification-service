import nodemailer from 'nodemailer';
import User from '../../models/User.js';

let transporter = null;
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
  transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }});
}
async function send(user, payload) {
  if (!transporter || !user?.email) return;
  await transporter.sendMail({ from: process.env.EMAIL_USER, to: user.email, subject: payload.title, html: `<p>${payload.body}</p>`});
}
export default { send };

