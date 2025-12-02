// =====================
//  UPTIME ROBOT SERVER
// =====================
import http from 'http';

const PORT = process.env.PORT || 10000;
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('BCSO Clock-In Bot is running\n');
  })
  .listen(PORT, () => {
    console.log(`HTTP server listening on port ${PORT}`);
  });

// =====================
//   MAIN BOT IMPORTS
// =====================
import 'dotenv/config';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionsBitField,
} from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------- CONFIG ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.join(__dirname, 'clockin-data.json');
const LOG_CHANNEL_ID = '1443657155587604626';

// =====================
//  DATA FILE HANDLING
// =====================
function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return { sessions: [] };
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { sessions: [] };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// =====================
//  DATA FUNCTION HELPERS
// =====================
function getActiveSession(data, guildId, userId, dept) {
  return data.sessions.find(
    s => s.guildId === guildId && s.userId === userId && s.departmentId === dept && s.clockOut == null
  );
}

function addSession(data, guildId, userId, dept, clockIn) {
  data.sessions.push({
    id: Date.now() + '_' + Math.random().toString(36).slice(2),
    guildId,
    userId,
    departmentId: dept,
    clockIn,
    clockOut: null,
    duration: null,
    onBreak: false,
    breakStart: null,
    totalBreak: 0,
  });
  saveData(data);
}

function closeSession(data, sessionId, clockOut) {
  const s = data.sessions.find(x => x.id === sessionId);
  if (!s) return null;

  if (s.onBreak && s.breakStart) {
    s.totalBreak += clockOut - s.breakStart;
  }

  s.clockOut = clockOut;
  s.duration = Math.max(clockOut - s.clockIn - s.totalBreak, 0);
  s.onBreak = false;
  s.breakStart = null;

  saveData(data);

  return { duration: s.duration, breakTotal: s.totalBreak };
}

function getUserTotalDuration(data, guildId, userId) {
  return data.sessions
    .filter(s => s.guildId === guildId && s.userId === userId && s.duration != null)
    .reduce((a, b) => a + b.duration, 0);
}

function getDepartmentTotalInRange(data, guildId, dept, startMs, endMs) {
  return data.sessions
    .filter(
      s =>
        s.guildId === guildId &&
        s.departmentId === dept &&
        s.duration != null &&
        s.clockOut >= startMs &&
        s.clockOut < endMs
    )
    .reduce((a, b) => a + b.duration, 0);
}

function getDepartmentTotalsInRange(data, guildId, dept, startMs, endMs) {
  const totals = new Map();

  for (const s of data.sessions) {
    if (
      s.guildId === guildId &&
      s.departmentId === dept &&
      s.duration != null &&
      s.clockOut >= startMs &&
      s.clockOut < endMs
    ) {
      totals.set(s.userId, (totals.get(s.userId) || 0) + s.duration);
    }
  }

  return [...totals.entries()]
    .map(([userId, total]) => ({ userId, total }))
    .sort((a, b) => b.total - a.total);
}

function getUserTotalInRange(data, guildId, userId, startMs, endMs) {
  return data.sessions
    .filter(
      s =>
        s.guildId === guildId &&
        s.userId === userId &&
        s.duration != null &&
        s.clockOut >= startMs &&
        s.clockOut < endMs
    )
    .reduce((a, b) => a + b.duration, 0);
}

// =====================
//  TIME RANGE HELPERS
// =====================
function getCurrentMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

function getCurrentWeekRange() {
  const now = new Date();
  const day = now.getDay();
  const sunday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
  const next = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + 7);
  return { startMs: sunday.getTime(), endMs: next.getTime() };
}

function getWeekRangeForOffset(offset) {
  const { startMs, endMs } = getCurrentWeekRange();
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  return {
    startMs: startMs - offset * weekMs,
    endMs: endMs - offset * weekMs,
  };
}

// =====================
//  UTILITIES
// =====================
function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

function formatHours(ms) {
  return (ms / 3600000).toFixed(2);
}

function discordTimestamp(ms, style = 'f') {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

async function sendLog(interaction, embed) {
  try {
    const channel = await interaction.client.channels.fetch(LOG_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) return;
    channel.send({ embeds: [embed] });
  } catch {}
}

// =====================
//  CLIENT SETUP
// =====================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, c => {
  console.log(`Logged in as ${c.user.tag}`);
});

// =====================
//  COMMAND + BUTTON HANDLING
// =====================
client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'setup-clock-panel') return handleSetupClockPanel(interaction);
      if (interaction.commandName === 'my-hours') return handleMyHours(interaction);
      if (interaction.commandName === 'department-hours') return handleDepartmentHours(interaction);
    }

    if (interaction.isButton()) return handleClockButton(interaction);
  } catch (err) {
    console.log(err);
  }
});

// =====================
//  COMMAND HANDLERS
// =====================

// /setup-clock-panel
async function handleSetupClockPanel(interaction) {
  if (
    !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator) &&
    !interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)
  ) {
    return interaction.reply({
      content: 'You need Administrator or Manage Server.',
      ephemeral: true,
    });
  }

  const dept = interaction.options.getRole('department', true);

  const embed = new EmbedBuilder()
    .setTitle('⏰ Clock In / Clock Out')
    .setDescription(
      `Click the buttons below to clock in, break, or clock out for **${dept.name}**.\n` +
        `Break time is automatically removed from your hours.`
    )
    .setColor(dept.color || 0x2b2d31);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`clockin_${dept.id}`).setLabel('Clock In').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`break_${dept.id}`).setLabel('Break').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`clockout_${dept.id}`).setLabel('Clock Out').setStyle(ButtonStyle.Danger)
  );

  await interaction.reply({ content: 'Clock panel created!', ephemeral: true });
  await interaction.channel.send({ embeds: [embed], components: [row] });
}

// /my-hours
async function handleMyHours(interaction) {
  const data = loadData();
  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  const { startMs: mStart, endMs: mEnd } = getCurrentMonthRange();
  const month = formatHours(getUserTotalInRange(data, guildId, userId, mStart, mEnd));

  let weekly = '';
  for (let i = 0; i < 8; i++) {
    const { startMs, endMs } = getWeekRangeForOffset(i);
    const hrs = formatHours(getUserTotalInRange(data, guildId, userId, startMs, endMs));
    weekly += i === 0 ? `• **Week 0 (current):** ${hrs} hours\n` : `• Week ${i}: ${hrs} hours\n`;
  }

  const all = formatHours(getUserTotalDuration(data, guildId, userId));

  const embed = new EmbedBuilder()
    .setTitle(`⏱ My Hours — ${interaction.user.username}`)
    .setDescription(
      `**📆 Monthly Hours:** ${month} hours\n\n` +
        `**🗓 Weekly Hours:**\n${weekly}\n\n` +
        `**All-Time Total:** ${all} hours`
    )
    .setColor(0x2b2d31);

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// /department-hours
async function handleDepartmentHours(interaction) {
  const data = loadData();
  const dept = interaction.options.getRole('department', true);

  const { startMs: mStart, endMs: mEnd } = getCurrentMonthRange();
  const monthTotal = formatHours(
    getDepartmentTotalInRange(data, interaction.guildId, dept.id, mStart, mEnd)
  );

  const { startMs, endMs } = getCurrentWeekRange();
  const weekRows = getDepartmentTotalsInRange(
    data,
    interaction.guildId,
    dept.id,
    startMs,
    endMs
  );

  let wk = weekRows.length
    ? weekRows.map(r => `<@${r.userId}> — **${formatHours(r.total)} hours**`).join('\n')
    : '_No hours this week._';

  const embed = new EmbedBuilder()
    .setTitle(`📊 Department Hours — ${dept.name}`)
    .setDescription(
      `**📆 Monthly Total:** ${monthTotal} hours\n\n` +
        `**🗓 Weekly Hours:**\n${wk}`
    )
    .setColor(dept.color || 0x2b2d31);

  interaction.reply({ embeds: [embed] });
}

// =====================
//  BUTTON HANDLER
// =====================
async function handleClockButton(interaction) {
  const [action, dept] = interaction.customId.split('_');
  const data = loadData();
  const now = Date.now();
  const user = interaction.user.id;
  const guild = interaction.guildId;

  const role = interaction.guild.roles.cache.get(dept);
  const deptName = role ? role.name : 'Department';

  if (action === 'clockin') {
    if (getActiveSession(data, guild, user, dept))
      return interaction.reply({ ephemeral: true, content: 'Already clocked in!' });

    addSession(data, guild, user, dept, now);

    interaction.reply({ ephemeral: true, content: `Clocked in for **${deptName}**.` });

    return sendLog(
      interaction,
      new EmbedBuilder()
        .setTitle('Clock In')
        .setDescription(`<@${user}> clocked in.\nStart: ${discordTimestamp(now)}`)
        .setColor(0x57f287)
    );
  }

  const active = getActiveSession(data, guild, user, dept);
  if (!active)
    return interaction.reply({ ephemeral: true, content: 'You are not clocked in.' });

  if (action === 'break') {
    if (!active.onBreak) {
      active.onBreak = true;
      active.breakStart = now;
      saveData(data);

      interaction.reply({ ephemeral: true, content: 'You are now **on break**.' });

      return sendLog(
        interaction,
        new EmbedBuilder()
          .setTitle('Break Started')
          .setDescription(`<@${user}> started break at ${discordTimestamp(now)}`)
          .setColor(0x5865f2)
      );
    } else {
      const br = now - active.breakStart;
      active.onBreak = false;
      active.breakStart = null;
      active.totalBreak += br;
      saveData(data);

      interaction.reply({
        ephemeral: true,
        content: `Break ended — **${formatDuration(br)}**`,
      });

      return sendLog(
        interaction,
        new EmbedBuilder()
          .setTitle('Break Ended')
          .setDescription(
            `<@${user}> ended break.\nBreak duration: ${formatDuration(br)}`
          )
          .setColor(0x5865f2)
      );
    }
  }

  if (action === 'clockout') {
    const result = closeSession(data, active.id, now);
    const dur = formatDuration(result.duration);
    const brk = formatDuration(result.breakTotal);
    const total = formatHours(getUserTotalDuration(data, guild, user));

    interaction.reply({
      ephemeral: true,
      content:
        `🕒 Clocked out of **${deptName}**.\n` +
        `Worked: **${dur}**\nBreaks: **${brk}**\nTotal: **${total} hours**`,
    });

    return sendLog(
      interaction,
      new EmbedBuilder()
        .setTitle('Clock Out')
        .setDescription(
          `<@${user}> clocked out.\nDur: **${dur}**\nBreaks: **${brk}**\nTotal: **${total} hours**`
        )
        .setColor(0xed4245)
    );
  }
}

// =====================
//  LOGIN
// =====================
client.login(process.env.DISCORD_TOKEN);
