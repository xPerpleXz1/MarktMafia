const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Bot Setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Database Setup
const db = new sqlite3.Database('./strandmarkt.db');

// Initialize Database
db.serialize(() => {
    // Tabelle für aktuelle Preise
    db.run(`CREATE TABLE IF NOT EXISTS current_prices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_name TEXT UNIQUE NOT NULL,
        price REAL NOT NULL,
        image_url TEXT,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_by TEXT NOT NULL
    )`);

    // Tabelle für Preishistorie
    db.run(`CREATE TABLE IF NOT EXISTS price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_name TEXT NOT NULL,
        price REAL NOT NULL,
        image_url TEXT,
        date_added DATETIME DEFAULT CURRENT_TIMESTAMP,
        added_by TEXT NOT NULL
    )`);
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
});

// Register Slash Commands
async function registerCommands() {
    const commands = [
        new SlashCommandBuilder()
            .setName('preis-hinzufugen')
            .setDescription('Füge einen neuen Strandmarktpreis hinzu')
            .addStringOption(option =>
                option.setName('gegenstand')
                    .setDescription('Name des Gegenstands')
                    .setRequired(true)
                    .setAutocomplete(true))
            .addNumberOption(option =>
                option.setName('preis')
                    .setDescription('Preis des Gegenstands')
                    .setRequired(true))
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
                    .setAutocomplete(true))
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
            }
        } catch (error) {
            console.error('Command Error:', error);
            await interaction.reply({
                content: 'Es ist ein Fehler aufgetreten!',
                ephemeral: true
            });
        }
    } else if (interaction.isAutocomplete()) {
        await handleAutocomplete(interaction);
    }
});

// Autocomplete Handler
async function handleAutocomplete(interaction) {
    const focusedValue = interaction.options.getFocused();
    
    db.all(
        'SELECT DISTINCT item_name FROM current_prices WHERE item_name LIKE ? ORDER BY item_name LIMIT 25',
        [`%${focusedValue}%`],
        (err, rows) => {
            if (err) {
                console.error(err);
                return interaction.respond([]);
            }

            const choices = rows.map(row => ({
                name: row.item_name,
                value: row.item_name
            }));

            interaction.respond(choices);
        }
    );
}

// Add Price Handler
async function handleAddPrice(interaction) {
    const itemName = interaction.options.getString('gegenstand').toLowerCase();
    const price = interaction.options.getNumber('preis');
    const imageUrl = interaction.options.getString('bild');
    const userId = interaction.user.tag;

    await interaction.deferReply();

    // Zur Historie hinzufügen
    db.run(
        'INSERT INTO price_history (item_name, price, image_url, added_by) VALUES (?, ?, ?, ?)',
        [itemName, price, imageUrl, userId]
    );

    // Aktuellen Preis aktualisieren oder hinzufügen
    db.run(
        `INSERT OR REPLACE INTO current_prices (item_name, price, image_url, updated_by, last_updated)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [itemName, price, imageUrl, userId],
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
                    { name: '📦 Gegenstand', value: `\`${itemName}\``, inline: true },
                    { name: '💰 Neuer Preis', value: `**${formatCurrency(price)}**`, inline: true },
                    { name: '👤 Aktualisiert von', value: userId, inline: true },
                    { name: '🕐 Zeitpunkt', value: `<t:${Math.floor(Date.now() / 1000)}:f>`, inline: false }
                )
                .setFooter({ text: 'GTA V Grand RP • Strandmarkt Bot' })
                .setTimestamp();

            if (imageUrl) {
                embed.setThumbnail(imageUrl);
            }

            interaction.followUp({ embeds: [embed] });
        }
    );
}

// Show Price Handler
async function handleShowPrice(interaction) {
    const itemName = interaction.options.getString('gegenstand').toLowerCase();

    await interaction.deferReply();

    db.get(
        'SELECT * FROM current_prices WHERE item_name = ?',
        [itemName],
        (err, row) => {
            if (err) {
                console.error(err);
                interaction.followUp('Fehler beim Abrufen des Preises!');
                return;
            }

            if (!row) {
                interaction.followUp(`❌ Kein Preis für "${itemName}" gefunden!`);
                return;
            }

            const embed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle(`💰 ${row.item_name}`)
                .setDescription(`**Aktueller Strandmarktpreis**`)
                .addFields(
                    { name: '💵 Preis', value: `**${formatCurrency(row.price)}**`, inline: true },
                    { name: '📅 Letzte Aktualisierung', value: `<t:${Math.floor(new Date(row.last_updated).getTime() / 1000)}:R>`, inline: true },
                    { name: '👤 Von', value: `${row.updated_by}`, inline: true }
                )
                .setFooter({ text: 'GTA V Grand RP • Strandmarkt Bot' })
                .setTimestamp();

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

            // Sortiere nach Preis (höchster zuerst)
            rows.sort((a, b) => b.price - a.price);

            // Erstelle schönere Anzeige in Spalten
            let itemList = '';
            rows.forEach((row, index) => {
                const emoji = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '📦';
                itemList += `${emoji} **${row.item_name}**\n`;
                itemList += `💰 ${formatCurrency(row.price)} • <t:${Math.floor(new Date(row.last_updated).getTime() / 1000)}:R>\n\n`;
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
    const itemName = interaction.options.getString('gegenstand').toLowerCase();

    await interaction.deferReply();

    db.all(
        'SELECT price, date_added FROM price_history WHERE item_name = ? ORDER BY date_added',
        [itemName],
        async (err, rows) => {
            if (err) {
                console.error(err);
                interaction.followUp('Fehler beim Abrufen der Historie!');
                return;
            }

            if (rows.length === 0) {
                interaction.followUp(`❌ Keine Historie für "${itemName}" gefunden!`);
                return;
            }

            // Chart erstellen
            const labels = rows.map(row => new Date(row.date_added).toLocaleDateString('de-DE'));
            const prices = rows.map(row => row.price);

            const configuration = {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [{
                        label: `${itemName} Preisverlauf`,
                        data: prices,
                        borderColor: '#ff6600',
                        backgroundColor: 'rgba(255, 102, 0, 0.1)',
                        tension: 0.3,
                        fill: true,
                        pointRadius: 6,
                        pointHoverRadius: 8,
                        borderWidth: 3
                    }]
                },
                options: {
                    responsive: true,
                    plugins: {
                        title: {
                            display: true,
                            text: `📈 Preisverlauf: ${itemName}`,
                            font: { size: 16, weight: 'bold' }
                        },
                        legend: {
                            display: false
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
                    .setTitle(`📈 Preisverlauf: ${itemName}`)
                    .setDescription(`**${rows.length} Preiseinträge** • Diagramm zeigt die Entwicklung`)
                    .addFields(
                        { name: '📊 Aktueller Preis', value: `${formatCurrency(prices[prices.length - 1])}`, inline: true },
                        { name: '📈 Höchster Preis', value: `${formatCurrency(Math.max(...prices))}`, inline: true },
                        { name: '📉 Niedrigster Preis', value: `${formatCurrency(Math.min(...prices))}`, inline: true }
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
                    .setTitle(`📈 Preisverlauf: ${itemName}`)
                    .setDescription('⚠️ Diagramm konnte nicht erstellt werden. Hier die letzten 10 Einträge:')
                    .setFooter({ text: 'GTA V Grand RP • Strandmarkt Bot' })
                    .setTimestamp();

                const lastEntries = rows.slice(-10);
                let priceHistory = '';
                lastEntries.forEach((row, index) => {
                    const date = new Date(row.date_added);
                    const timestamp = Math.floor(date.getTime() / 1000);
                    priceHistory += `**${formatCurrency(row.price)}** • <t:${timestamp}:R>\n`;
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
