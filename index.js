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

// Channel to log all clock in/out/break activity
const LOG_CHANNEL_ID = '1443657155587604626';

// ---------- DATA FILE HELPERS ----------
function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return { sessions: [] };
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error loading data file:', err);
    return { sessions: [] };
  }
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving data file:', err);
  }
}

// ---------- DATA HELPERS ----------
function getActiveSession(data, guildId, userId, departmentId) {
  return data.sessions.find(
    s =>
      s.guildId === guildId &&
      s.userId === userId &&
      s.departmentId === departmentId &&
      s.clockOut == null
  );
}

function addSession(data, guildId, userId, departmentId, clockIn) {
  data.sessions.push({
    id: Date.now() + '_' + Math.random().toString(36).slice(2),
    guildId,
    userId,
    departmentId,
    clockIn,
    clockOut: null,
    duration: null,
    // break tracking
    onBreak: false,
    breakStart: null,
    totalBreak: 0,
  });
  saveData(data);
}

// close session and account for breaks
function closeSession(data, sessionId, clockOut) {
  const s = data.sessions.find(sess => sess.id === sessionId);
  if (!s) return null;

  // defaults for older sessions that may not have break fields
  if (typeof s.onBreak !== 'boolean') s.onBreak = false;
  if (typeof s.totalBreak !== 'number') s.totalBreak = 0;

  let totalBreak = s.totalBreak || 0;

  // if they are still on break when clocking out, end that break at clockOut
  if (s.onBreak && s.breakStart) {
    totalBreak += clockOut - s.breakStart;
  }

  const rawDuration = clockOut - s.clockIn;
  const workedDuration = Math.max(rawDuration - totalBreak, 0);

  s.clockOut = clockOut;
  s.duration = workedDuration;
  s.onBreak = false;
  s.breakStart = null;
  s.totalBreak = totalBreak;

  saveData(data);

  return {
    duration: workedDuration,
    breakTotal: totalBreak,
  };
}

function getUserTotalDuration(data, guildId, userId) {
  return data.sessions
    .filter(s => s.guildId === guildId && s.userId === userId && s.duration != null)
    .reduce((sum, s) => sum + s.duration, 0);
}

// per-user totals in a specific time range (for weekly department leaderboard)
function getDepartmentTotalsInRange(data, guildId, departmentId, startMs, endMs) {
  const totals = new Map();

  for (const s of data.sessions) {
    if (s.guildId !== guildId) continue;
    if (s.departmentId !== departmentId) continue;
    if (s.duration == null) continue;
    if (s.clockOut == null) continue;

    const end = s.clockOut;
    if (end < startMs || end >= endMs) continue;

    const prev = totals.get(s.userId) || 0;
    totals.set(s.userId, prev + s.duration);
  }

  return [...totals.entries()]
    .map(([userId, total]) => ({ userId, total }))
    .sort((a, b) => b.total - a.total);
}

// combined department total in a specific time range (for monthly dept total)
function getDepartmentTotalInRange(data, guildId, departmentId, startMs, endMs) {
  let total = 0;

  for (const s of data.sessions) {
    if (s.guildId !== guildId) continue;
    if (s.departmentId !== departmentId) continue;
    if (s.duration == null) continue;
    if (s.clockOut == null) continue;

    const end = s.clockOut;
    if (end < startMs || end >= endMs) continue;

    total += s.duration;
  }

  return total;
}

// per-user total in a specific time range (for /my-hours weekly breakdown)
function getUserTotalInRange(data, guildId, userId, startMs, endMs) {
  let total = 0;

  for (const s of data.sessions) {
    if (s.guildId !== guildId) continue;
    if (s.userId !== userId) continue;
    if (s.duration == null) continue;
    if (s.clockOut == null) continue;

    const end = s.clockOut;
    if (end < startMs || end >= endMs) continue;

    total += s.duration;
  }

  return total;
}

// ---------- RANGE HELPERS ----------

// current calendar month range
function getCurrentMonthRange() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-11

  const start = new Date(year, month, 1, 0, 0, 0, 0);
  const end = new Date(year, month + 1, 1, 0, 0, 0, 0);

  return { startMs: start.getTime(), endMs: end.getTime() };
}

// current week range: Sunday 00:00 -> next Sunday 00:00
// (effectively "resets" late Saturday night)
function getCurrentWeekRange() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const date = now.getDate();
  const day = now.getDay(); // 0 = Sunday, 6 = Saturday

  const sunday = new Date(year, month, date - day, 0, 0, 0, 0);
  const nextSunday = new Date(
    sunday.getFullYear(),
    sunday.getMonth(),
    sunday.getDate() + 7,
    0,
    0,
    0,
    0
  );

  return { startMs: sunday.getTime(), endMs: nextSunday.getTime() };
}

// week range for a given offset: 0 = current week, 1 = previous, etc.
function getWeekRangeForOffset(offset) {
  const { startMs, endMs } = getCurrentWeekRange();
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const offsetStart = startMs - offset * weekMs;
  const offsetEnd = endMs - offset * weekMs;
  return { startMs: offsetStart, endMs: offsetEnd };
}

// ---------- UTIL FUNCTIONS ----------
function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || !parts.length) parts.push(`${seconds}s`);
  return parts.join(' ');
}

function formatHours(ms) {
  return (ms / 3600000).toFixed(2);
}

// convert ms timestamp -> Discord timestamp string
function discordTimestamp(ms, style = 'f') {
  const seconds = Math.floor(ms / 1000);
  return `<t:${seconds}:${style}>`;
}

// send log message to the configured channel, if possible
async function sendLog(interaction, embed) {
  try {
    const channel = await interaction.client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('Failed to send log message:', err);
  }
}

// ---------- CLIENT ----------
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, c => {
  console.log(`✅ Logged in as ${c.user.tag}`);
});

// ---------- INTERACTIONS ----------
client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'setup-clock-panel') {
        await handleSetupClockPanel(interaction);
      } else if (interaction.commandName === 'my-hours') {
        await handleMyHours(interaction);
      } else if (interaction.commandName === 'department-hours') {
        await handleDepartmentHours(interaction);
      }
    } else if (interaction.isButton()) {
      await handleClockButton(interaction);
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (interaction.deferred || interaction.replied) {
      await interaction
        .followUp({ content: 'There was an error handling that.', ephemeral: true })
        .catch(() => {});
    } else {
      await interaction
        .reply({ content: 'There was an error handling that.', ephemeral: true })
        .catch(() => {});
    }
  }
});

// ---------- HANDLERS ----------

// /setup-clock-panel department:@Role
async function handleSetupClockPanel(interaction) {
  const member = interaction.member;

  if (
    !member.permissions.has(PermissionsBitField.Flags.Administrator) &&
    !member.permissions.has(PermissionsBitField.Flags.ManageGuild)
  ) {
    return interaction.reply({
      content: 'You need **Administrator** or **Manage Server** to use this command.',
      ephemeral: true,
    });
  }

  const departmentRole = interaction.options.getRole('department', true);

  const embed = new EmbedBuilder()
    .setTitle('⏰ Clock In / Clock Out')
    .setDescription(
      `Use the buttons below to clock in and clock out for **${departmentRole.name}**.\n\n` +
        `• **Clock In** when you start your shift.\n` +
        `• **Break** to pause your time.\n` +
        `• **Clock Out** when you finish.\n\n` +
        `Break time is automatically subtracted from your hours.`
    )
    .setColor(departmentRole.color || 0x2b2d31);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`clockin_${departmentRole.id}`)
      .setLabel('Clock In')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`break_${departmentRole.id}`)
      .setLabel('Break')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`clockout_${departmentRole.id}`)
      .setLabel('Clock Out')
      .setStyle(ButtonStyle.Danger)
  );

  await interaction.reply({ content: 'Clock panel created:', ephemeral: true });
  await interaction.channel.send({ embeds: [embed], components: [row] });
}

// /my-hours
async function handleMyHours(interaction) {
  const data = loadData();
  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  // Monthly total for this user (current month, all departments)
  const { startMs: monthStart, endMs: monthEnd } = getCurrentMonthRange();
  const monthTotalMs = getUserTotalInRange(data, guildId, userId, monthStart, monthEnd);
  const monthPretty = formatHours(monthTotalMs);

  // Weekly breakdown: week 0 (current) back to week 7
  const weeks = [];
  for (let offset = 0; offset < 8; offset++) {
    const { startMs, endMs } = getWeekRangeForOffset(offset);
    const weekTotalMs = getUserTotalInRange(data, guildId, userId, startMs, endMs);
    weeks.push({
      offset,
      hours: formatHours(weekTotalMs),
    });
  }

  // All-time total as extra info
  const allTimeTotalMs = getUserTotalDuration(data, guildId, userId);
  const allTimePretty = formatHours(allTimeTotalMs);

  if (monthTotalMs === 0 && allTimeTotalMs === 0) {
    return interaction.reply({
      ephemeral: true,
      content: `You don't have any recorded hours yet in this server.`,
    });
  }

  let description = '';

  description += `**📆 Monthly Hours (current month)**\n`;
  description += `You have **${monthPretty} hours** this month.\n\n`;

  description += `**🗓 Weekly Hours (last 8 weeks)**\n`;
  for (const w of weeks) {
    if (w.offset === 0) {
      description += `• **Week 0 (current week):** ${w.hours} hours\n`;
    } else {
      description += `• Week ${w.offset}: ${w.hours} hours\n`;
    }
  }

  description += `\n**All-time total (this server):** ${allTimePretty} hours`;

  const embed = new EmbedBuilder()
    .setTitle(`⏱ My Hours — ${interaction.user.username}`)
    .setDescription(description)
    .setColor(0x2b2d31);

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// /department-hours department:@Role
async function handleDepartmentHours(interaction) {
  const departmentRole = interaction.options.getRole('department', true);
  const data = loadData();

  const { startMs: monthStart, endMs: monthEnd } = getCurrentMonthRange();
  const { startMs: weekStart, endMs: weekEnd } = getCurrentWeekRange();

  // Combined department hours for the current month
  const monthTotalMs = getDepartmentTotalInRange(
    data,
    interaction.guildId,
    departmentRole.id,
    monthStart,
    monthEnd
  );

  // Per-user hours for the current week
  const weekRows = getDepartmentTotalsInRange(
    data,
    interaction.guildId,
    departmentRole.id,
    weekStart,
    weekEnd
  );

  if (monthTotalMs === 0 && !weekRows.length) {
    return interaction.reply({
      ephemeral: true,
      content: `No recorded hours for **${departmentRole.name}** yet.`,
    });
  }

  const monthHoursPretty = formatHours(monthTotalMs);
  let description = '';

  // Monthly section: combined total
  description += `**📆 Monthly Department Hours (current month)**\n`;
  description += `Total for **${departmentRole.name}**: **${monthHoursPretty} hours**\n`;

  // Weekly section: individual users
  description += `\n**🗓 Weekly Hours (per member)** *(resets Saturday 11:59 PM EST)*\n`;
  if (weekRows.length) {
    for (const row of weekRows) {
      const uId = row.userId;
      const hours = formatHours(row.total);
      description += `<@${uId}> — **${hours} hours**\n`;
    }
  } else {
    description += `_No hours recorded this week._\n`;
  }

  const embed = new EmbedBuilder()
    .setTitle(`📊 Department Hours — ${departmentRole.name}`)
    .setDescription(description)
    .setColor(departmentRole.color || 0x2b2d31);

  await interaction.reply({ embeds: [embed], ephemeral: false });
}

// Button handler (Clock In / Break / Clock Out)
async function handleClockButton(interaction) {
  const customId = interaction.customId;
  if (
    !customId.startsWith('clockin_') &&
    !customId.startsWith('clockout_') &&
    !customId.startsWith('break_')
  ) {
    return;
  }

  const [action, departmentId] = customId.split('_');
  const now = Date.now();
  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  const data = loadData();
  const role = interaction.guild.roles.cache.get(departmentId);
  const deptName = role ? role.name : 'Department';

  // ---------- CLOCK IN ----------
  if (action === 'clockin') {
    const active = getActiveSession(data, guildId, userId, departmentId);
    if (active) {
      return interaction.reply({
        ephemeral: true,
        content: 'You are already clocked in for this department. Please clock out first.',
      });
    }

    addSession(data, guildId, userId, departmentId, now);

    await interaction.reply({
      ephemeral: true,
      content: `✅ You have **clocked in** for **${deptName}**.`,
    });

    const logEmbed = new EmbedBuilder()
      .setTitle('✅ Clock In')
      .setDescription(
        `<@${userId}> clocked in for **${deptName}**.\n\n` +
          `**Start Time:** ${discordTimestamp(now, 'f')} (local date/time)`
      )
      .setFooter({ text: `User ID: ${userId}` })
      .setTimestamp()
      .setColor(0x57f287);
    await sendLog(interaction, logEmbed);
    return;
  }

  // from here on, need an active session
  const active = getActiveSession(data, guildId, userId, departmentId);
  if (!active) {
    return interaction.reply({
      ephemeral: true,
      content: 'You are not currently clocked in for this department.',
    });
  }

  // make sure break fields exist for older sessions
  if (typeof active.onBreak !== 'boolean') active.onBreak = false;
  if (typeof active.totalBreak !== 'number') active.totalBreak = 0;

  // ---------- BREAK TOGGLE ----------
  if (action === 'break') {
    if (!active.onBreak) {
      // start break
      active.onBreak = true;
      active.breakStart = now;
      saveData(data);

      await interaction.reply({
        ephemeral: true,
        content: `☕ You are now **on break** for **${deptName}**. Your timer is paused.`,
      });

      const logEmbed = new EmbedBuilder()
        .setTitle('☕ Break Started')
        .setDescription(
          `<@${userId}> started a break while clocked in for **${deptName}**.\n\n` +
            `**Break Start:** ${discordTimestamp(now, 'f')}`
        )
        .setFooter({ text: `User ID: ${userId}` })
        .setTimestamp()
        .setColor(0x5865f2);
      await sendLog(interaction, logEmbed);
    } else {
      // end break
      const breakStart = active.breakStart || now;
      const breakDuration = now - breakStart;
      active.onBreak = false;
      active.breakStart = null;
      active.totalBreak = (active.totalBreak || 0) + breakDuration;
      saveData(data);

      const breakPretty = formatDuration(breakDuration);

      await interaction.reply({
        ephemeral: true,
        content:
          `▶️ You have **ended your break** for **${deptName}**.\n` +
          `Break duration: **${breakPretty}**. Your timer has resumed.`,
      });

      const logEmbed = new EmbedBuilder()
        .setTitle('▶️ Break Ended')
        .setDescription(
          `<@${userId}> ended their break for **${deptName}**.\n\n` +
            `**Break Duration:** ${breakPretty}\n` +
            `**Break End:** ${discordTimestamp(now, 'f')}`
        )
        .setFooter({ text: `User ID: ${userId}` })
        .setTimestamp()
        .setColor(0x5865f2);
      await sendLog(interaction, logEmbed);
    }
    return;
  }

  // ---------- CLOCK OUT ----------
  if (action === 'clockout') {
    const startMs = active.clockIn;
    const endMs = now;

    const result = closeSession(data, active.id, endMs);
    if (!result) {
      return interaction.reply({
        ephemeral: true,
        content: 'There was an error ending your session.',
      });
    }

    const duration = result.duration;
    const breakTotal = result.breakTotal || 0;
    const total = getUserTotalDuration(data, guildId, userId);

    const sessionPretty = formatDuration(duration);
    const totalPretty = formatHours(total);
    const breakPretty = breakTotal ? formatDuration(breakTotal) : '0s';

    await interaction.reply({
      ephemeral: true,
      content:
        `🕒 You have **clocked out** of **${deptName}**.\n` +
        `• This session (worked): **${sessionPretty}**\n` +
        `• Break time this session: **${breakPretty}**\n` +
        `• Total recorded time (all departments): **${totalPretty} hours**`,
    });

    const logEmbed = new EmbedBuilder()
      .setTitle('🕒 Clock Out')
      .setDescription(
        `<@${userId}> clocked out of **${deptName}**.\n\n` +
          `**Start:** ${discordTimestamp(startMs, 'f')}\n` +
          `**End:** ${discordTimestamp(endMs, 'f')}\n` +
          `**Session Worked Duration:** ${sessionPretty}\n` +
          `**Break Time This Session:** ${breakPretty}\n` +
          `**Total Time (all departments):** ${totalPretty} hours`
      )
      .setFooter({ text: `User ID: ${userId}` })
      .setTimestamp()
      .setColor(0xed4245);
    await sendLog(interaction, logEmbed);
    return;
  }
}

// ---------- LOGIN ----------
client.login(process.env.DISCORD_TOKEN);
