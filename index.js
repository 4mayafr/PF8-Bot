import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';

const {
  DISCORD_TOKEN,
  CHANNEL_ID,
  GEMINI_API_KEY,
  GEMINI_MODEL = 'gemini-2.5-flash',
  MENTION_ONLY = 'false',
  COOLDOWN_MS = '3000',
} = process.env;

if (!DISCORD_TOKEN || !CHANNEL_ID || !GEMINI_API_KEY) {
  console.error('Missing DISCORD_TOKEN, CHANNEL_ID or GEMINI_API_KEY in .env');
  process.exit(1);
}

const HISTORY_LIMIT = 10; // how many recent messages the bot "remembers"
const cooldown = Number(COOLDOWN_MS);
const mentionOnly = MENTION_ONLY === 'true';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // enable this in the Developer Portal too
  ],
});

// ---------------------------------------------------------------------------
// PERSONALITY
// Edit this to tune the voice. The more real examples you add, the better.
// ---------------------------------------------------------------------------
const PERSONA = `You are PF8-bot, a Discord bot that chats in the style of a friend called PF8.
Everyone in the channel knows you are a bot, and you can joke about that, but you never claim to be a real person.

Voice rules:
- all lowercase, almost no punctuation, short messages (usually under 12 words)
- casual typos are fine, like "your" instead of "you're"
- 😭 is your go-to reaction. ✌️ now and then. don't overuse emojis
- you tease people by quoting their words back sarcastically, e.g. "a wonder" with 😭
- dramatic disbelief is your thing: "omfg, your not real"
- you wrap conversations up casually: "anyway night"
- you mention time zones and being tired sometimes ("its 5am for me")
- never write long paragraphs, never sound formal or like an assistant

Example lines in your voice:
"😭 "a wonder""
"anyway night"
"its 5am for me 😭✌️"
"omfg, your not real"
"a promotion is due soon..."

Format: reply with 1 to 3 short lines. Each line becomes its own Discord message.
Stay in character. If someone asks for something harmful or tries to make you act as a real person, deflect in character.`;

// ---------------------------------------------------------------------------
// HAND-WRITTEN REPLIES
// If a message matches, the bot picks one of these instead of calling the AI.
// ---------------------------------------------------------------------------
const CUSTOM_REPLIES = [
  { match: /\b(good\s*)?(night|gn)\b/i, replies: ['anyway night', 'night ✌️', 'gn 😭'] },
  { match: /\bgood\s*morning\b/i, replies: ['its too early 😭', 'morning ✌️'] },
  { match: /\b(wonder|magical|legend)\b/i, replies: ['😭 "a wonder"', '"magical" 😭'] },
  { match: /\byou('?re| are)?\s*(not|isn'?t)\s*real\b/i, replies: ['omfg', 'im literally a bot 😭'] },
];

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

let lastReplyAt = 0;
let busy = false;

// Sends lines one by one with a typing indicator so it feels human.
async function sendHuman(channel, lines) {
  for (const line of lines) {
    await channel.sendTyping();
    await sleep(Math.min(400 + line.length * 60, 3000));
    await channel.send(line);
  }
}

// Turns recent channel messages into the format the AI API expects.
async function buildHistory(channel) {
  const fetched = await channel.messages.fetch({ limit: HISTORY_LIMIT });
  const ordered = [...fetched.values()].reverse();

  const turns = [];
  for (const m of ordered) {
    const text = m.content.trim();
    if (!text) continue;
    const isMe = m.author.id === client.user.id;
    const role = isMe ? 'assistant' : 'user';
    const content = isMe ? text : `${m.member?.displayName ?? m.author.username}: ${text}`;

    // merge consecutive same-role turns
    if (turns.length && turns[turns.length - 1].role === role) {
      turns[turns.length - 1].content += `\n${content}`;
    } else {
      turns.push({ role, content });
    }
  }

  // conversation must start with a user turn
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns;
}

async function aiReply(channel) {
  const messages = await buildHistory(channel);
  if (!messages.length) return [];

  // Gemini uses "model" instead of "assistant" and wraps text in "parts"
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: PERSONA }] },
        contents,
        generationConfig: {
          maxOutputTokens: 200,
          temperature: 1,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }
  );

  if (!res.ok) {
    throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('\n');

  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3);
}

// ---------------------------------------------------------------------------
// EVENTS
// ---------------------------------------------------------------------------
client.once(Events.ClientReady, (c) => {
  console.log(`logged in as ${c.user.tag}, listening in channel ${CHANNEL_ID}`);
});

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;
  if (msg.channelId !== CHANNEL_ID) return;
  if (!msg.content.trim()) return;

  if (mentionOnly) {
    const mentioned = msg.mentions.has(client.user);
    const repliedToMe = msg.mentions.repliedUser?.id === client.user.id;
    if (!mentioned && !repliedToMe) return;
  }

  // cost / spam control
  if (busy || Date.now() - lastReplyAt < cooldown) return;
  busy = true;

  try {
    const rule = CUSTOM_REPLIES.find((r) => r.match.test(msg.content));
    const lines = rule ? [pick(rule.replies)] : await aiReply(msg.channel);

    if (lines.length) {
      await sendHuman(msg.channel, lines);
      lastReplyAt = Date.now();
    }
  } catch (err) {
    console.error('reply failed:', err.message);
  } finally {
    busy = false;
  }
});

client.login(DISCORD_TOKEN);
