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
                    .setRequired(true))
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
                    .setRequired(true)),

        new SlashCommandBuilder()
            .setName('alle-preise')
            .setDescription('Zeige alle aktuellen Strandmarktpreise'),

        new SlashCommandBuilder()
            .setName('preis-verlauf')
            .setDescription('Zeige den Preisverlauf eines Gegenstands mit Diagramm')
            .addStringOption(option =>
                option.setName('gegenstand')
                    .setDescription('Name des Gegenstands')
                    .setRequired(true)),

        new SlashCommandBuilder()
            .setName('durchschnittspreis')
            .setDescription('Zeige den Durchschnittspreis eines Gegenstands')
            .addStringOption(option =>
                option.setName('gegenstand')
                    .setDescription('Name des Gegenstands')
                    .setRequired(true))
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
    if (!interaction.isChatInputCommand()) return;

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
});

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
                .setTitle('✅ Preis aktualisiert!')
                .addFields(
                    { name: 'Gegenstand', value: itemName, inline: true },
                    { name: 'Preis', value: `${price}€`, inline: true },
                    { name: 'Aktualisiert von', value: userId, inline: true }
                )
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
                .setTitle(`💰 Aktueller Preis: ${row.item_name}`)
                .addFields(
                    { name: 'Preis', value: `${row.price}€`, inline: true },
                    { name: 'Zuletzt aktualisiert', value: new Date(row.last_updated).toLocaleString('de-DE'), inline: true },
                    { name: 'Aktualisiert von', value: row.updated_by, inline: true }
                )
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
                .setTimestamp();

            rows.forEach(row => {
                embed.addFields({
                    name: row.item_name,
                    value: `${row.price}€ (${new Date(row.last_updated).toLocaleDateString('de-DE')})`,
                    inline: true
                });
            });

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
                        borderColor: 'rgb(75, 192, 192)',
                        backgroundColor: 'rgba(75, 192, 192, 0.2)',
                        tension: 0.1
                    }]
                },
                options: {
                    responsive: true,
                    plugins: {
                        title: {
                            display: true,
                            text: `Preisverlauf: ${itemName}`
                        }
                    },
                    scales: {
                        y: {
                            beginAtZero: false,
                            title: {
                                display: true,
                                text: 'Preis (€)'
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
                    .setDescription(`**Anzahl Einträge:** ${rows.length}`)
                    .setImage('attachment://preisverlauf.png')
                    .setTimestamp();

                interaction.followUp({ embeds: [embed], files: [attachment] });
            } catch (chartError) {
                console.error('Chart Error:', chartError);
                
                // Fallback: Text-basierte Anzeige
                const embed = new EmbedBuilder()
                    .setColor('#ff6600')
                    .setTitle(`📈 Preisverlauf: ${itemName}`)
                    .setDescription('Diagramm konnte nicht erstellt werden. Hier die Daten:')
                    .setTimestamp();

                rows.forEach((row, index) => {
                    embed.addFields({
                        name: `Eintrag ${index + 1}`,
                        value: `${row.price}€ (${new Date(row.date_added).toLocaleString('de-DE')})`,
                        inline: true
                    });
                });

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
                .addFields(
                    { name: 'Durchschnittspreis', value: `${average.toFixed(2)}€`, inline: true },
                    { name: 'Niedrigster Preis', value: `${minPrice}€`, inline: true },
                    { name: 'Höchster Preis', value: `${maxPrice}€`, inline: true },
                    { name: 'Anzahl Einträge', value: `${rows.length}`, inline: true }
                )
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
