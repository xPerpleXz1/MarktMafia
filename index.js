const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const { db, initializeDatabase } = require('./database');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// Bot Setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Chart Configuration
const width = 800;
const height = 400;
const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height });

// Bildverarbeitung-Konfiguration
const MAX_FILE_SIZE = (process.env.MAX_FILE_SIZE || 10) * 1024 * 1024; // MB to Bytes
const ALLOWED_FORMATS = (process.env.ALLOWED_FORMATS || 'jpg,jpeg,png,gif,webp').split(',');

// Hilfsfunktion für Geld-Formatierung
function formatCurrency(amount) {
    return new Intl.NumberFormat('de-DE', {
        style: 'currency',
        currency: 'EUR',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    }).format(amount);
}

// Bildverarbeitung
async function processImage(attachment) {
    try {
        // Validierung
        if (!attachment.contentType || !attachment.contentType.startsWith('image/')) {
            throw new Error('Datei ist kein Bild!');
        }

        const format = attachment.contentType.split('/')[1];
        if (!ALLOWED_FORMATS.includes(format)) {
            throw new Error(`Format nicht erlaubt! Erlaubt: ${ALLOWED_FORMATS.join(', ')}`);
        }

        if (attachment.size > MAX_FILE_SIZE) {
            throw new Error(`Datei zu groß! Maximum: ${MAX_FILE_SIZE / 1024 / 1024}MB`);
        }

        // Bild herunterladen
        const response = await fetch(attachment.url);
        const buffer = Buffer.from(await response.arrayBuffer());

        // Bild optimieren mit Sharp
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
            contentType: 'image/jpeg', // Konvertiere alles zu JPEG
            originalSize: attachment.size,
            processedSize: processedBuffer.length
        };

    } catch (error) {
        throw new Error(`Bildverarbeitung fehlgeschlagen: ${error.message}`);
    }
}

// Bot Events
client.once('ready', async () => {
    console.log(`🤖 Bot ist online als ${client.user.tag}!`);
    
    try {
        // Datenbank initialisieren
        await initializeDatabase();
        await db.testConnection();
        
        // Commands registrieren
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
                    .setAutocomplete(true))
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

// Add Price Handler
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

        // Bildverarbeitung falls vorhanden
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

        // Transaktion für Datenbankoperationen
        await db.transaction(async (client) => {
            // Zur Historie hinzufügen
            await client.query(`
                INSERT INTO price_history (item_name, display_name, market_price, state_value, image_data, image_filename, image_content_type, added_by) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `, [itemName, displayName, marketPrice, stateValue, imageData, imageFilename, imageContentType, userId]);

            // Bestehende Werte prüfen
            const existingRow = await client.query('SELECT * FROM current_prices WHERE item_name = $1', [itemName]);
            const existing = existingRow.rows[0];

            // Finale Werte bestimmen - behalte alte Werte wenn neue nicht angegeben
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

            // Aktuellen Preis aktualisieren oder hinzufügen
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

            // Erfolgsmeldung erstellen
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
            if (existing) {
                statusInfo = '🔄 Bestehender Eintrag aktualisiert';
                if (finalStateValue !== stateValue && stateValue === null) {
                    statusInfo += ' (Staatswert beibehalten)';
                }
                if (finalImageData !== imageData && !imageData && existing.image_data) {
                    statusInfo += ' (Bild beibehalten)';
                }
            }

            embed.addFields({ name: 'ℹ️ Status', value: statusInfo + processingInfo, inline: false });

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

            await interaction.followUp({ embeds: [embed] });
        });

    } catch (error) {
        console.error('Add Price Error:', error);
        await interaction.followUp(`❌ **Fehler beim Speichern:** ${error.message}`);
    }
}

// Show Price Handler
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

        // Bild als Thumbnail anzeigen falls vorhanden
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
            .setDescription(`**${rows.length} Artikel verfügbar**`)
            .setFooter({ text: 'GTA V Grand RP • Strandmarkt Bot' })
            .setTimestamp();

        // Erstelle schönere Anzeige in Spalten
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

// Price History Handler with Chart
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

        // Chart erstellen
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

            await interaction.followUp({ embeds: [embed], files: [attachment] });
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

        // Bild als Attachment erstellen
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

// Error Handling
process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
    process.exit(1);
});

// Health Check Endpoint für Railway
const PORT = process.env.PORT || 3000;
const http = require('http');

const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'healthy', 
            bot: client.isReady() ? 'online' : 'offline',
            uptime: process.uptime(),
            timestamp: new Date().toISOString()
        }));
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('GTA V Grand RP Strandmarkt Bot - Discord Bot läuft!');
    }
});

server.listen(PORT, () => {
    console.log(`🌐 Health Check Server läuft auf Port ${PORT}`);
});

// Login
client.login(process.env.DISCORD_TOKEN);
