import {ConfigManager} from "./config/ConfigManager";
import {Commander} from "./commander/Commander";
import {Logger} from "colored-logs";
import {Client} from "discord.js";
import {GuildConfig} from "./config/GuildConfig";
import {EventType} from "./types/EventType";

const configPath: string = process.env.CONFIG_PATH || "./config.json";
const commandsPath: string = process.env.COMMANDS_PATH || "./src/commands";
const isDebug = process.env.NODE_ENV && process.env.NODE_ENV.toLowerCase() === "development";

(async () => {
    const logger = new Logger({
        level: isDebug ? "debug" : "info",
        timezone: "Europe/Warsaw",
        timed_logs: false
    });

    logger.info(`Starting bot...`);
    logger.debug(`Configuration path: ${configPath}`);
    logger.debug(`Commands path: ${commandsPath}`);

    const configManager = new ConfigManager(configPath);
    const commander = new Commander(commandsPath, logger);
    const bot = new Client({partials: ["GUILD_MEMBER"]});

    logger.info("Loading commands...");
    const cmdCount = await commander.load();

    logger.info(`Loaded ${cmdCount} ${cmdCount == 1 ? "command" : "commands"}!`);
    logger.debug("Setting up message handler...");
    bot.on("message", async msg => commander.handle(msg, configManager));

    logger.debug("Setting up voice state update handler...");
    bot.on("voiceStateUpdate", async (oldState, newState) => {
        logger.debug("New voice state update detected printing states...");
        console.log("Old State: ", oldState);
        console.log("New State: ", newState);

        const member = await (newState.member?.partial ? newState.member.fetch() : Promise.resolve(newState.member!));

        if (member.user.bot) return;
        for (let change of ["deaf", "mute", "selfDeaf", "selfMute", "selfVideo", "serverDeaf", "serverMute"]) {
            // @ts-ignore
            if (oldState[change] != undefined && oldState[change] !== newState[change]) {
                return;
            }
        }

        let eventType: EventType;
        if (!oldState.streaming && newState.streaming) {
            eventType = EventType.START_STREAM;
        } else if ((oldState.channelID !== undefined && oldState.channelID !== null) && oldState.streaming && !newState.streaming) {
            eventType = EventType.END_STREAM;
        } else if ((oldState.channelID === undefined || oldState.channelID === null) && (newState.channelID !== undefined && newState.channelID !== null)) {
            eventType = EventType.JOIN_CHANNEL;
        } else if ((newState.channelID === undefined || newState.channelID === null) && (oldState.channelID !== undefined && oldState.channelID !== null)) {
            eventType = EventType.LEAVE_CHANNEL;
        } else {
            eventType = EventType.SWITCH_CHANNEL;
        }

        logger.debug(`Detected event change for user "${member.displayName}" new value is ${Object.keys(EventType)[(Object.keys(EventType).length / 2) + eventType]}`);
        if (eventType === EventType.LEAVE_CHANNEL || eventType === EventType.END_STREAM) return;

        const config = configManager.getGuildConfig(newState.guild.id);
        const notification = config.getNotificationManager().get(newState.channelID!);
        if (!notification) {
            logger.debug(`No notification settings found for channel "${newState.channel?.name}" (${newState.channelID})`);
            return;
        }

        const members = [...new Set([
            ...(await notification.getMembers(newState.guild!)),
            ...(await notification.getMembersFromRoles(newState.guild!))
        ].filter(member =>
            !member.user.bot
        ).filter(async (member) =>
            (await notification.getExcludedMembers(newState.guild!))
                .find(m => member.id === m.id) === undefined
        ).filter(member =>
            !newState.channel?.members.has(member.id)
        ).filter(member =>
            config.isIgnoringDNDs() ||
            member.presence.status !== "dnd"
        ))];

        logger.info(`Notifying ${members.length} member${members.length == 1 ? "" : "s"} about user "${member.displayName}" in ${newState.guild.name}`);

        for (let i = 0; i < members.length; i++) {
            let member = members[i];
            if (member.id == member.id) continue;
            const channel = await member.user.createDM();

            logger.debug(`Sending notification to ${member.displayName} (Status: ${member.presence.status} | Excluded: ${
                (await notification.getExcludedMembers(newState.guild)).findIndex(m => m.id === member.id) > -1
            })`);

            if (eventType === EventType.JOIN_CHANNEL || eventType === EventType.SWITCH_CHANNEL) {
                await channel.send(`**${member.displayName}** joined **${newState.channel?.name}** in **${newState.guild.name}**`);
            } else if (eventType === EventType.START_STREAM) {
                await channel.send(`**${member.displayName}** started streaming in **${newState.guild.name}**`);
            }
        }
    });

    logger.debug("Setting up guild create handler...");
    bot.on("guildCreate", guild => {
        logger.info(`Joined new guild: ${guild.name}`);
        configManager.addGuildConfig(guild.id, GuildConfig.createDefault(configManager));
    });

    logger.debug("Setting up guild delete handler...");
    bot.on("guildDelete", guild => {
        logger.info(`Left guild: ${guild.name}`);
        configManager.removeGuildConfig(guild.id);
    });

    logger.info("Loading configuration...");
    await configManager.load();
    logger.info("Configuration loaded!");
    await bot.login(configManager.getToken());
    logger.info(`Bot is running and connected as ${bot.user?.username}`);

    logger.debug("Creating missing guild configurations...");
    let count = 0;
    bot.guilds.cache.forEach(guild => {
        if (!configManager.getGuildConfig(guild.id)) {
            configManager.addGuildConfig(guild.id, GuildConfig.createDefault(configManager));
            count++;
        }
    });
    await configManager.save();

    if (count > 0) logger.debug(`Added ${count} missing guild configurations!`);
    else logger.debug(`No missing guild configurations found!`);
})();