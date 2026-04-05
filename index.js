const express = require('express');
const { OpenAI } = require('openai');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ================= INIT =================

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: false
});

console.log("ENV CHECK:", {
  openai: process.env.OPENAI_API_KEY ? "OK" : "MISSING",
  telegram: process.env.TELEGRAM_BOT_TOKEN ? "OK" : "MISSING",
  chat: process.env.CHAT_ID ? "OK" : "MISSING"
});

// ================= GOOGLE SHEETS =================

const SPREADSHEET_ID = '1vO-NQIcg8ATxX3hB01IJBIR_INvDiL1NAi2_oIf7-tI';

async function getSheet() {
  const auth = new google.auth.GoogleAuth({
    keyFile: 'credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  const client = await auth.getClient();

  return google.sheets({ version: 'v4', auth: client });
}

async function getPendingRow() {
  const sheets = await getSheet();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "'Аркуш1'!A2:H"
  });

  const rows = res.data.values;

  if (!rows || rows.length === 0) return null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    if (row[1] === 'pending') {
      return {
        rowIndex: i + 2,
        topic: row[0],
        tone: row[2],
        platform: row[3],
        type: row[4],
        history: row[5] || ''
      };
    }
  }

  return null;
}

async function updateRow(rowIndex, posts) {
  const sheets = await getSheet();

  const preview = posts.substring(0, 120);

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `'Аркуш1'!B${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['done']] }
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `'Аркуш1'!F${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[preview]] }
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `'Аркуш1'!G${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[new Date().toISOString()]] }
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `'Аркуш1'!H${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[posts]] }
  });
}

// ================= OPENAI =================

async function generatePosts(data) {
  const prompt = `
Generate EXACTLY 3 posts.

Topic: ${data.topic}
Platform: ${data.platform}
Tone: ${data.tone}
Type: ${data.type}

FORMAT:

POST 1:
Hook:
Content:
CTA:
Hashtags:

POST 2:
...

POST 3:
...
`;

  const res = await openai.responses.create({
    model: "gpt-4.1",
    input: prompt
  });

  return res.output[0].content[0].text;
}

// ================= IMAGE =================

async function generateImage(data) {
  const res = await openai.images.generate({
    model: "gpt-image-1",
    prompt: `${data.topic} modern social media illustration`,
    size: "1024x1024"
  });

  const base64 = res.data[0].b64_json;
  const buffer = Buffer.from(base64, 'base64');

  const filename = `image-${Date.now()}.png`;
  const filepath = `public/${filename}`;

  fs.writeFileSync(filepath, buffer);

  return {
    webPath: `/${filename}`,
    localPath: filepath
  };
}

// ================= HELPERS =================

async function sendToTelegram(posts, image) {
  try {
    if (image) {
      await bot.sendPhoto(
        process.env.CHAT_ID,
        fs.createReadStream(image.localPath),
        { caption: "🔥 AI Content Pack" }
      );
    }

    await bot.sendMessage(process.env.CHAT_ID, posts);
  } catch (e) {
    console.error("TELEGRAM ERROR:", e.message);
  }
}

// ================= RUN =================

app.get('/run', async (req, res) => {
  try {
    const row = await getPendingRow();
    if (!row) return res.send("No pending rows");

    const data = {
      topic: row.topic,
      platform: row.platform,
      tone: row.tone,
      type: row.type,
      audience: "general audience",
      history: row.history
    };

    const posts = await generatePosts(data);
    const image = await generateImage(data);

    await sendToTelegram(posts, image);
    await updateRow(row.rowIndex, posts);

    res.send("Done");

  } catch (err) {
    console.error("RUN ERROR:", err);
    res.send("Error");
  }
});

// ================= GENERATE (UI) =================

app.post('/generate', async (req, res) => {
  try {
    const data = {
      topic: req.body.topic,
      platform: req.body.platform,
      tone: req.body.tone,
      type: req.body.type,
      audience: "general audience",
      history: "none"
    };

    const posts = await generatePosts(data);
    const image = await generateImage(data);

    await sendToTelegram(posts, image);

    res.json({
      result: posts,
      image: image.webPath
    });

  } catch (err) {
    console.error("GENERATE ERROR:", err);
    res.status(500).send('Error');
  }
});

app.listen(3000, () => {
  console.log('Server running on port 3000');
});