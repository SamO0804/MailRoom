// server.js
//
// Same idea as the Resend version, but uses a plain Gmail account:
//   OUTBOUND: Nodemailer over Gmail SMTP
//   INBOUND:  ImapFlow polling the Gmail inbox on an interval
// No domain, no DNS, no public webhook URL needed — everything
// runs from your laptop for a demo.

import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "letters.json");

const GMAIL_ADDRESS = process.env.GMAIL_ADDRESS;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

if (!GMAIL_ADDRESS || !GMAIL_APP_PASSWORD) {
  console.error("Missing GMAIL_ADDRESS or GMAIL_APP_PASSWORD in .env");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

// ---------- tiny JSON "database" ----------

function loadDB() {
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, "[]");
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}
function saveDB(letters) {
  fs.writeFileSync(DB_PATH, JSON.stringify(letters, null, 2));
}

// ---------- friction layer (same idea as before) ----------

const RECIPIENT_PROFILES = {
  local:    { label: "next street over", delayMs: 4000,  lossChance: 0.03 },
  city:     { label: "across town",      delayMs: 9000,  lossChance: 0.10 },
  region:   { label: "the next county",  delayMs: 14000, lossChance: 0.18 },
  overseas: { label: "overseas",         delayMs: 22000, lossChance: 0.32 },
};
function profileFor(_toAddress) {
  return RECIPIENT_PROFILES.city; // adjust heuristic as you like
}

// ---------- outbound: Nodemailer over Gmail SMTP ----------

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: GMAIL_ADDRESS, pass: GMAIL_APP_PASSWORD },
});

app.post("/api/letters", async (req, res) => {
  const { to, subject, body } = req.body;
  if (!to || !body) {
    return res.status(400).json({ error: "to and body are required" });
  }

  const profile = profileFor(to);
  const letters = loadDB();
  const letter = {
    id: nanoid(10),
    direction: "out",
    from: GMAIL_ADDRESS,
    to,
    subject: subject || "(no subject)",
    body,
    status: "pending",
    createdAt: Date.now(),
  };
  letters.push(letter);
  saveDB(letters);

  res.json({ id: letter.id, status: "pending" });

  setTimeout(async () => {
    const all = loadDB();
    const l = all.find((x) => x.id === letter.id);
    if (!l) return;

    const lost = Math.random() < profile.lossChance;
    if (lost) {
      l.status = "lost";
      saveDB(all);
      return;
    }

    try {
      await transporter.sendMail({
        from: GMAIL_ADDRESS,
        to: l.to,
        subject: l.subject,
        text: l.body,
      });
      l.status = "delivered";
    } catch (err) {
      console.error("send failed:", err.message);
      l.status = "lost";
    }
    saveDB(all);
  }, profile.delayMs);
});

app.get("/api/letters/:id/status", (req, res) => {
  const letters = loadDB();
  const letter = letters.find((l) => l.id === req.params.id);
  if (!letter) return res.status(404).json({ error: "not found" });
  res.json({ id: letter.id, status: letter.status });
});

app.get("/api/letters/incoming", (req, res) => {
  const since = Number(req.query.since || 0);
  const letters = loadDB();
  const incoming = letters
    .filter((l) => l.direction === "in" && l.createdAt > since)
    .sort((a, b) => a.createdAt - b.createdAt);
  res.json(incoming);
});

app.post("/api/letters/:id/read", (req, res) => {
  const letters = loadDB();
  const letter = letters.find((l) => l.id === req.params.id);
  if (!letter) return res.status(404).json({ error: "not found" });
  letter.status = "read";
  saveDB(letters);
  res.json({ ok: true });
});

app.delete("/api/letters/:id", (req, res) => {
  const letters = loadDB();
  const next = letters.filter((l) => l.id !== req.params.id);
  saveDB(next);
  res.json({ ok: true });
});

// ---------- inbound: poll Gmail over IMAP ----------

let seenUids = new Set();

async function pollInbox({ seedOnly = false } = {}) {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: GMAIL_ADDRESS, pass: GMAIL_APP_PASSWORD },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      // fetch the most recent 25 messages; adjust range if you expect more
      const messages = client.fetch(
        { seq: "1:*" },
        { envelope: true, source: true, uid: true }
      );

      const letters = loadDB();
      let added = false;

      for await (const msg of messages) {
        if (seenUids.has(msg.uid)) continue;
        seenUids.add(msg.uid);

        if (seedOnly) continue; // first run: just remember what's already there

        const parsed = await simpleParser(msg.source);
        const alreadyStored = letters.some((l) => l.imapUid === msg.uid);
        if (alreadyStored) continue;

        letters.push({
          id: nanoid(10),
          direction: "in",
          from: parsed.from?.text || "unknown",
          to: GMAIL_ADDRESS,
          subject: parsed.subject || "(no subject)",
          body: parsed.text || "(empty letter)",
          status: "unread",
          createdAt: msg.envelope.date
            ? new Date(msg.envelope.date).getTime()
            : Date.now(),
          imapUid: msg.uid,
        });
        added = true;
      }

      if (added) saveDB(letters);
    } finally {
      lock.release();
    }
  } catch (err) {
    console.error("IMAP poll failed:", err.message);
  } finally {
    await client.logout().catch(() => {});
  }
}

// poll every 15s — Gmail is fine with this frequency for a demo.
// Lower it if you want faster-feeling "incoming mail", but don't
// hammer it much below 10s.
setInterval(pollInbox, 15000);
pollInbox({ seedOnly: true }); // seed seenUids from existing mail without treating it as "new"

// ---------- health check ----------
app.get("/", (_req, res) => res.send("the table — IMAP/SMTP mail server is up"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`the table server (gmail) listening on :${PORT}`);
});
