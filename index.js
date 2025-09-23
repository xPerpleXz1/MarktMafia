// Hilfsfunktionen
function hasTrustedDealerRole(member) {
    return member.roles.cache.some(role => role.name === TRUSTED_DEALER_ROLE);
}

// Create Offer Handler
async function handleCreateOffer(interaction) {
    const member = interaction.member;
    
    if (!hasTrustedDealerRole(member)) {
        return interaction.reply({
            content: '❌ Du benötigst die Rolle `TrustedDealer` um Angebote zu erstellen!',
            ephemeral: true
        });
    }

    const itemName = interaction.options.getString('gegenstand').trim();
    const quantity = interaction.options.getInteger('menge');
    const pricePerUnit = interaction.options.getNumber('preis-pro-stueck');
    const totalPrice = quantity * pricePerUnit;

    await interaction.deferReply();

    // Prüfe ob Artikel in Datenbank existiert
    db.get(
        'SELECT * FROM current_prices WHERE display_name = ? OR item_name = ?',
        [itemName, itemName.toLowerCase()],
        async (err, item) => {
            if (err) {
                console.error(err);
                return interaction.followUp('Fehler beim Prüfen des Artikels!');
            }

            if (!item) {
                return interaction.followUp(`❌ Artikel "${itemName}" nicht in der Datenbank gefunden! Füge ihn erst mit \`/preis-hinzufugen\` hinzu.`);
            }

            // Angebot in Datenbank speichern
            const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 Tage
            
            db.run(
                `INSERT INTO trade_offers (guild_id, channel_id, seller_id, seller_name, item_name, display_name, quantity, price_per_unit, total_price, expires_at) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [interaction.guildId, interaction.channelId, interaction.user.id, interaction.user.displayName, 
                 item.item_name, item.display_name, quantity, pricePerUnit, totalPrice, expiresAt.toISOString()],
                async function(err) {
                    if (err) {
                        console.error(err);
                        return interaction.followUp('Fehler beim Erstellen des Angebots!');
                    }

                    const offerId = this.lastID;
                    
                    // Schönes Angebot-Embed erstellen
                    const embed = new EmbedBuilder()
                        .setColor('#ff6600')
                        .setTitle('🛍️ Neues Handelsangebot')
                        .setThumbnail(item.image_url || null)
                        .addFields(
                            { name: '📦 Artikel', value: `**${item.display_name}**`, inline: true },
                            { name: '📊 Menge', value: `**${quantity} Stück**`, inline: true },
                            { name: '💰 Preis pro Stück', value: `**${formatCurrency(pricePerUnit)}**`, inline: true },
                            { name: '💵 Gesamtpreis', value: `**${formatCurrency(totalPrice)}**`, inline: true },
                            { name: '🏛️ Staatswert', value: item.state_value ? `${formatCurrency(item.state_value)}` : '*Nicht verfügbar*', inline: true },
                            { name: '👤 Verkäufer', value: `${interaction.user}`, inline: true },
                            { name: '⏰ Gültig bis', value: `<t:${Math.floor(expiresAt.getTime() / 1000)}:f>`, inline: false }
                        )
                        .setFooter({ text: `Angebot ID: ${offerId} • Reagiere mit ${OFFER_EMOJI} um zu handeln!` })
                        .setTimestamp();

                    // Gewinn-Info hinzufügen wenn Staatswert vorhanden
                    if (item.state_value) {
                        const profit = pricePerUnit - item.state_value;
                        const profitPercent = ((profit / item.state_value) * 100).toFixed(1);
                        const profitEmoji = profit > 0 ? '📈' : profit < 0 ? '📉' : '➡️';
                        
                        embed.addFields({
                            name: `${profitEmoji} Gewinn/Verlust vs Staat`,
                            value: `${formatCurrency(profit)} pro Stück (${profitPercent}%)`,
                            inline: false
                        });
                    }

                    const message = await interaction.followUp({ embeds: [embed] });
                    
                    // Emoji für Handel hinzufügen
                    await message.react(OFFER_EMOJI);
                    
                    // Message ID in Datenbank speichern
                    db.run('UPDATE trade_offers SET message_id = ? WHERE id = ?', [message.id, offerId]);
                }
            );
        }
    );
}

// Handle Trade Reaction
async function handleTradeReaction(reaction, user) {
    if (reaction.emoji.name !== OFFER_EMOJI) return;

    const message = reaction.message;
    
    // Prüfe ob es ein Handelsangebot ist
    db.get(
        'SELECT * FROM trade_offers WHERE message_id = ? AND status = "active"',
        [message.id],
        async (err, offer) => {
            if (err || !offer) return;

            // Verkäufer kann nicht auf eigenes Angebot reagieren
            if (user.id === offer.seller_id) {
                await reaction.users.remove(user.id);
                return;
            }

            const guild = client.guilds.cache.get(offer.guild_id);
            if (!guild) return;

            const buyer = await guild.members.fetch(user.id);
            const seller = await guild.members.fetch(offer.seller_id);

            // Prüfe ob Buyer die TrustedDealer Rolle hat
            if (!hasTrustedDealerRole(buyer)) {
                await reaction.users.remove(user.id);
                const dmEmbed = new EmbedBuilder()
                    .setColor('#ff0000')
                    .setTitle('❌ Berechtigung fehlt')
                    .setDescription('Du benötigst die Rolle `TrustedDealer` um zu handeln!')
                    .setTimestamp();
                
                try {
                    await user.send({ embeds: [dmEmbed] });
                } catch (error) {
                    console.log('Konnte DM nicht senden');
                }
                return;
            }

            // Prüfe ob bereits ein Handelschat für dieses Angebot existiert
            db.get(
                'SELECT * FROM active_trades WHERE offer_id = ? AND buyer_id = ?',
                [offer.id, user.id],
                async (err, existingTrade) => {
                    if (existingTrade) {
                        await reaction.users.remove(user.id);
                        return;
                    }

                    // Erstelle privaten Handelschat
                    try {
                        const tradeChannel = await guild.channels.create({
                            name: `handel-${offer.display_name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${Date.now()}`,
                            type: ChannelType.GuildText,
                            permissionOverwrites: [
                                {
                                    id: guild.roles.everyone,
                                    deny: [PermissionFlagsBits.ViewChannel]
                                },
                                {
                                    id: seller.id,
                                    allow: [
                                        PermissionFlagsBits.ViewChannel,
                                        PermissionFlagsBits.SendMessages,
                                        PermissionFlagsBits.AddReactions
                                    ]
                                },
                                {
                                    id: buyer.id,
                                    allow: [
                                        PermissionFlagsBits.ViewChannel,
                                        PermissionFlagsBits.SendMessages,
                                        PermissionFlagsBits.AddReactions
                                    ]
                                }
                            ]
                        });

                        // Handelschat in Datenbank speichern
                        db.run(
                            'INSERT INTO active_trades (offer_id, trade_channel_id, seller_id, buyer_id) VALUES (?, ?, ?, ?)',
                            [offer.id, tradeChannel.id, offer.seller_id, user.id]
                        );

                        // Willkommensnachricht im Handelschat
                        const tradeEmbed = new EmbedBuilder()
                            .setColor('#00ff00')
                            .setTitle('🤝 Handelschat eröffnet')
                            .setDescription('**Hier könnt ihr euren Handel abwickeln!**')
                            .addFields(
                                { name: '📦 Artikel', value: offer.display_name, inline: true },
                                { name: '📊 Menge', value: `${offer.quantity} Stück`, inline: true },
                                { name: '💰 Gesamtpreis', value: formatCurrency(offer.total_price), inline: true },
                                { name: '👤 Verkäufer', value: `<@${offer.seller_id}>`, inline: true },
                                { name: '🛒 Käufer', value: `<@${user.id}>`, inline: true },
                                { name: '📋 Nächste Schritte', value: '1. Besprecht die Details\n2. Beide reagieren mit ✅ wenn Handel abgeschlossen\n3. Beide reagieren mit ❌ um Chat zu schließen', inline: false }
                            )
                            .setFooter({ text: 'Beide Parteien müssen mit ❌ reagieren um den Chat zu schließen' })
                            .setTimestamp();

                        const tradeMessage = await tradeChannel.send({ 
                            content: `${seller} ${buyer}`, 
                            embeds: [tradeEmbed] 
                        });

                        await tradeMessage.react(CONFIRM_EMOJI);
                        await tradeMessage.react(CLOSE_EMOJI);

                    } catch (error) {
                        console.error('Fehler beim Erstellen des Handelschats:', error);
                    }
                }
            );
        }
    );
}

// Handle Channel Close
async function handleChannelClose(reaction, user) {
    if (reaction.emoji.name !== CLOSE_EMOJI && reaction.emoji.name !== CONFIRM_EMOJI) return;

    const channel = reaction.message.channel;
    
    // Prüfe ob es ein aktiver Handelschat ist
    db.get(
        'SELECT * FROM active_trades WHERE trade_channel_id = ?',
        [channel.id],
        async (err, trade) => {
            if (err || !trade) return;

            // Nur Seller oder Buyer können reagieren
            if (user.id !== trade.seller_id && user.id !== trade.buyer_id) {
                await reaction.users.remove(user.id);
                return;
            }

            if (reaction.emoji.name === CONFIRM_EMOJI) {
                // Bestätigung für abgeschlossenen Handel
                if (user.id === trade.seller_id) {
                    db.run('UPDATE active_trades SET seller_confirmed = 1 WHERE id = ?', [trade.id]);
                } else {
                    db.run('UPDATE active_trades SET buyer_confirmed = 1 WHERE id = ?', [trade.id]);
                }

                // Prüfe ob beide bestätigt haben
                db.get('SELECT * FROM active_trades WHERE id = ?', [trade.id], async (err, updatedTrade) => {
                    if (updatedTrade && updatedTrade.seller_confirmed && updatedTrade.buyer_confirmed) {
                        const successEmbed = new EmbedBuilder()
                            .setColor('#00ff00')
                            .setTitle('✅ Handel erfolgreich abgeschlossen!')
                            .setDescription('Beide Parteien haben den Handel bestätigt.')
                            .addFields({ name: 'Status', value: '**Handel abgeschlossen** - Channel wird in 30 Sekunden gelöscht' })
                            .setTimestamp();

                        await channel.send({ embeds: [successEmbed] });

                        // Angebot als verkauft markieren
                        db.run('UPDATE trade_offers SET status = "sold" WHERE id = ?', [trade.offer_id]);

                        // Channel nach 30 Sekunden löschen
                        setTimeout(async () => {
                            try {
                                await channel.delete();
                                db.run('DELETE FROM active_trades WHERE id = ?', [trade.id]);
                            } catch (error) {
                                console.error('Fehler beim Löschen des Channels:', error);
                            }
                        }, 30000);
                    }
                });

            } else if (reaction.emoji.name === CLOSE_EMOJI) {
                // Channel schließen
                const reactions = reaction.message.reactions.cache.get(CLOSE_EMOJI);
                const users = await reactions.users.fetch();
                
                const sellerReacted = users.has(trade.seller_id);
                const buyerReacted = users.has(trade.buyer_id);

                if (sellerReacted && buyerReacted) {
                    const closeEmbed = new EmbedBuilder()
                        .setColor('#ff9900')
                        .setTitle('🔒 Handelschat wird geschlossen')
                        .setDescription('Beide Parteien haben das Schließen bestätigt.')
                        .addFields({ name: 'Status', value: '**Chat wird in 10 Sekunden gelöscht**' })
                        .setTimestamp();

                    await channel.send({ embeds: [closeEmbed] });

                    setTimeout(async () => {
                        try {
                            await channel.delete();
                            db.run('DELETE FROM active_trades WHERE id = ?', [trade.id]);
                        } catch (error) {
                            console.error('Fehler beim Löschen des Channels:', error);
                        }
                    }, 10000);
                }
            }
        }
    );
}

// My Offers Handler
async function handleMyOffers(interaction) {
    await interaction.deferReply({ ephemeral: true });

    db.all(
        'SELECT * FROM trade_offers WHERE seller_id = ? AND status = "active" ORDER BY created_at DESC',
        [interaction.user.id],
        (err, offers) => {
            if (err) {
                console.error(err);
                return interaction.followUp('Fehler beim Laden deiner Angebote!');
            }

            if (offers.length === 0) {
                return interaction.followUp('Du hast keine aktiven Angebote.');
            }

            const embed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle('📋 Deine aktiven Angebote')
                .setDescription(`Du hast **${offers.length}** aktive Angebote`)
                .setTimestamp();

            offers.forEach((offer, index) => {
                const createdAt = Math.floor(new Date(offer.created_at).getTime() / 1000);
                const expiresAt = Math.floor(new Date(offer.expires_at).getTime() / 1000);
                
                embed.addFields({
                    name: `${index + 1}. ${offer.display_name}`,
                    value: `💰 ${formatCurrency(offer.price_per_unit)} × ${offer.quantity} = **${formatCurrency(offer.total_price)}**\n📅 <t:${createdAt}:R> | ⏰ <t:${expiresAt}:R>`,
                    inline: false
                });
            });

            interaction.followUp({ embeds: [embed] });
        }
    );
}

// All Offers Handler  
async function handleAllOffers(interaction) {
    await interaction.deferReply();

    db.all(
        'SELECT * FROM trade_offers WHERE status = "active" AND expires_at > datetime("now") ORDER BY created_at DESC LIMIT 20',
        (err, offers) => {
            if (err) {
                console.error(err);
                return interaction.followUp('Fehler beim Laden der Angebote!');
            }

            if (offers.length === 0) {
                return interaction.followUp('Keine aktiven Angebote verfügbar.');
            }

            const embed = new EmbedBuilder()
                .setColor('#ff6600')
                .setTitle('🛍️ Alle aktiven Handelsangebote')
                .setDescription(`**${offers.length}** aktive Angebote verfügbar`)
                .setFooter({ text: `Reagiere mit ${OFFER_EMOJI} auf ein Angebot um zu handeln!` })
                .setTimestamp();

            offers.slice(0, 10).forEach((offer, index) => {
                const createdAt = Math.floor(new Date(offer.created_at).getTime() / 1000);
                
                embed.addFields({
                    name: `${index + 1}. ${offer.display_name} (${offer.quantity}×)`,
                    value: `💰 ${formatCurrency(offer.price_per_unit)} pro Stück = **${formatCurrency(offer.total_price)}**\n👤 ${offer.seller_name} • <t:${createdAt}:R>`,
                    inline: true
                });
            });

            if (offers.length > 10) {
                embed.addFields({
                    name: 'ℹ️ Hinweis',
                    value: `Nur die ersten 10 Angebote werden angezeigt. Insgesamt ${offers.length} verfügbar.`,
                    inline: false
                });
            }

            interaction.followUp({ embeds: [embed] });
        }
    );
}// Average Price Handler
async function handleAveragePrice(interaction) {
    const searchName = interaction.options.getString('gegenstand').trim();

    await interaction.deferReply();

    db.all(
        'SELECT market_price as price, state_value FROM price_history WHERE display_name = ? OR item_name = ?',
        [searchName, searchName.toLowerCase()],
        (err, rows) => {
            if (err) {
                console.error(err);
                interaction.followUp('Fehler beim Berechnen des Durchschnitts!');
                return;
            }

            if (rows.length === 0) {
                interaction.followUp(`❌ Keine Daten für "${searchName}" gefunden!`);
                return;
            }

            const marketPrices = rows.map(row => row.price);
            const statePrices = rows.filter(row => row.state_value).map(row => row.state_value);
            
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

            // Staatswert-Statistiken hinzufügen wenn verfügbar
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

            interaction.followUp({ embeds: [embed] });
        }
    );
}const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');

// Bot Setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions
    ]
});

// Konfiguration
const TRUSTED_DEALER_ROLE = 'TrustedDealer';
const OFFER_EMOJI = '💰';
const CLOSE_EMOJI = '❌';
const CONFIRM_EMOJI = '✅';

// Database Setup
const db = new sqlite3.Database('./strandmarkt.db');

// Initialize Database
db.serialize(() => {
    // Tabelle für aktuelle Preise
    db.run(`CREATE TABLE IF NOT EXISTS current_prices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_name TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        market_price REAL NOT NULL,
        state_value REAL,
        image_url TEXT,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_by TEXT NOT NULL
    )`);

    // Tabelle für Preishistorie
    db.run(`CREATE TABLE IF NOT EXISTS price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        market_price REAL NOT NULL,
        state_value REAL,
        image_url TEXT,
        date_added DATETIME DEFAULT CURRENT_TIMESTAMP,
        added_by TEXT NOT NULL
    )`);

    // Tabelle für Handelsangebote
    db.run(`CREATE TABLE IF NOT EXISTS trade_offers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT UNIQUE NOT NULL,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        seller_id TEXT NOT NULL,
        seller_name TEXT NOT NULL,
        item_name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        price_per_unit REAL NOT NULL,
        total_price REAL NOT NULL,
        status TEXT DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME
    )`);

    // Tabelle für aktive Handelschats
    db.run(`CREATE TABLE IF NOT EXISTS active_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        offer_id INTEGER NOT NULL,
        trade_channel_id TEXT NOT NULL,
        seller_id TEXT NOT NULL,
        buyer_id TEXT NOT NULL,
        seller_confirmed INTEGER DEFAULT 0,
        buyer_confirmed INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (offer_id) REFERENCES trade_offers (id)
    )`);

    // Migration für bestehende Datenbanken (falls jemand von alter Version kommt)
    db.all("PRAGMA table_info(current_prices)", (err, columns) => {
        if (!err && columns) {
            const hasDisplayName = columns.some(col => col.name === 'display_name');
            const hasMarketPrice = columns.some(col => col.name === 'market_price');
            const hasStateValue = columns.some(col => col.name === 'state_value');
            
            if (!hasDisplayName || !hasMarketPrice || !hasStateValue) {
                console.log('🔄 Migriere alte Datenbank...');
                
                // Backup der alten Tabelle
                db.run(`CREATE TABLE IF NOT EXISTS current_prices_backup AS SELECT * FROM current_prices`);
                
                // Neue Spalten hinzufügen falls sie nicht existieren
                if (!hasDisplayName) {
                    db.run(`ALTER TABLE current_prices ADD COLUMN display_name TEXT DEFAULT ''`);
                    db.run(`UPDATE current_prices SET display_name = item_name WHERE display_name = ''`);
                }
                if (!hasMarketPrice && !hasStateValue) {
                    db.run(`ALTER TABLE current_prices ADD COLUMN market_price REAL DEFAULT 0`);
                    db.run(`ALTER TABLE current_prices ADD COLUMN state_value REAL DEFAULT NULL`);
                    db.run(`UPDATE current_prices SET market_price = price WHERE market_price = 0`);
                }
                
                console.log('✅ Datenbank-Migration abgeschlossen!');
            }
        }
    });

    // Migration für Historie-Tabelle
    db.all("PRAGMA table_info(price_history)", (err, columns) => {
        if (!err && columns) {
            const hasDisplayName = columns.some(col => col.name === 'display_name');
            const hasMarketPrice = columns.some(col => col.name === 'market_price');
            
            if (!hasDisplayName || !hasMarketPrice) {
                console.log('🔄 Migriere Historie-Tabelle...');
                
                if (!hasDisplayName) {
                    db.run(`ALTER TABLE price_history ADD COLUMN display_name TEXT DEFAULT ''`);
                    db.run(`UPDATE price_history SET display_name = item_name WHERE display_name = ''`);
                }
                if (!hasMarketPrice) {
                    db.run(`ALTER TABLE price_history ADD COLUMN market_price REAL DEFAULT 0`);
                    db.run(`ALTER TABLE price_history ADD COLUMN state_value REAL DEFAULT NULL`);
                    db.run(`UPDATE price_history SET market_price = price WHERE market_price = 0`);
                }
                
                console.log('✅ Historie-Migration abgeschlossen!');
            }
        }
    });
});

// Chart Configuration
const width = 800;
const height = 400;
const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height });

// Hilfsfunktion für Geld-Formatierung
function formatCurrency(amount) {
    return new Intl.NumberFormat('de-DE', {
        style: 'currency',
        currency: 'EUR',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    }).format(amount);
}

// Bot Events
client.once('ready', () => {
    console.log(`Bot ist online als ${client.user.tag}!`);
    registerCommands();
    setupBackupSchedule();
});

// Automatisches Backup um 4 Uhr nachts
function setupBackupSchedule() {
    // Jeden Tag um 4:00 Uhr
    cron.schedule('0 4 * * *', () => {
        createBackup();
    }, {
        scheduled: true,
        timezone: "Europe/Berlin"
    });
    
    console.log('📅 Backup-Schedule aktiviert: Täglich um 4:00 Uhr');
}

// Backup-Funktion
async function createBackup() {
    try {
        const timestamp = new Date().toISOString().split('T')[0];
        const backupPath = `./backup_${timestamp}.db`;
        const oldBackupPath = `./backup_${getPreviousDay()}.db`;
        
        // Aktuelles Backup erstellen
        await new Promise((resolve, reject) => {
            const source = fs.createReadStream('./strandmarkt.db');
            const dest = fs.createWriteStream(backupPath);
            
            source.pipe(dest);
            source.on('end', resolve);
            source.on('error', reject);
        });
        
        // Altes Backup löschen (falls vorhanden)
        if (fs.existsSync(oldBackupPath)) {
            fs.unlinkSync(oldBackupPath);
            console.log(`🗑️ Altes Backup gelöscht: ${oldBackupPath}`);
        }
        
        console.log(`✅ Backup erstellt: ${backupPath}`);
        
        // Optional: Backup-Info in einen Log-Channel senden
        const guilds = client.guilds.cache;
        guilds.forEach(guild => {
            const logChannel = guild.channels.cache.find(ch => ch.name === 'bot-logs');
            if (logChannel) {
                const embed = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('📊 Automatisches Backup erstellt')
                    .setDescription(`Datenbank-Backup wurde erfolgreich erstellt`)
                    .addFields(
                        { name: '📅 Datum', value: timestamp, inline: true },
                        { name: '📁 Datei', value: `backup_${timestamp}.db`, inline: true }
                    )
                    .setTimestamp();
                
                logChannel.send({ embeds: [embed] });
            }
        });
        
    } catch (error) {
        console.error('❌ Backup-Fehler:', error);
    }
}

function getPreviousDay() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday.toISOString().split('T')[0];
}

// Register Slash Commands
async function registerCommands() {
    const commands = [
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
            .addStringOption(option =>
                option.setName('bild')
                    .setDescription('URL zum Bild (optional)')
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
            .setName('angebot-erstellen')
            .setDescription('Erstelle ein Handelsangebot (nur für TrustedDealer)')
            .addStringOption(option =>
                option.setName('gegenstand')
                    .setDescription('Artikel aus der Datenbank')
                    .setRequired(true)
                    .setAutocomplete(true))
            .addIntegerOption(option =>
                option.setName('menge')
                    .setDescription('Anzahl der Artikel')
                    .setRequired(true)
                    .setMinValue(1))
            .addNumberOption(option =>
                option.setName('preis-pro-stueck')
                    .setDescription('Preis pro Stück')
                    .setRequired(true)
                    .setMinValue(1)),

        new SlashCommandBuilder()
            .setName('meine-angebote')
            .setDescription('Zeige deine aktiven Angebote')
            .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages),

        new SlashCommandBuilder()
            .setName('alle-angebote')
            .setDescription('Zeige alle aktiven Handelsangebote')
            .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages)
    ];

    try {
        console.log('Registriere Slash Commands...');
        await client.application.commands.set(commands);
        console.log('Slash Commands erfolgreich registriert!');
    } catch (error) {
        console.error('Fehler beim Registrieren der Commands:', error);
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
                case 'angebot-erstellen':
                    await handleCreateOffer(interaction);
                    break;
                case 'meine-angebote':
                    await handleMyOffers(interaction);
                    break;
                case 'alle-angebote':
                    await handleAllOffers(interaction);
                    break;
            }
        } catch (error) {
            console.error('Command Error:', error);
            const errorMessage = { content: 'Es ist ein Fehler aufgetreten!', ephemeral: true };
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(errorMessage);
            } else {
                await interaction.reply(errorMessage);
            }
        }
    } else if (interaction.isAutocomplete()) {
        await handleAutocomplete(interaction);
    }
});

// Reaction Handler für Handelsangebote
client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;
    
    try {
        await handleTradeReaction(reaction, user, 'add');
    } catch (error) {
        console.error('Reaction Error:', error);
    }
});

// Channel-Close Handler
client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;
    
    try {
        await handleChannelClose(reaction, user);
    } catch (error) {
        console.error('Channel Close Error:', error);
    }
});

// Autocomplete Handler
async function handleAutocomplete(interaction) {
    const focusedValue = interaction.options.getFocused();
    
    db.all(
        'SELECT DISTINCT display_name, item_name FROM current_prices WHERE display_name LIKE ? OR item_name LIKE ? ORDER BY display_name LIMIT 25',
        [`%${focusedValue}%`, `%${focusedValue.toLowerCase()}%`],
        (err, rows) => {
            if (err) {
                console.error(err);
                return interaction.respond([]);
            }

            const choices = rows.map(row => ({
                name: row.display_name,
                value: row.display_name
            }));

            interaction.respond(choices);
        }
    );
}

// Add Price Handler
async function handleAddPrice(interaction) {
    const displayName = interaction.options.getString('gegenstand').trim();
    const itemName = displayName.toLowerCase();
    const marketPrice = interaction.options.getNumber('marktpreis');
    const stateValue = interaction.options.getNumber('staatswert');
    const imageUrl = interaction.options.getString('bild');
    const userId = interaction.user.tag;

    await interaction.deferReply();

    // Zur Historie hinzufügen
    db.run(
        'INSERT INTO price_history (item_name, display_name, market_price, state_value, image_url, added_by) VALUES (?, ?, ?, ?, ?, ?)',
        [itemName, displayName, marketPrice, stateValue, imageUrl, userId]
    );

    // Aktuellen Preis aktualisieren oder hinzufügen - ohne bestehende Werte zu überschreiben
    db.get('SELECT * FROM current_prices WHERE item_name = ?', [itemName], (err, existingRow) => {
        if (err) {
            console.error(err);
            interaction.followUp('Fehler beim Prüfen bestehender Daten!');
            return;
        }

        // Bestimme finale Werte - behalte alte Werte wenn neue nicht angegeben
        let finalStateValue = stateValue;
        let finalImageUrl = imageUrl;

        if (existingRow) {
            // Behalte alte Werte wenn keine neuen angegeben wurden
            if (stateValue === null && existingRow.state_value !== null) {
                finalStateValue = existingRow.state_value;
            }
            if (!imageUrl && existingRow.image_url) {
                finalImageUrl = existingRow.image_url;
            }
        }

        db.run(
            `INSERT OR REPLACE INTO current_prices (item_name, display_name, market_price, state_value, image_url, updated_by, last_updated)
             VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [itemName, displayName, marketPrice, finalStateValue, finalImageUrl, userId],
            function(err) {
                if (err) {
                    console.error(err);
                    interaction.followUp('Fehler beim Speichern des Preises!');
                    return;
                }

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

                // Status-Info hinzufügen
                let statusInfo = '🆕 Neuer Eintrag erstellt';
                if (existingRow) {
                    statusInfo = '🔄 Bestehender Eintrag aktualisiert';
                    if (finalStateValue !== stateValue && stateValue === null) {
                        statusInfo += ' (Staatswert beibehalten)';
                    }
                    if (finalImageUrl !== imageUrl && !imageUrl) {
                        statusInfo += ' (Bild beibehalten)';
                    }
                }

                embed.addFields({ name: 'ℹ️ Status', value: statusInfo, inline: false });

                // Gewinnberechnung wenn beide Preise vorhanden
                if (finalStateValue && finalStateValue > 0) {
                    const profit = marketPrice - finalStateValue;
                    const profitPercent = ((profit / finalStateValue) * 100).toFixed(1);
                    const profitColor = profit > 0 ? '📈' : '📉';
                    
                    embed.addFields({
                        name: `${profitColor} Gewinn/Verlust`,
                        value: `**${formatCurrency(profit)}** (${profitPercent}%)`,
                        inline: false
                    });
                }

                if (finalImageUrl) {
                    embed.setThumbnail(finalImageUrl);
                }

                interaction.followUp({ embeds: [embed] });
            }
        );
    });
}

// Show Price Handler
async function handleShowPrice(interaction) {
    const searchName = interaction.options.getString('gegenstand').trim();

    await interaction.deferReply();

    // Suche sowohl nach display_name als auch item_name
    db.get(
        'SELECT * FROM current_prices WHERE display_name = ? OR item_name = ?',
        [searchName, searchName.toLowerCase()],
        (err, row) => {
            if (err) {
                console.error(err);
                interaction.followUp('Fehler beim Abrufen des Preises!');
                return;
            }

            if (!row) {
                interaction.followUp(`❌ Kein Preis für "${searchName}" gefunden!`);
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

            // Gewinnberechnung wenn beide Preise vorhanden
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

            if (row.image_url) {
                embed.setThumbnail(row.image_url);
            }

            interaction.followUp({ embeds: [embed] });
        }
    );
}

// Show All Prices Handler
async function handleShowAllPrices(interaction) {
    await interaction.deferReply();

    db.all(
        'SELECT * FROM current_prices ORDER BY item_name',
        (err, rows) => {
            if (err) {
                console.error(err);
                interaction.followUp('Fehler beim Abrufen der Preise!');
                return;
            }

            if (rows.length === 0) {
                interaction.followUp('❌ Keine Preise in der Datenbank gefunden!');
                return;
            }

            const embed = new EmbedBuilder()
                .setColor('#ff9900')
                .setTitle('📋 Alle Strandmarktpreise')
                .setDescription(`**${rows.length} Artikel verfügbar**`)
                .setFooter({ text: 'GTA V Grand RP • Strandmarkt Bot' })
                .setTimestamp();

            // Sortiere nach Marktpreis (höchster zuerst)
            rows.sort((a, b) => b.market_price - a.market_price);

            // Erstelle schönere Anzeige in Spalten
            let itemList = '';
            rows.forEach((row, index) => {
                const emoji = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '📦';
                itemList += `${emoji} **${row.display_name}**\n`;
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

            embed.setDescription(`**${rows.length} Artikel verfügbar**\n\n${itemList}`);

            interaction.followUp({ embeds: [embed] });
        }
    );
}

// Price History Handler with Chart
async function handlePriceHistory(interaction) {
    const searchName = interaction.options.getString('gegenstand').trim();

    await interaction.deferReply();

    // Suche in Historie sowohl nach display_name als auch item_name
    db.all(
        'SELECT market_price as price, state_value, date_added FROM price_history WHERE display_name = ? OR item_name = ? ORDER BY date_added',
        [searchName, searchName.toLowerCase()],
        async (err, rows) => {
            if (err) {
                console.error(err);
                interaction.followUp('Fehler beim Abrufen der Historie!');
                return;
            }

            if (rows.length === 0) {
                interaction.followUp(`❌ Keine Historie für "${searchName}" gefunden!`);
                return;
            }

            // Chart erstellen
            const labels = rows.map(row => new Date(row.date_added).toLocaleDateString('de-DE'));
            const marketPrices = rows.map(row => row.price);
            const statePrices = rows.map(row => row.state_value || null);

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

            // Staatswert-Linie hinzufügen wenn Daten vorhanden
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
                data: {
                    labels: labels,
                    datasets: datasets
                },
                options: {
                    responsive: true,
                    plugins: {
                        title: {
                            display: true,
                            text: `📈 Preisverlauf: ${searchName}`,
                            font: { size: 16, weight: 'bold' }
                        },
                        legend: {
                            display: hasStateValues,
                            position: 'top'
                        }
                    },
                    scales: {
                        y: {
                            beginAtZero: false,
                            title: {
                                display: true,
                                text: 'Preis (€)',
                                font: { size: 14, weight: 'bold' }
                            },
                            ticks: {
                                callback: function(value) {
                                    return new Intl.NumberFormat('de-DE', {
                                        style: 'currency',
                                        currency: 'EUR',
                                        minimumFractionDigits: 0
                                    }).format(value);
                                }
                            }
                        },
                        x: {
                            title: {
                                display: true,
                                text: 'Datum',
                                font: { size: 14, weight: 'bold' }
                            }
                        }
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

                interaction.followUp({ embeds: [embed], files: [attachment] });
            } catch (chartError) {
                console.error('Chart Error:', chartError);
                
                // Fallback: Text-basierte Anzeige
                const embed = new EmbedBuilder()
                    .setColor('#ff6600')
                    .setTitle(`📈 Preisverlauf: ${searchName}`)
                    .setDescription('⚠️ Diagramm konnte nicht erstellt werden. Hier die letzten 10 Einträge:')
                    .setFooter({ text: 'GTA V Grand RP • Strandmarkt Bot' })
                    .setTimestamp();

                const lastEntries = rows.slice(-10);
                let priceHistory = '';
                lastEntries.forEach((row, index) => {
                    const date = new Date(row.date_added);
                    const timestamp = Math.floor(date.getTime() / 1000);
                    priceHistory += `**${formatCurrency(row.price)}**`;
                    if (row.state_value) {
                        priceHistory += ` (🏛️ ${formatCurrency(row.state_value)})`;
                    }
                    priceHistory += ` • <t:${timestamp}:R>\n`;
                });

                embed.setDescription(`⚠️ Diagramm konnte nicht erstellt werden.\n\n**Letzte ${lastEntries.length} Einträge:**\n${priceHistory}`);

                interaction.followUp({ embeds: [embed] });
            }
        }
    );
}

// Average Price Handler
async function handleAveragePrice(interaction) {
    const itemName = interaction.options.getString('gegenstand').toLowerCase();

    await interaction.deferReply();

    db.all(
        'SELECT price FROM price_history WHERE item_name = ?',
        [itemName],
        (err, rows) => {
            if (err) {
                console.error(err);
                interaction.followUp('Fehler beim Berechnen des Durchschnitts!');
                return;
            }

            if (rows.length === 0) {
                interaction.followUp(`❌ Keine Daten für "${itemName}" gefunden!`);
                return;
            }

            const prices = rows.map(row => row.price);
            const average = prices.reduce((sum, price) => sum + price, 0) / prices.length;
            const minPrice = Math.min(...prices);
            const maxPrice = Math.max(...prices);

            const embed = new EmbedBuilder()
                .setColor('#9900ff')
                .setTitle(`📊 Statistiken: ${itemName}`)
                .setDescription(`**Basierend auf ${rows.length} Preiseinträgen**`)
                .addFields(
                    { name: '💰 Durchschnittspreis', value: `**${formatCurrency(average)}**`, inline: true },
                    { name: '📉 Niedrigster Preis', value: `**${formatCurrency(minPrice)}**`, inline: true },
                    { name: '📈 Höchster Preis', value: `**${formatCurrency(maxPrice)}**`, inline: true },
                    { name: '📊 Preisdifferenz', value: `**${formatCurrency(maxPrice - minPrice)}**`, inline: true },
                    { name: '📈 Varianz', value: `${((maxPrice - minPrice) / average * 100).toFixed(1)}%`, inline: true },
                    { name: '📋 Gesamte Einträge', value: `**${rows.length}**`, inline: true }
                )
                .setFooter({ text: 'GTA V Grand RP • Strandmarkt Bot' })
                .setTimestamp();

            interaction.followUp({ embeds: [embed] });
        }
    );
}

// Error Handling
process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

// Login
client.login(process.env.DISCORD_TOKEN);
