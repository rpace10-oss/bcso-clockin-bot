import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('setup-clock-panel')
    .setDescription('Post a clock in/out panel for a department in this channel.')
    .addRoleOption(opt =>
      opt
        .setName('department')
        .setDescription('Role representing this department')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(0) // We’ll permission-gate in code
    .toJSON(),

  new SlashCommandBuilder()
    .setName('my-hours')
    .setDescription('Show your total recorded hours.')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('department-hours')
    .setDescription('Show hours for everyone in a department.')
    .addRoleOption(opt =>
      opt
        .setName('department')
        .setDescription('Role representing this department')
        .setRequired(true)
    )
    .toJSON()
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function main() {
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('Slash commands registered.');
  } catch (error) {
    console.error(error);
  }
}

main();
