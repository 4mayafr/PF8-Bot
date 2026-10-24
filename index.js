import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';

const {
  DISCORD_TOKEN,
  CHANNEL_ID,
  AI_API_KEY,
  AI_BASE_URL = 'https://api.groq.com/openai/v1',
  AI_MODEL = 'llama-3.3-70b-versatile',
  AI_FALLBACK_MODEL,
  MENTION_ONLY = 'false',
  COOLDOWN_MS = '1500',
  AI_TIMEOUT_MS = '10000',
} = process.env;

if (!DISCORD_TOKEN || !CHANNEL_ID || !AI_API_KEY) {
  console.error('Missing DISCORD_TOKEN, CHANNEL_ID or AI_API_KEY in .env');
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

Personality (described by the real PF8):
- relaxed and caring
- you follow a "do what you want" mindset: no pressure, no lecturing, no judging
- if someone shares a plan or a choice, you back them up ("you do you")
- if someone seems down or tired, you check in gently and low-key, like a chill friend
- teasing is light and friendly, never mean

Voice rules:
- all lowercase, almost no punctuation, short messages (usually under 12 words)
- casual typos are fine, like "your" instead of "you're"
- 😭 is your go-to reaction. ✌️ now and then. don't overuse emojis
- you tease people lightly by quoting their words back, e.g. "a wonder" with 😭, but always friendly
- the occasional dramatic disbelief is fine: "omfg, your not real"
- you wrap conversations up casually: "anyway night"
- you mention time zones and being tired sometimes ("its 5am for me")
- never write long paragraphs, never sound formal or like an assistant

Example lines in your voice:
"😭 "a wonder""
"anyway night"
"its 5am for me 😭✌️"
"omfg, your not real"
"a promotion is due soon..."
"do what you want honestly ✌️"
"you do you"
"u good?"
"proud of you fr"

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

// Sent when the AI takes too long or fails. Add as many as you like.
const BUSY_REPLIES = [
  'im busy rn',
  'brb 😭',
  'one sec im busy',
  'give me a min 😭',
  'not now im busy ✌️',
  'busy rn talk later',
  'hold on 😭',
  'cant talk rn im busy',
];

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Rejects if the promise takes longer than `ms`.
const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    ),
  ]);

let lastReplyAt = 0;
let working = false;

// Sends lines one by one with a typing indicator so it feels human.
async function sendHuman(channel, lines) {
  for (const line of lines) {
    await channel.sendTyping();
    await sleep(Math.min(300 + line.length * 25, 1200));
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
  const history = await buildHistory(channel);
  if (!history.length) return [];

  // OpenAI takes the persona as a "system" message at the start
  const messages = [{ role: 'system', content: PERSONA }, ...history];

  const models = [AI_MODEL, AI_FALLBACK_MODEL].filter(Boolean);
  const startedAt = Date.now();
  let data;

  // Try each model up to 2 times. Busy errors (503/429) move on to the next try.
  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${AI_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages,
          max_completion_tokens: 300,
        }),
      });

      if (res.ok) {
        data = await res.json();
        break;
      }

      const body = await res.text();
      const overloaded = res.status === 503 || res.status === 429;
      console.warn(`ai ${model} attempt ${attempt} failed (${res.status}): ${body.slice(0, 200)}`);
      if (!overloaded) throw new Error(`AI API ${res.status}: ${body}`);
      await sleep(800);
    }

    if (data) {
      console.log(`ai (${model}) replied in ${Date.now() - startedAt}ms`);
      break;
    }
  }

  if (!data) throw new Error('AI provider is overloaded or rate limited, all attempts failed');

  const text = data.choices?.[0]?.message?.content ?? '';

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
  if (working || Date.now() - lastReplyAt < cooldown) return;
  working = true;

  try {
    const rule = CUSTOM_REPLIES.find((r) => r.match.test(msg.content));
    let lines;

    if (rule) {
      lines = [pick(rule.replies)];
    } else {
      try {
        lines = await withTimeout(aiReply(msg.channel), Number(AI_TIMEOUT_MS));
      } catch (err) {
        console.error('ai reply failed, sending busy line:', err.message);
        lines = [pick(BUSY_REPLIES)];
      }
    }

    if (lines.length) {
      await sendHuman(msg.channel, lines);
      lastReplyAt = Date.now();
    }
  } catch (err) {
    console.error('reply failed:', err.message);
  } finally {
    working = false;
  }
});

client.login(DISCORD_TOKEN);
