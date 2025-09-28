// Average Price Handler
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
}const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
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
});

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
