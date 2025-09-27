const { 
    Client, 
    GatewayIntentBits, 
    SlashCommandBuilder, 
    EmbedBuilder, 
    AttachmentBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    PermissionFlagsBits
} = require('discord.js');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const { Pool } = require('pg');
const sharp = require('sharp');
const http = require('http');
require('dotenv').config();

// PostgreSQL Connection Pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// Bot Setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.MessageReactions
    ]
});

// Configuration
const config = {
    tradingRoles: process.env.TRADING_ROLES ? process.env.TRADING_ROLES.split(',') : [
        'Trader', 'Verified Trader', 'Trusted Trader', 'Dealer', 'Händler'
    ],
    tradingCategoryId: process.env.TRADING_CATEGORY_ID || null,
    maxTradeChannels: parseInt(process.env.MAX_TRADE_CHANNELS) || 20,
    tradeChannelTimeout: parseInt(process.env.TRADE_CHANNEL_TIMEOUT) || 3600000, // 1 hour
    maxFileSize: (process.env.MAX_FILE_SIZE || 10) * 1024 * 1024,
    allowedFormats: (process.env.ALLOWED_FORMATS || 'jpg,jpeg,png,gif,webp').split(',')
};

// Chart Configuration
const width = 800;
const height = 400;
const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height });

// Active Trade Channels Storage
const activeTradeChannels = new Map();

// Database Helper Functions
const db = {
    async query(text, params) {
        const client = await pool.connect();
        try {
            const result = await client.query(text, params);
            return result;
        } finally {
            client.release();
        }
    },

    async queryRow(text, params) {
        const result = await this.query(text, params);
        return result.rows[0] || null;
    },

    async queryRows(text, params) {
        const result = await this.query(text, params);
        return result.rows;
    },

    async transaction(callback) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await callback(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    },

    async testConnection() {
        try {
            const result = await this.query('SELECT NOW() as current_time');
            console.log('✅ PostgreSQL Verbindung erfolgreich:', result.rows[0].current_time);
            return true;
        } catch (error) {
            console.error('❌ PostgreSQL Verbindungsfehler:', error.message);
            return false;
        }
    }
};

// Database Initialization
async function initializeDatabase() {
    try {
        console.log('🔄 Initialisiere PostgreSQL Datenbank...');

        // Current prices table
        await db.query(`
            CREATE TABLE IF NOT EXISTS current_prices (
                id SERIAL PRIMARY KEY,
                item_name VARCHAR(255) UNIQUE NOT NULL,
                display_name VARCHAR(255) NOT NULL,
                market_price DECIMAL(12,2) NOT NULL,
                state_value DECIMAL(12,2),
                image_data BYTEA,
                image_filename VARCHAR(255),
                image_content_type VARCHAR(100),
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_by VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Price history table
        await db.query(`
            CREATE TABLE IF NOT EXISTS price_history (
                id SERIAL PRIMARY KEY,
                item_name VARCHAR(255) NOT NULL,
                display_name VARCHAR(255) NOT NULL,
                market_price DECIMAL(12,2) NOT NULL,
                state_value DECIMAL(12,2),
                image_data BYTEA,
                image_filename VARCHAR(255),
                image_content_type VARCHAR(100),
                date_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                added_by VARCHAR(255) NOT NULL
            )
        `);

        // Trade offers table
        await db.query(`
            CREATE TABLE IF NOT EXISTS trade_offers (
                offer_id SERIAL PRIMARY KEY,
                creator_id VARCHAR(255) NOT NULL,
                creator_name VARCHAR(255) NOT NULL,
                guild_id VARCHAR(255) NOT NULL,
                channel_id VARCHAR(255),
                message_id VARCHAR(255),
                item_name VARCHAR(255) NOT NULL,
                item_description TEXT,
                quantity INTEGER DEFAULT 1,
                price_amount DECIMAL(12,2) NOT NULL,
                price_currency VARCHAR(10) DEFAULT 'EUR',
                offer_type VARCHAR(10) CHECK (offer_type IN ('buy', 'sell')) NOT NULL,
                status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled', 'expired')),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                interested_users JSONB DEFAULT '[]'::jsonb
            )
        `);

        // Trade sessions table
        await db.query(`
            CREATE TABLE IF NOT EXISTS trade_sessions (
                session_id SERIAL PRIMARY KEY,
                offer_id INTEGER REFERENCES trade_offers(offer_id),
                buyer_id VARCHAR(255) NOT NULL,
                seller_id VARCHAR(255) NOT NULL,
                buyer_name VARCHAR(255) NOT NULL,
                seller_name VARCHAR(255) NOT NULL,
                guild_id VARCHAR(255) NOT NULL,
                channel_id VARCHAR(255),
                status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'completed', 'cancelled')),
                agreed_price DECIMAL(12,2) NOT NULL,
                agreed_currency VARCHAR(10) DEFAULT 'EUR',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                accepted_at TIMESTAMP,
                completed_at TIMESTAMP,
                trade_data JSONB DEFAULT '{}'::jsonb
            )
        `);

        // Create indexes for better performance
        await db.query(`CREATE INDEX IF NOT EXISTS idx_current_prices_item_name ON current_prices(item_name)`);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_current_prices_display_name ON current_prices(display_name)`);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_price_history_item_name ON price_history(item_name)`);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_price_history_date ON price_history(date_added)`);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_trade_offers_status ON trade_offers(status)`);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_trade_offers_creator ON trade_offers(creator_id)`);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_trade_sessions_status ON trade_sessions(status)`);

        console.log('✅ PostgreSQL Datenbank erfolgreich initialisiert!');
    } catch (error) {
        console.error('❌ Fehler bei Datenbank-Initialisierung:', error);
        throw error;
    }
}

// Utility Functions
function formatCurrency(amount) {
    return new Intl.NumberFormat('de-DE', {
        style: 'currency',
        currency: 'EUR',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    }).format(amount);
}

function generateTradeId() {
    return Math.random().toString(36).substr(2, 9).toUpperCase();
}

function hasTradePermissions(member) {
    if (!member || !member.roles) return false;
    return config.tradingRoles.some(roleName => 
        member.roles.cache.some(role => role.name === roleName)
    );
}

async function processImage(attachment) {
    try {
        if (!attachment.contentType || !attachment.contentType.startsWith('image/')) {
            throw new Error('Datei ist kein Bild!');
        }

        const format = attachment.contentType.split('/')[1];
        if (!config.allowedFormats.includes(format)) {
            throw new Error(`Format nicht erlaubt! Erlaubt: ${config.allowedFormats.join(', ')}`);
        }

        if (attachment.size > config.maxFileSize) {
            throw new Error(`Datei zu groß! Maximum: ${config.maxFileSize / 1024 / 1024}MB`);
        }

        const response = await fetch(attachment.url);
        const buffer = Buffer.from(await response.arrayBuffer());

        const processedBuffer = await sharp(buffer)
            .resize(800, 600, { 
                fit: 'inside',
                withoutEnlargement: true 
            })
            .jpeg({ 
                quality: 80,
                progressive: true 
            })
            .toBuffer();

        return {
            data: processedBuffer,
            filename: attachment.name,
            contentType: 'image/jpeg',
            originalSize: attachment.size,
            processedSize: processedBuffer.length
        };

    } catch (error) {
        throw new Error(`Bildverarbeitung fehlgeschlagen: ${error.message}`);
    }
}

async function createTradeChannel(guild, offer, interestedUser) {
    try {
        const channelName = `handel-${offer.item_name.replace(/\s+/g, '-').toLowerCase()}-${generateTradeId()}`;
        
        const channel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: config.tradingCategoryId,
            permissionOverwrites: [
                {
                    id: guild.roles.everyone,
                    deny: [PermissionFlagsBits.ViewChannel],
                },
                {
                    id: offer.creator_id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.AttachFiles,
                        PermissionFlagsBits.EmbedLinks
                    ],
                },
                {
                    id: interestedUser.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.AttachFiles,
                        PermissionFlagsBits.EmbedLinks
                    ],
                },
                {
                    id: client.user.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ManageChannels,
                        PermissionFlagsBits.EmbedLinks
                    ],
                },
            ],
        });

        // Store active channel info
        activeTradeChannels.set(channel.id, {
            offerId: offer.offer_id,
            creatorId: offer.creator_id,
            interestedUserId: interestedUser.id,
            createdAt: Date.now()
        });

        // Auto-delete after timeout
        setTimeout(async () => {
            try {
                if (activeTradeChannels.has(channel.id)) {
                    await channel.delete('Automatische Löschung nach Timeout');
                    activeTradeChannels.delete(channel.id);
                }
            } catch (error) {
                console.error('Fehler beim Löschen des Trade-Channels:', error);
            }
        }, config.tradeChannelTimeout);

        return channel;
    } catch (error) {
        console.error('Fehler beim Erstellen des Trade-Channels:', error);
        throw error;
    }
}

// Bot Events
client.once('ready', async () => {
    console.log(`🤖 Bot ist online als ${client.user.tag}!`);
    
    try {
        await initializeDatabase();
        await db.testConnection();
        await registerCommands();
        console.log('✅ Bot ist vollständig bereit!');
    } catch (error) {
        console.error('❌ Fehler beim Bot-Start:', error);
        process.exit(1);
    }
});

// Register Slash Commands
async function registerCommands() {
    const commands = [
        // Existing commands
        new SlashCommandBuilder()
            .setName('preis-hinzufugen')
            .setDescription('Füge einen neuen Strandmarktpreis hinzu')
            .addStringOption(option =>
                option.setName('gegenstand')
                    .setDescription('Name des Gegenstands (z.B. AK-47)')
                    .setRequired(true)
                    .setAutocomplete(true))
            .addNumberOption(option =>
                option.setName('marktpreis')
                    .setDescription('Aktueller Marktpreis (Handel zwischen Spielern)')
                    .setRequired(true))
            .addNumberOption(option =>
                option.setName('staatswert')
                    .setDescription('Staatswert/NPC-Preis (optional)')
                    .setRequired(false))
            .addAttachmentOption(option =>
                option.setName('bild')
                    .setDescription('Bild des Gegenstands (JPG, PNG, GIF, WebP - max 10MB)')
                    .setRequired(false)),

        new SlashCommandBuilder()
            .setName('preis-anzeigen')
            .setDescription('Zeige den aktuellen Preis eines Gegenstands')
            .addStringOption(option =>
                option.setName('gegenstand')
                    .setDescription('Name des Gegenstands')
                    .setRequired(true)
                    .setAutocomplete(true)),

        new SlashCommandBuilder()
            .setName('alle-preise')
            .setDescription('Zeige alle aktuellen Strandmarktpreise'),

        new SlashCommandBuilder()
            .setName('preis-verlauf')
            .setDescription('Zeige den Preisverlauf eines Gegenstands mit Diagramm')
            .addStringOption(option =>
                option.setName('gegenstand')
                    .setDescription('Name des Gegenstands')
                    .setRequired(true)
                    .setAutocomplete(true)),

        new SlashCommandBuilder()
            .setName('durchschnittspreis')
            .setDescription('Zeige den Durchschnittspreis eines Gegenstands')
            .addStringOption(option =>
                option.setName('gegenstand')
                    .setDescription('Name des Gegenstands')
                    .setRequired(true)
                    .setAutocomplete(true)),

        new SlashCommandBuilder()
            .setName('bild-anzeigen')
            .setDescription('Zeige das gespeicherte Bild eines Gegenstands')
            .addStringOption(option =>
                option.setName('gegenstand')
                    .setDescription('Name des Gegenstands')
                    .setRequired(true)
                    .setAutocomplete(true)),

        // New commands
        new SlashCommandBuilder()
            .setName('help')
            .setDescription('Zeige alle verfügbaren Commands und Informationen'),

        new SlashCommandBuilder()
            .setName('angebot-erstellen')
            .setDescription('Erstelle ein Handelsangebot (nur für Trader)')
            .addStringOption(option =>
                option.setName('typ')
                    .setDescription('Art des Angebots')
                    .setRequired(true)
                    .addChoices(
                        { name: '💰 Verkaufen', value: 'sell' },
                        { name: '🛒 Kaufen', value: 'buy' }
                    ))
            .addStringOption(option =>
                option.setName('gegenstand')
                    .setDescription('Was möchtest du handeln?')
                    .setRequired(true))
            .addNumberOption(option =>
                option.setName('preis')
                    .setDescription('Dein Preis in EUR')
                    .setRequired(true))
            .addIntegerOption(option =>
                option.setName('anzahl')
                    .setDescription('Anzahl der Items (Standard: 1)')
                    .setRequired(false))
            .addStringOption(option =>
                option.setName('beschreibung')
                    .setDescription('Zusätzliche Informationen zum Angebot')
                    .setRequired(false)),

        new SlashCommandBuilder()
            .setName('meine-angebote')
            .setDescription('Zeige deine aktiven Handelsangebote'),

        new SlashCommandBuilder()
            .setName('angebote-anzeigen')
            .setDescription('Zeige alle aktiven Handelsangebote')
            .addStringOption(option =>
                option.setName('typ')
                    .setDescription('Filter nach Angebotstyp')
                    .setRequired(false)
                    .addChoices(
                        { name: '💰 Verkaufsangebote', value: 'sell' },
                        { name: '🛒 Kaufgesuche', value: 'buy' }
                    ))
    ];

    try {
        console.log('🔄 Registriere Slash Commands...');
        await client.application.commands.set(commands);
        console.log('✅ Slash Commands erfolgreich registriert!');
    } catch (error) {
        console.error('❌ Fehler beim Registrieren der Commands:', error);
    }
}

// Command Handler
client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;

        try {
            switch (commandName) {
                case 'preis-hinzufugen':
                    await handleAddPrice(interaction);
                    break;
                case 'preis-anzeigen':
                    await handleShowPrice(interaction);
                    break;
                case 'alle-preise':
                    await handleShowAllPrices(interaction);
                    break;
                case 'preis-verlauf':
                    await handlePriceHistory(interaction);
                    break;
                case 'durchschnittspreis':
                    await handleAveragePrice(interaction);
                    break;
                case 'bild-anzeigen':
                    await handleShowImage(interaction);
                    break;
                case 'help':
                    await handleHelp(interaction);
                    break;
                case 'angebot-erstellen':
                    await handleCreateOffer(interaction);
                    break;
                case 'meine-angebote':
                    await handleMyOffers(interaction);
                    break;
                case 'angebote-anzeigen':
                    await handleShowOffers(interaction);
                    break;
            }
        } catch (error) {
            console.error('Command Error:', error);
            const errorMessage = `❌ Es ist ein Fehler aufgetreten: ${error.message}`;
            
            if (interaction.deferred) {
                await interaction.followUp({ content: errorMessage, ephemeral: true });
            } else {
                await interaction.reply({ content: errorMessage, ephemeral: true });
            }
        }
    } else if (interaction.isButton()) {
        await handleButtonInteraction(interaction);
    } else if (interaction.isAutocomplete()) {
        await handleAutocomplete(interaction);
    }
});

// Autocomplete Handler
async function handleAutocomplete(interaction) {
    try {
        const focusedValue = interaction.options.getFocused().toLowerCase();
        
        const rows = await db.queryRows(`
            SELECT DISTINCT display_name, item_name 
            FROM current_prices 
            WHERE LOWER(display_name) LIKE $1 OR LOWER(item_name) LIKE $1 
            ORDER BY display_name 
            LIMIT 25
        `, [`%${focusedValue}%`]);

        const choices = rows.map(row => ({
            name: row.display_name,
            value: row.display_name
        }));

        await interaction.respond(choices);
    } catch (error) {
        console.error('Autocomplete Error:', error);
        await interaction.respond([]);
    }
}

// Button Interaction Handler
async function handleButtonInteraction(interaction) {
    const [action, offerId, userId] = interaction.customId.split('_');
    
    try {
        switch (action) {
            case 'interest':
                await handleInterestButton(interaction, parseInt(offerId));
                break;
            case 'complete':
                await handleCompleteButton(interaction, parseInt(offerId));
                break;
            case 'cancel':
                await handleCancelButton(interaction, parseInt(offerId));
                break;
        }
    } catch (error) {
        console.error('Button Interaction Error:', error);
        await interaction.reply({ 
            content: `❌ Fehler bei der Aktion: ${error.message}`, 
            ephemeral: true 
        });
    }
}

// Help Command Handler
async function handleHelp(interaction) {
    const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('🤖 GTA V Grand RP Strandmarkt Bot - Hilfe')
        .setDescription('**Alle verfügbaren Commands und Features**')
        .setThumbnail(client.user.displayAvatarURL())
        .addFields(
            {
                name: '💰 **Preis-Commands**',
                value: `\`/preis-hinzufugen\` - Neuen Preis hinzufügen/aktualisieren
                \`/preis-anzeigen\` - Aktuellen Preis anzeigen
                \`/alle-preise\` - Alle Preise auflisten
                \`/preis-verlauf\` - Preisentwicklung mit Diagramm
                \`/durchschnittspreis\` - Statistiken berechnen
                \`/bild-anzeigen\` - Gespeichertes Bild anzeigen`,
                inline: false
            },
            {
                name: '🔄 **Handels-Commands** (nur für Trader)',
                value: `\`/angebot-erstellen\` - Neues Handelsangebot erstellen
                \`/meine-angebote\` - Deine aktiven Angebote anzeigen
                \`/angebote-anzeigen\` - Alle verfügbaren Angebote`,
                inline: false
            },
            {
                name: '🎯 **Features**',
                value: `📸 **Bildupload:** Bilder werden automatisch als Thumbnails angezeigt
                🔍 **Auto-Complete:** Intelligente Vorschläge bei der Eingabe
                📊 **Diagramme:** Interaktive Preisverlaufs-Charts
                🏛️ **Staatswerte:** Vergleich mit NPC-Preisen
                💬 **Private Handel:** Automatische Trade-Channels
                🔒 **Rollenberechtigung:** Nur Trader können handeln`,
                inline: false
            },
            {
                name: '⚙️ **Trader-Rollen**',
                value: config.tradingRoles.map(role => `• ${role}`).join('\n') || 'Keine Rollen konfiguriert',
                inline: true
            },
            {
                name: '📋 **Bildupload**',
                value: `**Erlaubte Formate:** ${config.allowedFormats.join(', ').toUpperCase()}
                **Max. Größe:** ${config.maxFileSize / 1024 / 1024}MB
                **Automatische Optimierung:** Ja`,
                inline: true
            }
        )
        .setFooter({ 
            text: 'GTA V Grand RP • Strandmarkt Bot • /help für diese Hilfe',
            iconURL: interaction.guild?.iconURL() 
        })
        .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

// Add Price Handler (FIXED: Images now show as thumbnails)
async function handleAddPrice(interaction) {
    const displayName = interaction.options.getString('gegenstand').trim();
    const itemName = displayName.toLowerCase();
    const marketPrice = interaction.options.getNumber('marktpreis');
    const stateValue = interaction.options.getNumber('staatswert');
    const imageAttachment = interaction.options.getAttachment('bild');
    const userId = interaction.user.tag;

    await interaction.deferReply();

    try {
        let imageData = null;
        let imageFilename = null;
        let imageContentType = null;
        let processingInfo = '';

        // Process image if provided
        if (imageAttachment) {
            try {
                const processed = await processImage(imageAttachment);
                imageData = processed.data;
                imageFilename = processed.filename;
                imageContentType = processed.contentType;
                
                const sizeMB = (processed.processedSize / 1024 / 1024).toFixed(2);
                processingInfo = `\n📸 **Bild verarbeitet:** ${processed.filename} (${sizeMB}MB)`;
            } catch (imageError) {
                await interaction.followUp(`❌ **Bildupload fehlgeschlagen:** ${imageError.message}\n\nPreis wird ohne Bild gespeichert.`);
            }
        }

        // Database transaction
        await db.transaction(async (client) => {
            // Add to history
            await client.query(`
                INSERT INTO price_history (item_name, display_name, market_price, state_value, image_data, image_filename, image_content_type, added_by) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `, [itemName, displayName, marketPrice, stateValue, imageData, imageFilename, imageContentType, userId]);

            // Check existing values
            const existingRow = await client.query('SELECT * FROM current_prices WHERE item_name = $1', [itemName]);
            const existing = existingRow.rows[0];

            // Determine final values - keep old values if new ones not provided
            let finalStateValue = stateValue;
            let finalImageData = imageData;
            let finalImageFilename = imageFilename;
            let finalImageContentType = imageContentType;

            if (existing) {
                if (stateValue === null && existing.state_value !== null) {
                    finalStateValue = existing.state_value;
                }
                if (!imageData && existing.image_data) {
                    finalImageData = existing.image_data;
                    finalImageFilename = existing.image_filename;
                    finalImageContentType = existing.image_content_type;
                }
            }

            // Update current price
            await client.query(`
                INSERT INTO current_prices (item_name, display_name, market_price, state_value, image_data, image_filename, image_content_type, updated_by, last_updated)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
                ON CONFLICT (item_name) 
                DO UPDATE SET 
                    display_name = $2,
                    market_price = $3,
                    state_value = $4,
                    image_data = $5,
                    image_filename = $6,
                    image_content_type = $7,
                    updated_by = $8,
                    last_updated = CURRENT_TIMESTAMP
            `, [itemName, displayName, marketPrice, finalStateValue, finalImageData, finalImageFilename, finalImageContentType, userId]);

            // Create success message
            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle('✅ Preis erfolgreich aktualisiert!')
                .addFields(
                    { name: '📦 Gegenstand', value: `\`${displayName}\``, inline: true },
                    { name: '💰 Marktpreis', value: `**${formatCurrency(marketPrice)}**`, inline: true },
                    { name: '🏛️ Staatswert', value: finalStateValue ? `**${formatCurrency(finalStateValue)}**` : '*Nicht angegeben*', inline: true },
                    { name: '👤 Aktualisiert von', value: userId, inline: true },
                    { name: '🕐 Zeitpunkt', value: `<t:${Math.floor(Date.now() / 1000)}:f>`, inline: true }
                )
                .setFooter({ text: 'GTA V Grand RP • Strandmarkt Bot' })
                .setTimestamp();

            // FIXED: Add image as thumbnail if available
            if (finalImageData) {
                const attachment = new AttachmentBuilder(finalImageData, { 
                    name: finalImageFilename || 'item.jpg' 
                });
                embed.setThumbnail(`attachment://${finalImageFilename || 'item.jpg'}`);
                
                // Send with image attachment
                await interaction.followUp({ 
                    embeds: [embed.addFields({ 
                        name: 'ℹ️ Status', 
                        value: (existing ? '🔄 Bestehender Eintrag aktualisiert' : '🆕 Neuer Eintrag erstellt') + processingInfo, 
                        inline: false 
                    })], 
                    files: [attachment] 
                });
            } else {
                // Send without image
                embed.addFields({ 
                    name: 'ℹ️ Status', 
                    value: (existing ? '🔄 Bestehender Eintrag aktualisiert' : '🆕 Neuer Eintrag erstellt'), 
                    inline: false 
                });
                
                await interaction.followUp({ embeds: [embed] });
            }

            // Add profit calculation if both prices available
            if (finalStateValue && finalStateValue > 0) {
                const profit = marketPrice - finalStateValue;
                const profitPercent = ((profit / finalStateValue) * 100).toFixed(1);
                const profitColor = profit > 0 ? '📈' : '📉';
                
                const profitEmbed = new EmbedBuilder()
                    .setColor(profit > 0 ? '#00ff00' : '#ff0000')
                    .addFields({
                        name: `${profitColor} Gewinn/Verlust`,
                        value: `**${formatCurrency(profit)}** (${profitPercent}%)`,
                        inline: false
                    });
                
                if (finalImageData) {
                    await interaction.followUp({ embeds: [profitEmbed] });
                }
            }
        });

    } catch (error) {
        console.error('Add Price Error:', error);
        await interaction.followUp(`❌ **Fehler beim Speichern:** ${error.message}`);
    }
}

// Show Price Handler (FIXED: Images now always show as thumbnails)
async function handleShowPrice(interaction) {
    const searchName = interaction.options.getString('gegenstand').trim();
    await interaction.deferReply();

    try {
        const row = await db.queryRow(`
            SELECT * FROM current_prices 
            WHERE display_name = $1 OR item_name = $2
        `, [searchName, searchName.toLowerCase()]);

        if (!row) {
            await interaction.followUp(`❌ Kein Preis für "${searchName}" gefunden!`);
            return;
        }

        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle(`💰 ${row.display_name}`)
            .setDescription(`**Aktuelle Strandmarktpreise**`)
            .addFields(
                { name: '💵 Marktpreis', value: `**${formatCurrency(row.market_price)}**`, inline: true },
                { name: '🏛️ Staatswert', value: row.state_value ? `**${formatCurrency(row.state_value)}**` : '*Nicht verfügbar*', inline: true },
                { name: '📅 Letzte Aktualisierung', value: `<t:${Math.floor(new Date(row.last_updated).getTime() / 1000)}:R>`, inline: true },
                { name: '👤 Von', value: `${row.updated_by}`, inline: true }
            )
            .setFooter({ text: 'GTA V Grand RP • Strandmarkt Bot' })
            .setTimestamp();

        // Profit calculation if both prices available
        if (row.state_value && row.state_value > 0) {
            const profit = row.market_price - row.state_value;
            const profitPercent = ((profit / row.state_value) * 100).toFixed(1);
            const profitColor = profit > 0 ? '📈' : '📉';
            const profitText = profit > 0 ? 'Gewinn' : 'Verlust';
            
            embed.addFields({
                name: `${profitColor} ${profitText} pro Stück`,
                value: `**${formatCurrency(Math.abs(profit))}** (${Math.abs(profitPercent)}%)`,
                inline: false
            });
        }

        // FIXED: Always show image as thumbnail if available
        if (row.image_data) {
            const attachment = new AttachmentBuilder(row.image_data, { name: row.image_filename || 'item.jpg' });
            embed.setThumbnail(`attachment://${row.image_filename || 'item.jpg'}`);
            
            await interaction.followUp({ 
                embeds: [embed], 
                files: [attachment] 
            });
        } else {
            await interaction.followUp({ embeds: [embed] });
        }

    } catch (error) {
        console.error('Show Price Error:', error);
        await interaction.followUp('❌ Fehler beim Abrufen des Preises!');
    }
}

// Show All Prices Handler
async function handleShowAllPrices(interaction) {
    await interaction.deferReply();

    try {
        const rows = await db.queryRows(`
            SELECT * FROM current_prices 
            ORDER BY market_price DESC
        `);

        if (rows.length === 0) {
            await interaction.followUp('❌ Keine Preise in der Datenbank gefunden!');
            return;
        }

        const embed = new EmbedBuilder()
            .setColor('#ff9900')
            .setTitle('📋 Alle Strandmarktpreise')
            .setFooter({ text: 'GTA V Grand RP • Strandmarkt Bot' })
            .setTimestamp();

        let itemList = '';
        rows.forEach((row, index) => {
            const emoji = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '📦';
            const imageEmoji = row.image_data ? '📸' : '';
            itemList += `${emoji} **${row.display_name}** ${imageEmoji}\n`;
            itemList += `💰 ${formatCurrency(row.market_price)}`;
            
            if (row.state_value) {
                const profit = row.market_price - row.state_value;
                const profitEmoji = profit > 0 ? '📈' : profit < 0 ? '📉' : '➡️';
                itemList += ` | 🏛️ ${formatCurrency(row.state_value)} ${profitEmoji}`;
            }
            
            itemList += ` • <t:${Math.floor(new Date(row.last_updated).getTime() / 1000)}:R>\n\n`;
        });

        if (itemList.length > 4000) {
            itemList = itemList.substring(0, 4000) + '...\n\n*Zu viele Artikel - zeige nur die ersten*';
        }

        embed.setDescription(`**${rows.length} Artikel verfügbar** • 📸 = Hat Bild\n\n${itemList}`);

        await interaction.followUp({ embeds: [embed] });

    } catch (error) {
        console.error('Show All Prices Error:', error);
        await interaction.followUp('❌ Fehler beim Abrufen der Preise!');
    }
}

// Price History Handler
async function handlePriceHistory(interaction) {
    const searchName = interaction.options.getString('gegenstand').trim();
    await interaction.deferReply();

    try {
        const rows = await db.queryRows(`
            SELECT market_price, state_value, date_added 
            FROM price_history 
            WHERE display_name = $1 OR item_name = $2 
            ORDER BY date_added
        `, [searchName, searchName.toLowerCase()]);

        if (rows.length === 0) {
            await interaction.followUp(`❌ Keine Historie für "${searchName}" gefunden!`);
            return;
        }

        // Create Chart
        const labels = rows.map(row => new Date(row.date_added).toLocaleDateString('de-DE'));
        const marketPrices = rows.map(row => parseFloat(row.market_price));
        const statePrices = rows.map(row => row.state_value ? parseFloat(row.state_value) : null);

        const datasets = [{
            label: 'Marktpreis',
            data: marketPrices,
            borderColor: '#ff6600',
            backgroundColor: 'rgba(255, 102, 0, 0.1)',
            tension: 0.3,
            fill: true,
            pointRadius: 6,
            pointHoverRadius: 8,
            borderWidth: 3
        }];

        const hasStateValues = statePrices.some(price => price !== null);
        if (hasStateValues) {
            datasets.push({
                label: 'Staatswert',
                data: statePrices,
                borderColor: '#00aa00',
                backgroundColor: 'rgba(0, 170, 0, 0.1)',
                tension: 0.3,
                fill: false,
                pointRadius: 4,
                pointHoverRadius: 6,
                borderWidth: 2,
                borderDash: [5, 5]
            });
        }

        const configuration = {
            type: 'line',
            data: { labels: labels, datasets: datasets },
            options: {
                responsive: true,
                plugins: {
                    title: {
                        display: true,
                        text: `📈 Preisverlauf: ${searchName}`,
                        font: { size: 16, weight: 'bold' }
                    },
                    legend: { display: hasStateValues, position: 'top' }
                },
                scales: {
                    y: {
                        beginAtZero: false,
                        title: { display: true, text: 'Preis (€)', font: { size: 14, weight: 'bold' } },
                        ticks: {
                            callback: function(value) {
                                return new Intl.NumberFormat('de-DE', {
                                    style: 'currency', currency: 'EUR', minimumFractionDigits: 0
                                }).format(value);
                            }
                        }
                    },
                    x: { title: { display: true, text: 'Datum', font: { size: 14, weight: 'bold' } } }
                }
            }
        };

        try {
            const imageBuffer = await chartJSNodeCanvas.renderToBuffer(configuration);
            const attachment = new AttachmentBuilder(imageBuffer, { name: 'preisverlauf.png' });

            const embed = new EmbedBuilder()
                .setColor('#ff6600')
                .setTitle(`📈 Preisverlauf: ${searchName}`)
                .setDescription(`**${rows.length} Preiseinträge** • Diagramm zeigt die Entwicklung`)
                .addFields(
                    { name: '📊 Aktueller Marktpreis', value: `${formatCurrency(marketPrices[marketPrices.length - 1])}`, inline: true },
                    { name: '📈 Höchster Marktpreis', value: `${formatCurrency(Math.max(...marketPrices))}`, inline: true },
                    { name: '📉 Niedrigster Marktpreis', value: `${formatCurrency(Math.min(...marketPrices))}`, inline: true }
                )
                .setImage('attachment://preisverlauf.png')
                .setFooter({ text: 'GTA V Grand RP • Strandmarkt Bot' })
                .setTimestamp();

            await interaction.followUp({ embeds: [embed], files: [attachment] });
        } catch (chartError) {
            console.error('Chart Error:', chartError);
            
            // Fallback: Text-based display
            const embed = new EmbedBuilder()
                .setColor('#ff6600')
                .setTitle(`📈 Preisverlauf: ${searchName}`)
                .setDescription('⚠️ Diagramm konnte nicht erstellt werden. Hier die letzten 10 Einträge:')
                .setFooter({ text: 'GTA V Grand RP • Strandmarkt Bot' })
                .setTimestamp();

            const lastEntries = rows.slice(-10);
            let priceHistory = '';
            lastEntries.forEach((row) => {
                const date = new Date(row.date_added);
                const timestamp = Math.floor(date.getTime() / 1000);
                priceHistory += `**${formatCurrency(row.market_price)}**`;
                if (row.state_value) {
                    priceHistory += ` (🏛️ ${formatCurrency(row.state_value)})`;
                }
                priceHistory += ` • <t:${timestamp}:R>\n`;
            });

            embed.setDescription(`⚠️ Diagramm konnte nicht erstellt werden.\n\n**Letzte ${lastEntries.length} Einträge:**\n${priceHistory}`);
            await interaction.followUp({ embeds: [embed] });
        }

    } catch (error) {
        console.error('Price History Error:', error);
        await interaction.followUp('❌ Fehler beim Abrufen der Historie!');
    }
}

// Average Price Handler
async function handleAveragePrice(interaction) {
    const searchName = interaction.options.getString('gegenstand').trim();
    await interaction.deferReply();

    try {
        const rows = await db.queryRows(`
            SELECT market_price, state_value 
            FROM price_history 
            WHERE display_name = $1 OR item_name = $2
        `, [searchName, searchName.toLowerCase()]);

        if (rows.length === 0) {
            await interaction.followUp(`❌ Keine Daten für "${searchName}" gefunden!`);
            return;
        }

        const marketPrices = rows.map(row => parseFloat(row.market_price));
        const statePrices = rows.filter(row => row.state_value).map(row => parseFloat(row.state_value));
        
        const averageMarket = marketPrices.reduce((sum, price) => sum + price, 0) / marketPrices.length;
        const minMarket = Math.min(...marketPrices);
        const maxMarket = Math.max(...marketPrices);

        const embed = new EmbedBuilder()
            .setColor('#9900ff')
            .setTitle(`📊 Statistiken: ${searchName}`)
            .setDescription(`**Basierend auf ${rows.length} Preiseinträgen**`)
            .addFields(
                { name: '💰 Ø Marktpreis', value: `**${formatCurrency(averageMarket)}**`, inline: true },
                { name: '📉 Min. Marktpreis', value: `**${formatCurrency(minMarket)}**`, inline: true },
                { name: '📈 Max. Marktpreis', value: `**${formatCurrency(maxMarket)}**`, inline: true },
                { name: '📊 Markt-Schwankung', value: `**${formatCurrency(maxMarket - minMarket)}**`, inline: true },
                { name: '📈 Markt-Varianz', value: `${((maxMarket - minMarket) / averageMarket * 100).toFixed(1)}%`, inline: true },
                { name: '📋 Gesamte Einträge', value: `**${rows.length}**`, inline: true }
            )
            .setFooter({ text: 'GTA V Grand RP • Strandmarkt Bot' })
            .setTimestamp();

        // Add state value statistics if available
        if (statePrices.length > 0) {
            const averageState = statePrices.reduce((sum, price) => sum + price, 0) / statePrices.length;
            const minState = Math.min(...statePrices);
            const maxState = Math.max(...statePrices);
            const avgProfit = averageMarket - averageState;
            const avgProfitPercent = ((avgProfit / averageState) * 100).toFixed(1);

            embed.addFields(
                { name: '🏛️ Ø Staatswert', value: `**${formatCurrency(averageState)}**`, inline: true },
                { name: '📉 Min. Staatswert', value: `**${formatCurrency(minState)}**`, inline: true },
                { name: '📈 Max. Staatswert', value: `**${formatCurrency(maxState)}**`, inline: true },
                { name: '💹 Ø Gewinn/Verlust', value: `**${formatCurrency(avgProfit)}**`, inline: true },
                { name: '📊 Ø Gewinn %', value: `**${avgProfitPercent}%**`, inline: true },
                { name: '🏛️ Staatswert-Einträge', value: `**${statePrices.length}**`, inline: true }
            );
        }

        await interaction.followUp({ embeds: [embed] });

    } catch (error) {
        console.error('Average Price Error:', error);
        await interaction.followUp('❌ Fehler beim Berechnen des Durchschnitts!');
    }
}

// Show Image Handler
async function handleShowImage(interaction) {
    const searchName = interaction.options.getString('gegenstand').trim();
    await interaction.deferReply();

    try {
        const row = await db.queryRow(`
            SELECT display_name, image_data, image_filename, image_content_type, last_updated, updated_by
            FROM current_prices 
            WHERE display_name = $1 OR item_name = $2
        `, [searchName, searchName.toLowerCase()]);

        if (!row) {
            await interaction.followUp(`❌ Gegenstand "${searchName}" nicht gefunden!`);
            return;
        }

        if (!row.image_data) {
            await interaction.followUp(`📦 **${row.display_name}** hat kein gespeichertes Bild.`);
            return;
        }

        const attachment = new AttachmentBuilder(row.image_data, { 
            name: row.image_filename || 'item.jpg' 
        });

        const embed = new EmbedBuilder()
            .setColor('#00aaff')
            .setTitle(`📸 ${row.display_name}`)
            .setDescription('**Gespeichertes Bild**')
            .addFields(
                { name: '📅 Hochgeladen', value: `<t:${Math.floor(new Date(row.last_updated).getTime() / 1000)}:R>`, inline: true },
                { name: '👤 Von', value: row.updated_by, inline: true },
                { name: '📁 Dateiname', value: row.image_filename || 'Unbekannt', inline: true }
            )
            .setImage(`attachment://${row.image_filename || 'item.jpg'}`)
            .setFooter({ text: 'GTA V Grand RP • Strandmarkt Bot' })
            .setTimestamp();

        await interaction.followUp({ 
            embeds: [embed], 
            files: [attachment] 
        });

    } catch (error) {
        console.error('Show Image Error:', error);
        await interaction.followUp('❌ Fehler beim Abrufen des Bildes!');
    }
}

// NEW: Create Trade Offer Handler
async function handleCreateOffer(interaction) {
    // Check if user has trading permissions
    if (!hasTradePermissions(interaction.member)) {
        await interaction.reply({
            content: `🚫 **Keine Berechtigung!**\n\nDu benötigst eine der folgenden Rollen zum Handeln:\n${config.tradingRoles.map(role => `• ${role}`).join('\n')}`,
            ephemeral: true
        });
        return;
    }

    const offerType = interaction.options.getString('typ');
    const itemName = interaction.options.getString('gegenstand').trim();
    const price = interaction.options.getNumber('preis');
    const quantity = interaction.options.getInteger('anzahl') || 1;
    const description = interaction.options.getString('beschreibung') || '';

    await interaction.deferReply();

    try {
        // Create offer in database
        const result = await db.query(`
            INSERT INTO trade_offers (creator_id, creator_name, guild_id, item_name, item_description, quantity, price_amount, offer_type)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING offer_id
        `, [
            interaction.user.id,
            interaction.user.displayName,
            interaction.guild.id,
            itemName,
            description,
            quantity,
            price,
            offerType
        ]);

        const offerId = result.rows[0].offer_id;

        // Create offer embed
        const embed = new EmbedBuilder()
            .setColor(offerType === 'sell' ? '#00ff00' : '#ff6b35')
            .setTitle(`${offerType === 'sell' ? '💰 Verkaufsangebot' : '🛒 Kaufgesuch'}`)
            .setDescription(`**${itemName}**`)
            .addFields(
                { name: '💵 Preis', value: `${formatCurrency(price)}`, inline: true },
                { name: '📦 Anzahl', value: quantity.toString(), inline: true },
                { name: '👤 Anbieter', value: `<@${interaction.user.id}>`, inline: true }
            )
            .setFooter({ 
                text: `Angebot ID: ${offerId} • Reagiere mit Interesse!`,
                iconURL: interaction.user.displayAvatarURL() 
            })
            .setTimestamp();

        if (description) {
            embed.addFields({ name: '📝 Beschreibung', value: description, inline: false });
        }

        // Create interest button
        const button = new ButtonBuilder()
            .setCustomId(`interest_${offerId}_${interaction.user.id}`)
            .setLabel('Interesse anmelden')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('🤝');

        const row = new ActionRowBuilder().addComponents(button);

        const message = await interaction.followUp({ 
            embeds: [embed], 
            components: [row] 
        });

        // Update offer with message ID
        await db.query(`
            UPDATE trade_offers 
            SET channel_id = $1, message_id = $2 
            WHERE offer_id = $3
        `, [interaction.channel.id, message.id, offerId]);

    } catch (error) {
        console.error('Create Offer Error:', error);
        await interaction.followUp(`❌ **Fehler beim Erstellen des Angebots:** ${error.message}`);
    }
}

// NEW: Handle Interest Button
async function handleInterestButton(interaction, offerId) {
    await interaction.deferReply({ ephemeral: true });

    try {
        // Get offer details
        const offer = await db.queryRow(`
            SELECT * FROM trade_offers 
            WHERE offer_id = $1 AND status = 'active'
        `, [offerId]);

        if (!offer) {
            await interaction.followUp({ 
                content: '❌ Dieses Angebot ist nicht mehr verfügbar!', 
                ephemeral: true 
            });
            return;
        }

        // Check if user is trying to respond to their own offer
        if (offer.creator_id === interaction.user.id) {
            await interaction.followUp({ 
                content: '❌ Du kannst nicht auf dein eigenes Angebot reagieren!', 
                ephemeral: true 
            });
            return;
        }

        // Check if user has trading permissions
        if (!hasTradePermissions(interaction.member)) {
            await interaction.followUp({
                content: `🚫 **Keine Berechtigung!**\n\nDu benötigst eine der folgenden Rollen zum Handeln:\n${config.tradingRoles.map(role => `• ${role}`).join('\n')}`,
                ephemeral: true
            });
            return;
        }

        // Create private trading channel
        const tradeChannel = await createTradeChannel(interaction.guild, offer, interaction.user);

        // Create trade session in database
        const sessionResult = await db.query(`
            INSERT INTO trade_sessions (offer_id, buyer_id, seller_id, buyer_name, seller_name, guild_id, channel_id, agreed_price)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING session_id
        `, [
            offerId,
            offer.offer_type === 'sell' ? interaction.user.id : offer.creator_id,
            offer.offer_type === 'sell' ? offer.creator_id : interaction.user.id,
            offer.offer_type === 'sell' ? interaction.user.displayName : offer.creator_name,
            offer.offer_type === 'sell' ? offer.creator_name : interaction.user.displayName,
            interaction.guild.id,
            tradeChannel.id,
            offer.price_amount
        ]);

        const sessionId = sessionResult.rows[0].session_id;

        // Send welcome message in trade channel
        const welcomeEmbed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle('🤝 Neuer Handel gestartet!')
            .setDescription(`**${offer.item_name}**`)
            .addFields(
                { name: '💰 Verkäufer', value: `<@${offer.offer_type === 'sell' ? offer.creator_id : interaction.user.id}>`, inline: true },
                { name: '🛒 Käufer', value: `<@${offer.offer_type === 'sell' ? interaction.user.id : offer.creator_id}>`, inline: true },
                { name: '💵 Preis', value: formatCurrency(offer.price_amount), inline: true },
                { name: '📦 Anzahl', value: offer.quantity.toString(), inline: true }
            )
            .setFooter({ text: `Session ID: ${sessionId} • Kanal wird automatisch nach 1h gelöscht` })
            .setTimestamp();

        if (offer.item_description) {
            welcomeEmbed.addFields({ name: '📝 Beschreibung', value: offer.item_description, inline: false });
        }

        const completeButton = new ButtonBuilder()
            .setCustomId(`complete_${sessionId}_${interaction.user.id}`)
            .setLabel('Handel abschließen')
            .setStyle(ButtonStyle.Success)
            .setEmoji('✅');

        const cancelButton = new ButtonBuilder()
            .setCustomId(`cancel_${sessionId}_${interaction.user.id}`)
            .setLabel('Handel abbrechen')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('❌');

        const actionRow = new ActionRowBuilder().addComponents(completeButton, cancelButton);

        await tradeChannel.send({ 
            content: `<@${offer.creator_id}> <@${interaction.user.id}>`,
            embeds: [welcomeEmbed], 
            components: [actionRow] 
        });

        await interaction.followUp({ 
            content: `✅ **Handel gestartet!**\n\nEin privater Handels-Channel wurde erstellt: ${tradeChannel}\n\nDort könnt ihr die Details besprechen und den Handel abschließen.`, 
            ephemeral: true 
        });

    } catch (error) {
        console.error('Interest Button Error:', error);
        await interaction.followUp({ 
            content: `❌ Fehler beim Starten des Handels: ${error.message}`, 
            ephemeral: true 
        });
    }
}

// NEW: Handle Complete Button
async function handleCompleteButton(interaction, sessionId) {
    await interaction.deferReply();

    try {
        // Update trade session as completed
        await db.query(`
            UPDATE trade_sessions 
            SET status = 'completed', completed_at = CURRENT_TIMESTAMP 
            WHERE session_id = $1
        `, [sessionId]);

        // Update offer status
        const session = await db.queryRow(`
            SELECT offer_id FROM trade_sessions WHERE session_id = $1
        `, [sessionId]);

        if (session) {
            await db.query(`
                UPDATE trade_offers 
                SET status = 'completed', updated_at = CURRENT_TIMESTAMP 
                WHERE offer_id = $1
            `, [session.offer_id]);
        }

        const successEmbed = new EmbedBuilder()
            .setColor('#00ff00')
            .setTitle('✅ Handel erfolgreich abgeschlossen!')
            .setDescription('Vielen Dank für euren fairen Handel!')
            .addFields(
                { name: '📋 Session ID', value: sessionId.toString(), inline: true },
                { name: '🕐 Abgeschlossen', value: `<t:${Math.floor(Date.now() / 1000)}:f>`, inline: true }
            )
            .setFooter({ text: 'Dieser Channel wird in 5 Minuten automatisch gelöscht' })
            .setTimestamp();

        await interaction.followUp({ embeds: [successEmbed] });

        // Delete channel after 5 minutes
        setTimeout(async () => {
            try {
                await interaction.channel.delete('Handel abgeschlossen');
                activeTradeChannels.delete(interaction.channel.id);
            } catch (error) {
                console.error('Fehler beim Löschen des Trade-Channels:', error);
            }
        }, 300000); // 5 minutes

    } catch (error) {
        console.error('Complete Button Error:', error);
        await interaction.followUp(`❌ Fehler beim Abschließen: ${error.message}`);
    }
}

// NEW: Handle Cancel Button
async function handleCancelButton(interaction, sessionId) {
    await interaction.deferReply();

    try {
        // Update trade session as cancelled
        await db.query(`
            UPDATE trade_sessions 
            SET status = 'cancelled' 
            WHERE session_id = $1
        `, [sessionId]);

        const cancelEmbed = new EmbedBuilder()
            .setColor('#ff0000')
            .setTitle('❌ Handel abgebrochen')
            .setDescription('Der Handel wurde abgebrochen.')
            .addFields(
                { name: '📋 Session ID', value: sessionId.toString(), inline: true },
                { name: '🕐 Abgebrochen', value: `<t:${Math.floor(Date.now() / 1000)}:f>`, inline: true }
            )
            .setFooter({ text: 'Dieser Channel wird in 30 Sekunden gelöscht' })
            .setTimestamp();

        await interaction.followUp({ embeds: [cancelEmbed] });

        // Delete channel after 30 seconds
        setTimeout(async () => {
            try {
                await interaction.channel.delete('Handel abgebrochen');
                activeTradeChannels.delete(interaction.channel.id);
            } catch (error) {
                console.error('Fehler beim Löschen des Trade-Channels:', error);
            }
        }, 30000); // 30 seconds

    } catch (error) {
        console.error('Cancel Button Error:', error);
        await interaction.followUp(`❌ Fehler beim Abbrechen: ${error.message}`);
    }
}

// NEW: My Offers Handler
async function handleMyOffers(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
        const offers = await db.queryRows(`
            SELECT * FROM trade_offers 
            WHERE creator_id = $1 AND status = 'active' 
            ORDER BY created_at DESC
        `, [interaction.user.id]);

        if (offers.length === 0) {
            await interaction.followUp({ 
                content: '📭 **Keine aktiven Angebote**\n\nDu hast derzeit keine aktiven Handelsangebote.\nErstelle ein neues mit `/angebot-erstellen`!', 
                ephemeral: true 
            });
            return;
        }

        const embed = new EmbedBuilder()
            .setColor('#9900ff')
            .setTitle(`📋 Deine aktiven Angebote (${offers.length})`)
            .setFooter({ text: 'GTA V Grand RP • Strandmarkt Bot' })
            .setTimestamp();

        let offersList = '';
        offers.forEach((offer, index) => {
            const emoji = offer.offer_type === 'sell' ? '💰' : '🛒';
            const typeText = offer.offer_type === 'sell' ? 'Verkauf' : 'Kaufgesuch';
            
            offersList += `${emoji} **${offer.item_name}** (${typeText})\n`;
            offersList += `💵 ${formatCurrency(offer.price_amount)} • 📦 ${offer.quantity}x\n`;
            offersList += `🆔 ${offer.offer_id} • <t:${Math.floor(new Date(offer.created_at).getTime() / 1000)}:R>\n\n`;
        });

        embed.setDescription(offersList);

        await interaction.followUp({ embeds: [embed], ephemeral: true });

    } catch (error) {
        console.error('My Offers Error:', error);
        await interaction.followUp({ 
            content: `❌ Fehler beim Abrufen deiner Angebote: ${error.message}`, 
            ephemeral: true 
        });
    }
}

// NEW: Show Offers Handler
async function handleShowOffers(interaction) {
    const filterType = interaction.options.getString('typ');
    await interaction.deferReply();

    try {
        let query = `
            SELECT * FROM trade_offers 
            WHERE status = 'active' AND guild_id = $1
        `;
        let params = [interaction.guild.id];

        if (filterType) {
            query += ` AND offer_type = $2`;
            params.push(filterType);
        }

        query += ` ORDER BY created_at DESC LIMIT 10`;

        const offers = await db.queryRows(query, params);

        if (offers.length === 0) {
            const typeText = filterType === 'sell' ? 'Verkaufsangebote' : filterType === 'buy' ? 'Kaufgesuche' : 'Angebote';
            await interaction.followUp(`📭 **Keine aktiven ${typeText}**\n\nDerzeit sind keine ${typeText.toLowerCase()} verfügbar.`);
            return;
        }

        const embed = new EmbedBuilder()
            .setColor('#00aaff')
            .setTitle(`🏪 Aktive Angebote ${filterType ? (filterType === 'sell' ? '(Verkauf)' : '(Kaufgesuche)') : ''}`)
            .setDescription(`**${offers.length} Angebote verfügbar** • Reagiere mit 🤝 um Interesse zu zeigen`)
            .setFooter({ text: 'GTA V Grand RP • Strandmarkt Bot' })
            .setTimestamp();

        let offersList = '';
        offers.forEach((offer, index) => {
            const emoji = offer.offer_type === 'sell' ? '💰' : '🛒';
            const typeText = offer.offer_type === 'sell' ? 'Verkauf' : 'Kaufgesuch';
            
            offersList += `${emoji} **${offer.item_name}** (${typeText})\n`;
            offersList += `💵 ${formatCurrency(offer.price_amount)} • 📦 ${offer.quantity}x • 👤 <@${offer.creator_id}>\n`;
            offersList += `🆔 ${offer.offer_id} • <t:${Math.floor(new Date(offer.created_at).getTime() / 1000)}:R>\n\n`;
        });

        if (offersList.length > 4000) {
            offersList = offersList.substring(0, 4000) + '...\n\n*Zu viele Angebote - zeige nur die ersten*';
        }

        embed.setDescription(`**${offers.length} Angebote verfügbar** • Reagiere mit 🤝 um Interesse zu zeigen\n\n${offersList}`);

        await interaction.followUp({ embeds: [embed] });

    } catch (error) {
        console.error('Show Offers Error:', error);
        await interaction.followUp(`❌ Fehler beim Abrufen der Angebote: ${error.message}`);
    }
}

// Error Handling
process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
    process.exit(1);
});

// Graceful Shutdown
process.on('SIGINT', async () => {
    console.log('🛑 Beende Anwendung...');
    await pool.end();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('🛑 SIGTERM erhalten...');
    await pool.end();
    process.exit(0);
});

// Health Check Server für Railway
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'healthy', 
            bot: client.isReady() ? 'online' : 'offline',
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
            activeTradeChannels: activeTradeChannels.size
        }));
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('GTA V Grand RP Strandmarkt Bot - Discord Bot läuft!');
    }
});

server.listen(PORT, () => {
    console.log(`🌐 Health Check Server läuft auf Port ${PORT}`);
});

// Bot Login
client.login(process.env.DISCORD_TOKEN);
